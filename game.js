class CribbageGame {
    constructor() {
        this.engine = new CribbageEngine(2);
        this.network = new GameNetwork();
        this.localPlayerIndex = -1;
        this.selectedCards = new Set();
        this.discardSelection = new Set();
        this.animationsEnabled = true;
        this.soundEnabled = true;
        this.gameLog = [];
        this.aiPlayers = new Map(); // playerIndex -> CribbageAI
        this.aiThinking = false;
        this.isSinglePlayer = false;
        this.scoreFeed = [];
        this.lastScoreEvent = null;
        this.lastFlashedKey = '';
        this.lastFeedToken = null;
        this.boardGeo = null;
        this.lastPegBefore = {};      // playerIndex -> score BEFORE its most recent scoring event
        this.lastRenderedPegs = {};   // playerIndex -> score at last board render (for pop anims)
        this.lastBoardRoundToken = null;
        
        this.setupNetworkListeners();
    }

    setupNetworkListeners() {
        this.network.on('connected', (data) => {
            this.updateConnectionStatus(true);
            this.loadTables();
        });

        this.network.on('disconnected', () => {
            this.updateConnectionStatus(false);
        });

        this.network.on('state', (state) => {
            this.handleStateUpdate(state);
        });

        this.network.on('tableList', (tables) => {
            this.renderTableList(tables);
        });

        this.network.on('chat', (chat) => {
            this.addLogEntry(`${chat.playerName}: ${chat.message}`, 'system');
        });
    }

    async init() {
        try {
            await this.network.connect();
            this.loadPlayerName();
            this.loadTables();
        } catch (e) {
            console.error('Failed to connect:', e);
            this.showModal('Connection Failed', 'Could not connect to game server. Playing in demo mode.', [
                { text: 'OK', action: () => this.hideModal() }
            ]);
        }
    }

    loadPlayerName() {
        const saved = localStorage.getItem('cribbage_player_name');
        if (saved) {
            document.getElementById('player-name').value = saved;
        }
    }

    savePlayerName(name) {
        localStorage.setItem('cribbage_player_name', name);
    }

    loadTables() {
        const tables = this.network.getTableList();
        this.renderTableList(tables);
    }

    renderTableList(tables) {
        const grid = document.getElementById('tables-grid');
        if (!tables || tables.length === 0) {
            grid.innerHTML = `
                <div class="table-card empty">
                    <div class="table-icon">🌴</div>
                    <p>No tables yet</p>
                    <button class="pixel-btn create-table-btn" id="create-table-btn">CREATE TABLE</button>
                </div>
            `;
            document.getElementById('create-table-btn').addEventListener('click', () => this.showCreateTableModal());
            return;
        }

        grid.innerHTML = tables.map(table => {
            const playerCount = table.players.length;
            const maxPlayers = table.mode === '1v1' ? 2 : 3;
            const isFull = playerCount >= maxPlayers;
            const isCurrentPlayer = table.players.some(p => p.id === this.network.playerId);
            
            return `
                <div class="table-card ${isFull ? 'full' : ''} ${isCurrentPlayer ? 'current' : ''}" data-table-id="${table.id}">
                    <div class="table-icon">${table.mode === '1v1' ? '🦒' : '🦏'}</div>
                    <h4>${table.mode === '1v1' ? 'HEAD-TO-HEAD' : 'LITE TRIO'}</h4>
                    <div class="table-meta">Table #${table.id.slice(-5).toUpperCase()}</div>
                    <div class="table-players">
                        ${Array.from({length: maxPlayers}, (_, i) => `
                            <div class="player-dot ${i < playerCount ? 'filled' : ''} ${isCurrentPlayer && table.players[i]?.id === this.network.playerId ? 'current' : ''}"></div>
                        `).join('')}
                    </div>
                    ${isFull ? '<div class="table-full">FULL</div>' : ''}
                </div>
            `;
        }).join('');

        // Add click handlers
        grid.querySelectorAll('.table-card:not(.empty):not(.full)').forEach(card => {
            card.addEventListener('click', () => this.joinTable(card.dataset.tableId));
        });
    }

    showCreateTableModal() {
        const mode = document.querySelector('.mode-card.selected')?.dataset.mode || '1v1';
        this.showModal('CREATE TABLE', `
            <p>Create a new ${mode === '1v1' ? 'Head-to-Head' : 'Lite Trio'} table?</p>
        `, [
            { text: 'CREATE', action: () => this.createTable(mode), class: 'primary' },
            { text: 'CANCEL', action: () => this.hideModal() }
        ]);
    }

    createTable(mode) {
        const name = document.getElementById('player-name').value.trim().toUpperCase();
        if (!name) {
            this.showModal('ERROR', 'Enter your name first!', [{ text: 'OK', action: () => this.hideModal() }]);
            return;
        }

        this.savePlayerName(name);
        
        // Check if we should add AI opponents (single player mode)
        const addAI = mode === '1v1' || mode === '3player';
        
        this.isSinglePlayer = addAI;
        if (addAI) {
            // Create local game with AI
            this.setupLocalGame(mode, name);
        } else {
            const result = this.network.createTable(mode, name);
            this.joinGame(result.tableId);
        }
        this.hideModal();
    }

    setupLocalGame(mode, playerName) {
        const playerCount = mode === '1v1' ? 2 : 3;
        this.engine = new CribbageEngine(playerCount);
        
        // Add human player
        this.engine.addPlayer(playerName, 'human_' + Date.now());
        
        // Add AI players
        const difficulties = ['medium', 'hard'];
        for (let i = 1; i < playerCount; i++) {
            const aiName = this.getAIName(i);
            const aiId = 'ai_' + i + '_' + Date.now();
            this.engine.addPlayer(aiName, aiId);
            this.aiPlayers.set(i, new CribbageAI(difficulties[(i-1) % difficulties.length]));
        }
        
        this.localPlayerIndex = 0;
        this.engine.setLocalPlayerIndex(0);
        this.engine.startGame();
        
        this.joinLocalGame();
    }

    getAIName(index) {
        const names = ['🦁 SIMBA', '🦓 ZARA', '🦏 KIFARU', '🐘 TEMBO', '🦒 TWIGA', '🐆 CHUI'];
        return names[(index - 1) % names.length];
    }

    joinLocalGame() {
        document.getElementById('landing-screen').classList.remove('active');
        document.getElementById('game-screen').classList.add('active');
        
        document.getElementById('table-id-display').textContent = 'LOCAL LITEcrib';
        document.getElementById('mode-badge').textContent = this.engine.playerCount === 2 ? '1v1' : '3P';
        document.getElementById('status-dot').classList.add('connected');
        document.getElementById('status-text').textContent = 'LOCAL GAME';
        
        const state = this.engine.getState(this.localPlayerIndex);
        this.renderGameState(state);
        
        this.addLogEntry('Welcome to the Savannah! 🦁', 'system');
        this.checkAITurn(state);
    }

    joinTable(tableId) {
        const name = document.getElementById('player-name').value.trim().toUpperCase();
        if (!name) {
            this.showModal('ERROR', 'Enter your name first!', [{ text: 'OK', action: () => this.hideModal() }]);
            return;
        }

        this.savePlayerName(name);
        const result = this.network.joinTable(tableId, name);
        if (result.success) {
            this.joinGame(tableId);
        } else {
            this.showModal('ERROR', result.error, [{ text: 'OK', action: () => this.hideModal() }]);
        }
    }

    joinGame(tableId) {
        this.tableId = tableId;
        document.getElementById('landing-screen').classList.remove('active');
        document.getElementById('game-screen').classList.add('active');
        
        document.getElementById('table-id-display').textContent = `TABLE #${tableId.slice(-5).toUpperCase()}`;
        
        const tableState = this.network.getTableState();
        if (tableState?.state) {
            this.handleStateUpdate(tableState.state);
        }
        
        this.addLogEntry('Joined the table!', 'system');
    }

    handleStateUpdate(state) {
        // Find our player index
        const playerIdx = state.players.findIndex(p => p.id === this.network.playerId);
        if (playerIdx !== -1) {
            this.localPlayerIndex = playerIdx;
            this.engine.setLocalPlayerIndex(playerIdx);
        }

        // Update engine state
        this.engine.phase = state.phase;
        this.engine.dealerIndex = state.dealerIndex;
        this.engine.currentPlayerIndex = state.currentPlayer;
        this.engine.scores = state.scores;
        this.engine.pegs = state.pegs;
        this.engine.crib = (state.crib || []).map(s => Card.fromString(s));
        this.engine.starter = state.starter ? Card.fromString(state.starter) : null;
        this.engine.playPile = (state.playPile || []).map(p => ({ card: Card.fromString(p.card), player: p.player }));
        this.engine.playCount = state.playCount;
        this.engine.hands = state.players.map((p, i) => 
            i === this.localPlayerIndex ? (state.hand || []).map(s => Card.fromString(s)) : []
        );

        this.renderGameState(state);
    }

    renderGameState(state) {
        // Update mode badge
        const mode = state.players.length === 2 ? '1v1' : '3P';
        document.getElementById('mode-badge').textContent = mode;

        // Update player scores on board
        this.renderCribBoard(state);

        // Update opponents
        this.renderOpponents(state);

        // Update center area
        this.renderCenterArea(state);

        // Update player hand
        this.renderPlayerHand(state);

        // Update actions
        this.renderActions(state);

        // Update phase indicator
        this.renderPhaseIndicator(state);

        // Update peg display
        this.renderPegDisplay(state);

        // Update play dashboard
        this.renderPlayDashboard(state);
    }

    buildBoardGeo() {
        const p = 13; // hole pitch
        const holes = [];
        const cur = { x: 20, y: 100 };
        const pushRun = (dx, dy, n) => {
            for (let i = 0; i < n; i++) {
                holes.push({ x: Math.round(cur.x * 10) / 10, y: Math.round(cur.y * 10) / 10 });
                cur.x += dx;
                cur.y += dy;
            }
        };
        pushRun(p, 0, 22);      //  1-22   "2" top bar
        pushRun(0, p, 5);       // 23-27   "2" right side
        pushRun(-p / Math.sqrt(2), p / Math.sqrt(2), 10); // 28-37  "2" diagonal
        pushRun(p, 0, 22);      // 38-59   "2" bottom bar
        pushRun(p, 0, 4);       // 60-63   connector into the "9"
        pushRun(0, -p, 10);     // 64-73   "9" left side (up)
        pushRun(p, 0, 22);      // 74-95   "9" top bar
        pushRun(0, p, 10);      // 96-105  "9" right side (down)
        pushRun(0, p, 15);      // 106-120 "9" tail
        const game = { x: Math.round(cur.x * 10) / 10, y: Math.round(cur.y * 10) / 10 };
        return { holes, game, p, r: 6.4 };
    }

    pegPosition(score, geo) {
        const pos = Math.max(1, Math.min(score, 121));
        if (pos === 121) return geo.game;
        return geo.holes[pos - 1];
    }

    renderCribBoard(state) {
        const track = document.getElementById('board-track');
        if (!track) return;
        const geo = this.boardGeo || (this.boardGeo = this.buildBoardGeo());
        const PEG_STYLES = [
            { fill: '#d4a843', edge: '#8a6a1f' },
            { fill: '#2e5c8a', edge: '#16334f' },
            { fill: '#a83232', edge: '#5e1616' }
        ];

        let svg = '';
        svg += '<defs>' +
            '<linearGradient id="woodGrad" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#DCBC8F"/><stop offset="1" stop-color="#BE9A6B"/>' +
            '</linearGradient>' +
            '<linearGradient id="brassGrad" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#F5DB8B"/><stop offset="1" stop-color="#C9A33E"/>' +
            '</linearGradient>' +
            '</defs>';

        // Board base (wood plank)
        svg += '<rect x="4" y="4" width="852" height="512" rx="20" fill="url(#woodGrad)" stroke="#3E2C16" stroke-width="3"/>';
        for (let y = 90; y < 512; y += 60) {
            svg += `<line x1="20" y1="${y}" x2="840" y2="${y}" stroke="#AE8858" stroke-width="1" opacity="0.5"/>`;
        }
        svg += `<line x1="20" y1="96" x2="840" y2="96" stroke="#8A6A3F" stroke-width="2" opacity="0.6"/>`;

        // Brass 29 plate
        svg += `<rect x="336" y="28" width="188" height="52" rx="8" fill="url(#brassGrad)" stroke="#8A6A1F" stroke-width="2"/>
            <text x="430" y="50" text-anchor="middle" class="board-emblem">29</text>
            <text x="430" y="72" text-anchor="middle" class="board-caption">CRIBBAGE</text>`;

        // Holes 1-120 shaped as the numeral 29
        for (let i = 0; i < geo.holes.length; i++) {
            const pos = i + 1;
            let cls = 'board-hole';
            if (pos % 5 === 0) cls += ' hole-5';
            if (pos % 10 === 0) cls += ' hole-10';
            if (pos === 90) cls += ' hole-skunk';
            svg += `<circle cx="${geo.holes[i].x}" cy="${geo.holes[i].y}" r="${geo.r}" class="${cls}" data-hole="${pos}"/>`;
        }
        // Game hole 121
        svg += `<circle cx="${geo.game.x}" cy="${geo.game.y}" r="${geo.r + 1.6}" class="board-hole game-hole" data-hole="121"/>`;

        // Markers + numbers
        for (let i = 9; i < geo.holes.length; i += 10) {
            const h = geo.holes[i];
            svg += `<text x="${h.x}" y="${h.y + 15}" text-anchor="middle" class="board-label">${i + 1}</text>`;
        }
        svg += `<text x="40" y="84" text-anchor="start" class="board-start">START</text>`;
        svg += `<text x="${geo.game.x}" y="${geo.game.y + 30}" text-anchor="middle" class="board-win">121 WIN</text>`;
        const skunkHole = geo.holes[89];
        svg += `<text x="${skunkHole.x}" y="${skunkHole.y - 12}" text-anchor="middle" class="board-skunk">SKUNK</text>`;

        // Peg audit trail. True cribbage semantics: the back (hollow) peg
        // always marks where the front peg JUST sat, so the gap between the
        // two is exactly the points the current scoring run just earned.
        // Back pegs reset to "stacked" (hidden) at every new round.
        const roundToken = (state.roundStart || []).join('|');
        if (this.lastBoardRoundToken !== roundToken) {
            this.lastBoardRoundToken = roundToken;
            this.lastPegBefore = {};
            this.lastRenderedPegs = {};
        }
        const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        const prevPegs = this.lastRenderedPegs || {};

        // Trail ribbons: the exact holes a peg travelled (back -> front),
        // stroked in the player's colour. Fresh trails draw themselves on.
        state.players.forEach((player, idx) => {
            const style = PEG_STYLES[idx % PEG_STYLES.length];
            const backScore = this.lastPegBefore[idx];
            if (backScore == null) return;
            const back = this.pegPosition(backScore, geo);
            const front = this.pegPosition(player.score, geo);
            if (back.x === front.x && back.y === front.y) return;

            let d = `M ${back.x} ${back.y}`;
            let len = 0;
            const lo = Math.max(1, Math.min(backScore, 121));
            const hi = Math.max(1, Math.min(player.score, 121));
            for (let h = lo + 1; h <= hi; h++) {
                const c = h <= 120 ? geo.holes[h - 1] : geo.game;
                d += ` L ${c.x} ${c.y}`;
                len += Math.hypot(c.x - back.x, c.y - back.y);
            }
            len = Math.max(1, Math.round(len));
            const fresh = !reduceMotion && prevPegs[idx] != null && prevPegs[idx] !== player.score;
            const dash = fresh
                ? `stroke-dasharray:${len} ${len};stroke-dashoffset:${len};animation:trailDraw .5s ease-out forwards`
                : `stroke-dasharray:${len} ${len};stroke-dashoffset:0`;
            const my = idx === this.localPlayerIndex ? 'my' : 'them';
            svg += `<path class="peg-trail ${my}" d="${d}" style="${dash}" stroke="${style.fill}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity="0.16"/>`;
            svg += `<path class="peg-trail ${my} trail-core" d="${d}" style="${dash}" stroke="${style.fill}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
        });

        // Pegs: front (solid bead) = current score; back (hollow ring) = where
        // the peg last sat. A "+N" chip is the audit readout of the distance.
        state.players.forEach((player, idx) => {
            const style = PEG_STYLES[idx % PEG_STYLES.length];
            const backScore = this.lastPegBefore[idx];
            const back = backScore != null ? this.pegPosition(backScore, geo) : null;
            const front = this.pegPosition(player.score, geo);
            const moved = !reduceMotion && prevPegs[idx] != null && prevPegs[idx] !== player.score;

            if (back && (back.x !== front.x || back.y !== front.y)) {
                svg += `<g class="peg peg-back k${idx}"><rect x="${back.x - 2.2}" y="${back.y - 11.5}" width="4.4" height="11.5" rx="1.6" fill="${style.fill}" opacity="0.55" stroke="${style.edge}" stroke-width="1"/><circle cx="${back.x}" cy="${back.y}" r="7.2" fill="none" stroke="${style.fill}" stroke-width="1.6" opacity="0.85"/></g>`;
            }

            svg += `<g class="peg peg-front k${idx}${moved ? ' peg-pop' : ''}">` +
                `<circle cx="${front.x}" cy="${front.y}" r="10.5" fill="${style.fill}" opacity="0.22"/>` +
                `<rect x="${front.x - 3.4}" y="${front.y - 15}" width="6.8" height="15" rx="2.2" fill="${style.fill}" stroke="${style.edge}" stroke-width="1.2"/>` +
                `<circle cx="${front.x}" cy="${front.y}" r="7.2" fill="${style.fill}" stroke="${style.edge}" stroke-width="1.2"/>` +
                `<circle cx="${front.x - 1.7}" cy="${front.y - 2}" r="2" fill="#FFF7E0" opacity="0.4"/>` +
                `</g>`;

            if (back && (back.x !== front.x || back.y !== front.y)) {
                const gain = Math.max(1, Math.min(player.score, 121) - Math.min(backScore, 121));
                svg += `<g class="peg-chip${moved ? ' chip-pop' : ''}"><rect x="${front.x + 14}" y="${front.y - 27}" width="34" height="16" rx="3.5"/><text x="${front.x + 31}" y="${front.y - 15.5}" text-anchor="middle">+${gain}</text></g>`;
            }
        });

        // Breathing beacon on the hole your front peg just landed on
        const local = state.players[this.localPlayerIndex];
        if (local) {
            const fp = this.pegPosition(local.score, geo);
            svg += `<circle class="hole-pulse" cx="${fp.x}" cy="${fp.y}" r="9"/>`;
        }

        this.lastRenderedPegs = {};
        state.players.forEach((p, i) => { this.lastRenderedPegs[i] = p.score; });

        track.innerHTML = svg;

        // Player score entries
        const scoreContainer = document.getElementById('player-scores');
        scoreContainer.innerHTML = state.players.map((player, idx) => `
            <div class="player-score-entry ${idx === state.currentPlayer ? 'current' : ''}">
                <span class="name">${this.escapeHtml(player.name)}</span>
                <span class="score">${player.score}</span>
            </div>
        `).join('');
    }

    renderOpponents(state) {
        const area = document.getElementById('opponents-area');
        const opponents = state.players.filter((_, i) => i !== this.localPlayerIndex);
        
        area.innerHTML = opponents.map((player, idx) => {
            const actualIdx = state.players.findIndex(p => p.id === player.id);
            const isDealer = actualIdx === state.dealerIndex;
            const isCurrent = actualIdx === state.currentPlayer && state.phase === 'PLAY';
            
            return `
                <div class="opponent-panel ${isCurrent ? 'current-turn' : ''} ${isDealer ? 'dealer' : ''}" data-player="${actualIdx}">
                    <div class="opponent-name">${this.escapeHtml(player.name)}</div>
                    <div class="opponent-cards">
                        ${Array.from({length: player.handSize}, (_, i) => `
                            <div class="opponent-card-back">🂠</div>
                        `).join('')}
                    </div>
                    <div class="opponent-score">SCORE: ${player.score}</div>
                    <div class="opponent-pegs">📍 ${player.score}</div>
                </div>
            `;
        }).join('');
    }

    renderCenterArea(state) {
        // Dealer
        const dealer = state.players[state.dealerIndex];
        document.getElementById('dealer-name').textContent = dealer?.name || '--';
        document.getElementById('dealer-chip').style.display = state.phase !== 'WAITING' ? 'flex' : 'none';

        // Crib
        const cribCards = document.getElementById('crib-cards');
        if (state.phase === 'DISCARD' || state.phase === 'STARTER' || state.phase === 'PLAY') {
            cribCards.innerHTML = state.crib.map((cardStr, i) => `
                <div class="crib-card face-down" data-index="${i}">🂠</div>
            `).join('');
        } else if (state.phase === 'COUNT_CRIB' || state.phase === 'GAME_OVER') {
            cribCards.innerHTML = state.crib.map((cardStr, i) => `
                <div class="crib-card" data-index="${i}">${this.renderCardHtml(Card.fromString(cardStr))}</div>
            `).join('');
        } else {
            cribCards.innerHTML = '<div class="crib-card empty">🂠</div><div class="crib-card empty">🂠</div>';
        }
        document.getElementById('crib-count').textContent = state.cribCount || 0;

        // Starter — stays face-down while the crib is still being picked. The
        // engine cuts the starter at deal, but rules-wise it is only revealed
        // AFTER everyone discards to the cribestr (turn-up phase and beyond).
        // Re-show the face each render is fine; the gating below decides when.
        const starterRevealedPhases = ['STARTER', 'PLAY', 'COUNT_HAND', 'COUNT_CRIB', 'GAME_OVER'];
        const starterEl = document.getElementById('starter-card');
        if (state.starter && starterRevealedPhases.includes(state.phase)) {
            const card = Card.fromString(state.starter);
            starterEl.className = `starter-card ${card.color}`;
            starterEl.innerHTML = `
                <span class="starter-rank">${card.rank}</span>
                <span class="starter-suit">${card.suit}</span>
            `;
        } else {
            // Face-down until the crib is picked (DISCARD / DEALING / WAITING).
            starterEl.className = 'starter-card empty';
            starterEl.textContent = '?';
        }
    }

    renderCardHtml(card) {
        return `
            <span class="card-rank">${card.rank}</span>
            <span class="card-suit">${card.suit}</span>
            <span class="card-mini-rank">${card.rank}</span>
            <span class="card-mini-suit">${card.suit}</span>
        `;
    }

    renderPlayerHand(state) {
        const hand = state.hand || [];
        const container = document.getElementById('hand-cards');
        
        container.innerHTML = hand.map((cardStr, idx) => {
            const card = Card.fromString(cardStr);
            const isSelected = this.selectedCards.has(idx);
            const isDiscardSelected = this.discardSelection.has(idx);
            const disabled = (state.phase === 'PLAY' && (!state.canPlay || state.playCount + card.value > 31)) ||
                           (state.phase === 'DISCARD' && !state.canDiscard);
            
            return `
                <div class="card ${card.color} ${isSelected ? 'selected' : ''} ${isDiscardSelected ? 'discard-selected' : ''} ${disabled ? 'disabled' : ''}" 
                     data-index="${idx}" 
                     data-card="${cardStr}"
                     style="pointer-events: auto;">
                    ${this.renderCardHtml(card)}
                </div>
            `;
        }).join('');

        // Use event delegation on container for more reliable clicking
        container.onclick = (e) => {
            const cardEl = e.target.closest('.card');
            if (cardEl && container.contains(cardEl)) {
                this.onCardClick(cardEl);
            }
        };

        // Update the turn status bar on screen
        this.renderTurnStatus(state);
    }

    renderTurnStatus(state) {
        const bar = document.getElementById('turn-status');
        if (!bar) return;
        
        if (state.phase === 'DISCARD') {
            if (state.canDiscard) {
                const remaining = state.discardCount - this.discardSelection.size;
                bar.textContent = remaining > 0 
                    ? `YOUR TURN — SELECT ${remaining > 1 ? remaining + ' CARDS' : '1 CARD'} FOR CRIB`
                    : 'CLICK "DISCARD TO CRIB" TO CONTINUE';
                bar.className = 'turn-status yours';
            } else {
                bar.textContent = `${state.players[state.currentPlayer]?.name || 'OPPONENT'} IS DISCARDING...`;
                bar.className = 'turn-status waiting';
            }
        } else if (state.phase === 'PLAY') {
            if (state.canPlay) {
                bar.textContent = `YOUR TURN — CLICK A CARD TO PLAY (COUNT ${state.playCount}/31)`;
                bar.className = 'turn-status yours';
            } else {
                bar.textContent = `${state.players[state.currentPlayer]?.name || 'OPPONENT'} IS PLAYING — WAIT (COUNT ${state.playCount}/31)`;
                bar.className = 'turn-status waiting';
            }
        } else if (state.phase === 'COUNT_HAND' || state.phase === 'COUNT_CRIB') {
            if (state.currentPlayer === this.localPlayerIndex) {
                const actionLabel = state.phase === 'COUNT_CRIB' ? 'COUNT CRIB' : 'COUNT HAND';
                bar.textContent = `YOUR TURN — CLICK "${actionLabel}"`;
                bar.className = 'turn-status yours';
            } else {
                bar.textContent = `${state.players[state.currentPlayer]?.name || 'OPPONENT'} IS COUNTING...`;
                bar.className = 'turn-status waiting';
            }
        } else {
            bar.textContent = state.phase === 'GAME_OVER' ? 'GAME OVER' : (state.phase || '');
            bar.className = 'turn-status';
        }
    }

    onCardClick(cardEl) {
        // Read current state from engine at click time
        const state = this.engine.getState(this.localPlayerIndex);
        const idx = parseInt(cardEl.dataset.index);
        const cardStr = cardEl.dataset.card;
        
        if (state.phase === 'DISCARD' && state.canDiscard) {
            // Toggle discard selection
            if (this.discardSelection.has(idx)) {
                this.discardSelection.delete(idx);
                cardEl.classList.remove('discard-selected');
            } else {
                if (this.discardSelection.size < state.discardCount) {
                    this.discardSelection.add(idx);
                    cardEl.classList.add('discard-selected');
                }
            }
            this.updateDiscardButton(state);
            this.renderTurnStatus(state);
        } else if (state.phase === 'PLAY' && state.canPlay) {
            // Play card
            this.playCard(idx);
        } else if (state.phase === 'COUNT_HAND' || state.phase === 'COUNT_CRIB') {
            // Toggle selection for counting (visual only)
            if (this.selectedCards.has(idx)) {
                this.selectedCards.delete(idx);
                cardEl.classList.remove('selected');
            } else {
                this.selectedCards.add(idx);
                cardEl.classList.add('selected');
            }
        }
    }

    updateDiscardButton(state) {
        if (!state) state = this.engine.getState(this.localPlayerIndex);
        const ready = this.discardSelection.size === state.discardCount;
        const inlineBtn = document.getElementById('discard-btn');
        const modalBtn = document.getElementById('confirm-discard');
        const countEl = document.getElementById('discard-count');
        const preview = document.getElementById('discard-preview');
        
        if (inlineBtn) inlineBtn.disabled = !ready;
        if (modalBtn) modalBtn.disabled = !ready;
        if (countEl) countEl.textContent = state.discardCount - this.discardSelection.size;
        
        if (preview) {
            preview.innerHTML = Array.from(this.discardSelection).map(idx => {
                const card = Card.fromString(state.hand[idx]);
                return `<div class="card ${card.color}">${this.renderCardHtml(card)}</div>`;
            }).join('');
        }
    }

    renderActions(state) {
        const discardBtn = document.getElementById('discard-btn');
        const playBtn = document.getElementById('play-btn');
        const goBtn = document.getElementById('go-btn');
        const countBtn = document.getElementById('count-btn');
        const actionsBar = document.getElementById('hand-actions');

        // Hide all by default
        [discardBtn, playBtn, goBtn, countBtn].forEach(btn => {
            if (btn) btn.style.display = 'none';
        });
        if (actionsBar) actionsBar.classList.remove('has-action');

        let anyVisible = false;
        const show = (btn) => {
            if (!btn) return;
            btn.style.display = 'inline-block';
            anyVisible = true;
        };

        if (state.phase === 'DISCARD' && state.canDiscard) {
            show(discardBtn);
            discardBtn.disabled = this.discardSelection.size !== state.discardCount;
        } else if (state.phase === 'PLAY' && state.canPlay) {
            show(playBtn);
            show(goBtn);
            
            const hand = state.hand || [];
            const canPlayAny = hand.some((cardStr, i) => {
                const card = Card.fromString(cardStr);
                return state.playCount + card.value <= 31;
            });
            
            playBtn.disabled = !canPlayAny;
            goBtn.disabled = canPlayAny;
        } else if (state.phase === 'COUNT_HAND' && state.currentPlayer === this.localPlayerIndex) {
            show(countBtn);
            countBtn.disabled = false;
            countBtn.textContent = 'COUNT HAND';
        } else if (state.phase === 'COUNT_CRIB' && state.currentPlayer === this.localPlayerIndex) {
            show(countBtn);
            countBtn.disabled = false;
            countBtn.textContent = 'COUNT CRIB';
        }

        if (anyVisible && actionsBar) actionsBar.classList.add('has-action');
    }

    renderPhaseIndicator(state) {
        const indicator = document.getElementById('phase-indicator');
        const label = document.getElementById('phase-label');
        const sub = document.getElementById('phase-sub');

        const phaseLabels = {
            'WAITING': 'WAITING FOR PLAYERS',
            'DEALING': 'DEALING CARDS',
            'DISCARD': 'DISCARD TO CRIB',
            'STARTER': 'STARTER CARD',
            'PLAY': 'PLAY PHASE',
            'COUNT_HAND': 'COUNTING HANDS',
            'COUNT_CRIB': 'COUNTING CRIB',
            'GAME_OVER': 'GAME OVER'
        };

        label.textContent = phaseLabels[state.phase] || state.phase;

        if (state.phase === 'PLAY') {
            sub.textContent = `COUNT: ${state.playCount} | ${state.players[state.currentPlayer]?.name}'S TURN`;
            indicator.style.display = 'block';
        } else if (state.phase === 'DISCARD') {
            sub.textContent = `${state.players[state.currentPlayer]?.name} DISCARDING`;
            indicator.style.display = 'block';
        } else if (state.phase === 'COUNT_HAND' || state.phase === 'COUNT_CRIB') {
            sub.textContent = `${state.players[state.currentPlayer]?.name} COUNTING`;
            indicator.style.display = 'block';
        } else if (state.phase === 'GAME_OVER') {
            const winner = state.players[state.winner];
            sub.textContent = `${winner?.name} WINS! 🏆`;
            indicator.style.display = 'block';
        } else {
            indicator.style.display = 'none';
        }
    }

    renderPegDisplay(state) {
        const player = state.players[this.localPlayerIndex];
        if (player) {
            const backScore = (this.lastPegBefore && this.lastPegBefore[this.localPlayerIndex] != null)
                ? this.lastPegBefore[this.localPlayerIndex] : player.score;
            document.getElementById('peg-front').textContent = player.score;
            document.getElementById('peg-back').textContent = backScore;
        }
    }

    recordScoreEvent(state, playerIndex, points, reason) {
        if (!points || points <= 0) return;
        const name = state.players[playerIndex]?.name || 'PLAYER';
        // Back peg = where the front peg sat right before this event landed.
        this.lastPegBefore[playerIndex] = Math.max(0, state.scores[playerIndex] - points);
        this.lastScoreEvent = {
            playerIndex,
            name,
            points,
            reason: reason || `${points} pt${points > 1 ? 's' : ''}`,
            ts: Date.now()
        };
        this.scoreFeed.push(this.lastScoreEvent);
        if (this.scoreFeed.length > 40) this.scoreFeed.shift();
    }

    renderPlayDashboard(state) {
        const dash = document.getElementById('play-dashboard');
        if (!dash) return;
        const active = ['PLAY', 'COUNT_HAND', 'COUNT_CRIB', 'GAME_OVER'].includes(state.phase);
        dash.hidden = !active;
        if (!active) return;

        const token = (state.roundStart || []).join('|');
        if (this.lastFeedToken !== token) {
            this.lastFeedToken = token;
            this.scoreFeed = [];
            this.lastScoreEvent = null;
        }

        // Running count + turn
        document.getElementById('pd-count-val').textContent = state.playCount || 0;
        document.getElementById('pd-count-total').textContent = '/31';
        const turnEl = document.getElementById('pd-turn');
        turnEl.textContent = state.players[state.currentPlayer]?.name || '—';
        turnEl.className = 'pd-turn-num ' + (state.currentPlayer === this.localPlayerIndex ? 'you' : 'them');

        // Play pile
        const pileEl = document.getElementById('pd-pile-cards');
        if (state.playPile && state.playPile.length) {
            pileEl.innerHTML = state.playPile.map(p => {
                const card = Card.fromString(p.card);
                const mine = p.player === this.localPlayerIndex;
                return `<div class="pd-card ${card.color} ${mine ? 'mine' : 'theirs'}">
                    <span class="pd-card-rank">${card.rank}</span>
                    <span class="pd-card-suit">${card.suit}</span>
                </div>`;
            }).join('');
        } else {
            pileEl.innerHTML = '<span class="pd-empty">— new count —</span>';
        }

        // Last score (flash on change)
        const lastEl = document.getElementById('pd-last');
        if (this.lastScoreEvent) {
            const e = this.lastScoreEvent;
            const key = e.playerIndex + '|' + e.points + '|' + (e.reason || '') + '|' + e.ts;
            lastEl.innerHTML = `<span class="pd-pts">+${e.points}</span>
                <span class="pd-desc">${this.escapeHtml(e.reason || '')}</span>
                <span class="pd-who">${this.escapeHtml(e.name)}</span>`;
            if (key !== this.lastFlashedKey) {
                this.lastFlashedKey = key;
                lastEl.classList.remove('pd-flash');
                void lastEl.offsetWidth;
                lastEl.classList.add('pd-flash');
            }
        } else {
            lastEl.textContent = '—';
        }

        // Feed
        const feedEl = document.getElementById('pd-feed');
        const recent = this.scoreFeed.slice(-6).reverse();
        feedEl.innerHTML = recent.map(e => `
            <div class="pd-feed-item">
                <span class="pd-feed-pts ${e.playerIndex === this.localPlayerIndex ? 'mine' : 'theirs'}">+${e.points}</span>
                <span class="pd-feed-desc">${this.escapeHtml(e.reason || '')}</span>
                <span class="pd-feed-who">${this.escapeHtml(e.name)}</span>
            </div>
        `).join('') || '<div class="pd-feed-none">no points yet this round</div>';

        // Scores
        const scoresEl = document.getElementById('pd-scores');
        scoresEl.innerHTML = state.players.map((p, i) => `
            <div class="pd-score ${i === state.currentPlayer ? 'current' : ''} ${i === this.localPlayerIndex ? 'mine' : 'theirs'}">
                <span class="pd-score-name">${this.escapeHtml(p.name)}</span>
                <span class="pd-score-num">${p.score}</span>
            </div>
        `).join('');
    }

    async discardToCrib() {
        const cardIndices = Array.from(this.discardSelection).sort((a, b) => b - a);
        const result = this.engine.discardToCrib(this.localPlayerIndex, cardIndices);
        
        if (result.success) {
            this.discardSelection.clear();
            this.selectedCards.clear();
            this.hideDiscardModal();
            this.broadcastState();
            this.addLogEntry(`You discarded ${cardIndices.length} card(s) to the crib`, 'action');
        } else {
            this.showModal('ERROR', result.error, [{ text: 'OK', action: () => this.hideModal() }]);
        }
    }

    async playBestCard() {
        const state = this.engine.getState(this.localPlayerIndex);
        if (state.phase !== 'PLAY' || !state.canPlay) return;

        const hand = state.hand || [];
        // Find the highest-value card that keeps the running count <= 31
        let bestIdx = -1;
        hand.forEach((cardStr, i) => {
            const card = Card.fromString(cardStr);
            if (state.playCount + card.value <= 31) {
                if (bestIdx === -1 || card.value > Card.fromString(hand[bestIdx]).value) {
                    bestIdx = i;
                }
            }
        });

        if (bestIdx !== -1 && hand[bestIdx]) {
            await this.playCard(bestIdx);
        }
    }

    async playCard(cardIndex) {
        const handArr = this.engine.hands[this.localPlayerIndex] || [];
        const playedCard = handArr[cardIndex] ? handArr[cardIndex].toString() : '';
        const before = [...this.engine.scores];
        const result = this.engine.playCard(this.localPlayerIndex, cardIndex);
        
        if (result.success) {
            this.selectedCards.clear();

            // Record score events BEFORE broadcasting so the dashboard
            // shows this play's points on the very same render.
            const state = this.engine.getState(this.localPlayerIndex);
            const delta = this.engine.scores[this.localPlayerIndex] - before[this.localPlayerIndex];
            if (delta > 0) {
                let reason = result.scoreResult?.points > 0 ? result.scoreResult.reasons.join('; ') : '';
                const extra = delta - (result.scoreResult?.points || 0);
                if (extra > 0) {
                    reason = (reason ? reason + '; ' : '') + (result.playCount === 31 ? '31 for 2' : 'GO');
                }
                this.recordScoreEvent(state, this.localPlayerIndex, delta, reason);
            }

            this.broadcastState();

            this.addLogEntry(`You played ${playedCard} (count: ${result.playCount})`, 'action');
            
            if (result.scoreResult?.points > 0) {
                this.addLogEntry(`Scored ${result.scoreResult.points}: ${result.scoreResult.reasons.join(', ')}`, 'score');
            }
            
            if (result.go) {
                this.addLogEntry('GO!', 'score');
            }
        } else {
            this.showModal('ILLEGAL PLAY', result.error, [{ text: 'OK', action: () => this.hideModal() }]);
        }
    }

    async sayGo() {
        const before = [...this.engine.scores];
        const result = this.engine.sayGo(this.localPlayerIndex);
        
        if (result.success) {
            this.engine.scores.forEach((s, i) => {
                const d = s - before[i];
                if (d > 0) this.recordScoreEvent(this.engine.getState(this.localPlayerIndex), i, d, 'GO');
            });
            this.broadcastState();
            this.addLogEntry('You said GO', 'action');
        } else {
            this.showModal('CANNOT GO', result.error, [{ text: 'OK', action: () => this.hideModal() }]);
        }
    }

    async countHand() {
        if (this.engine.phase === 'COUNT_HAND' || this.engine.phase === 'COUNT_CRIB') {
            const r = this.engine.proceedToNextCount();
            const state = this.engine.getState(this.localPlayerIndex);
            if (r.handResult) {
                const who = this.engine.players[r.handPlayer].name;
                const desc = r.handResult.breakdown.length ? r.handResult.breakdown.join('; ') : 'no points';
                this.addLogEntry(`${who} counted hand: ${desc} (${r.handResult.points} pts)`, 'score');
                this.recordScoreEvent(state, r.handPlayer, r.handResult.points,
                    r.handResult.breakdown.length ? r.handResult.breakdown.join('; ') : `${r.handResult.points} pts`);
            }
            if (r.dealerResult) {
                const who = this.engine.players[r.dealerPlayer].name;
                const desc = r.dealerResult.breakdown.length ? r.dealerResult.breakdown.join('; ') : 'no points';
                this.addLogEntry(`${who} counted hand: ${desc} (${r.dealerResult.points} pts)`, 'score');
                this.recordScoreEvent(state, r.dealerPlayer, r.dealerResult.points,
                    r.dealerResult.breakdown.length ? r.dealerResult.breakdown.join('; ') : `${r.dealerResult.points} pts`);
            }
            if (r.cribResult) {
                const desc = r.cribResult.breakdown.length ? r.cribResult.breakdown.join('; ') : 'no points';
                this.addLogEntry(`Crib counted: ${desc} (${r.cribResult.points} pts)`, 'score');
                this.recordScoreEvent(state, this.engine.dealerIndex, r.cribResult.points,
                    r.cribResult.breakdown.length ? 'CRIB: ' + r.cribResult.breakdown.join('; ') : 'no crib points');
            }
        }
        
        this.broadcastState();
    }

    broadcastState() {
        const state = this.engine.getState(this.localPlayerIndex);
        if (this.isSinglePlayer) {
            // Single-player: the engine is the single source of truth. Do NOT
            // run handleStateUpdate here — it wipes non-local hands to [] and
            // deadlocks the AI. Auto-advance STARTER -> PLAY, then re-render.
            this.autoAdvancePhase();
            const fresh = this.engine.getState(this.localPlayerIndex);
            this.renderGameState(fresh);
            this.checkAITurn(fresh);
        } else {
            this.network.broadcastState(state);
        }
    }

    autoAdvancePhase() {
        if (this.engine.phase === 'STARTER') {
            this.engine.startPlayPhase();
        }
    }

checkAITurn(state) {
        if (!this.isSinglePlayer) return;
        if (this.aiThinking) return;
        if (state.phase === 'GAME_OVER') return;

        const currentPlayer = state.currentPlayer;
        
        if (this.aiPlayers.has(currentPlayer)) {
            this.aiThinking = true;
            const delay = 800 + Math.random() * 1200;
            setTimeout(() => this.makeAIMove(currentPlayer, state), delay);
        }
    }

    async makeAIMove(aiIndex, state) {
        const ai = this.aiPlayers.get(aiIndex);
        if (!ai) {
            this.aiThinking = false;
            return;
        }

        const aiName = state.players[aiIndex]?.name || 'AI';
        const hand = this.engine.hands[aiIndex] || [];

        try {
            if (state.phase === 'DISCARD') {
                await this.aiDiscard(ai, aiIndex, aiName, hand, state);
            } else if (state.phase === 'PLAY') {
                await this.aiPlay(ai, aiIndex, aiName, hand, state);
            } else if (state.phase === 'COUNT_HAND' || state.phase === 'COUNT_CRIB') {
                await this.aiCount(ai, aiIndex, aiName, state);
            }
        } catch (e) {
            console.error('AI error:', e);
        }

        this.aiThinking = false;
        this.autoAdvancePhase();
        const newState = this.engine.getState(this.localPlayerIndex);
        this.renderGameState(newState);
        this.checkAITurn(newState);
    }

    async aiDiscard(ai, aiIndex, aiName, hand, state) {
        const isDealer = aiIndex === this.engine.dealerIndex;
        const discardCount = state.discardCount;
        const discardIndices = ai.chooseDiscard(hand, isDealer, this.engine.starter, this.engine.playerCount);
        
        // Capture the discarded card strings BEFORE the engine splices them out
        const discardedCards = discardIndices
            .filter(i => i >= 0 && i < hand.length)
            .map(i => hand[i].toString())
            .join(', ');
        
        const result = this.engine.discardToCrib(aiIndex, discardIndices.sort((a, b) => b - a));
        
        if (result.success) {
            this.addLogEntry(`${aiName} discarded ${discardCount} card(s) to the crib`, 'action');
        }
    }

    async aiPlay(ai, aiIndex, aiName, hand, state) {
        if (ai.shouldSayGo(hand, state.playCount)) {
            const before = [...this.engine.scores];
            const result = this.engine.sayGo(aiIndex);
            if (result.success) {
                this.engine.scores.forEach((s, i) => {
                    const d = s - before[i];
                    if (d > 0) this.recordScoreEvent(this.engine.getState(this.localPlayerIndex), i, d, 'GO');
                });
                this.addLogEntry(`${aiName} says GO`, 'action');
            }
            return;
        }

        const cardIndex = ai.choosePlayCard(hand, state.playCount, this.engine.playPile);
        if (cardIndex === -1) {
            // Should not happen if shouldSayGo returned false, but fallback
            const result = this.engine.sayGo(aiIndex);
            if (result.success) this.addLogEntry(`${aiName} says GO`, 'action');
            return;
        }

        // Capture before the engine splices the card out of the hand
        const playedCard = hand[cardIndex] ? hand[cardIndex].toString() : '';
        const before = [...this.engine.scores];
        const result = this.engine.playCard(aiIndex, cardIndex);
        if (result.success) {
            this.addLogEntry(`${aiName} played ${playedCard} (count: ${result.playCount})`, 'action');
            if (result.scoreResult?.points > 0) {
                this.addLogEntry(`${aiName} scored ${result.scoreResult.points}: ${result.scoreResult.reasons.join(', ')}`, 'score');
            }
            if (result.go) {
                this.addLogEntry('GO!', 'score');
            }

            // Record score events for the dashboard
            const state = this.engine.getState(this.localPlayerIndex);
            const delta = this.engine.scores[aiIndex] - before[aiIndex];
            if (delta > 0) {
                let reason = result.scoreResult?.points > 0 ? result.scoreResult.reasons.join('; ') : '';
                const extra = delta - (result.scoreResult?.points || 0);
                if (extra > 0) {
                    reason = (reason ? reason + '; ' : '') + (result.playCount === 31 ? '31 for 2' : 'GO');
                }
                this.recordScoreEvent(state, aiIndex, delta, reason);
            }
        }
    }

    async aiCount(ai, aiIndex, aiName, state) {
        if (state.phase === 'COUNT_HAND' || state.phase === 'COUNT_CRIB') {
            const r = this.engine.proceedToNextCount();
            const fresh = this.engine.getState(this.localPlayerIndex);
            if (r.handResult) {
                const who = this.engine.players[r.handPlayer].name;
                const desc = r.handResult.breakdown.length ? r.handResult.breakdown.join('; ') : 'no points';
                this.addLogEntry(`${who} counted hand: ${desc} (${r.handResult.points} pts)`, 'score');
                this.recordScoreEvent(fresh, r.handPlayer, r.handResult.points,
                    r.handResult.breakdown.length ? r.handResult.breakdown.join('; ') : `${r.handResult.points} pts`);
            }
            if (r.dealerResult) {
                const who = this.engine.players[r.dealerPlayer].name;
                const desc = r.dealerResult.breakdown.length ? r.dealerResult.breakdown.join('; ') : 'no points';
                this.addLogEntry(`${who} counted hand: ${desc} (${r.dealerResult.points} pts)`, 'score');
                this.recordScoreEvent(fresh, r.dealerPlayer, r.dealerResult.points,
                    r.dealerResult.breakdown.length ? r.dealerResult.breakdown.join('; ') : `${r.dealerResult.points} pts`);
            }
            if (r.cribResult) {
                const desc = r.cribResult.breakdown.length ? r.cribResult.breakdown.join('; ') : 'no points';
                this.addLogEntry(`Crib counted: ${desc} (${r.cribResult.points} pts)`, 'score');
                this.recordScoreEvent(fresh, this.engine.dealerIndex, r.cribResult.points,
                    r.cribResult.breakdown.length ? 'CRIB: ' + r.cribResult.breakdown.join('; ') : 'no crib points');
            }
        }

        // makeAIMove re-renders and drives checkAITurn after this returns.
    }

    addLogEntry(message, type = 'system') {
        const log = document.getElementById('log-messages');
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
        
        this.gameLog.push({ message, type, time: Date.now() });
        if (this.gameLog.length > 100) this.gameLog.shift();
    }

    updateConnectionStatus(connected) {
        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        
        if (connected) {
            dot.classList.add('connected');
            text.textContent = 'CONNECTED';
        } else {
            dot.classList.remove('connected');
            text.textContent = 'DISCONNECTED';
        }
    }

    showModal(title, content, actions) {
        document.getElementById('modal-header').textContent = title;
        document.getElementById('modal-content').innerHTML = content;
        
        const actionsContainer = document.getElementById('modal-actions');
        actionsContainer.innerHTML = actions.map(a => 
            `<button class="pixel-btn ${a.class || ''}" data-action="${a.text}">${a.text}</button>`
        ).join('');
        
        actionsContainer.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = actions.find(a => a.text === btn.dataset.action);
                if (action?.action) action.action();
            });
        });
        
        document.getElementById('modal-overlay').classList.remove('hidden');
    }

    hideModal() {
        document.getElementById('modal-overlay').classList.add('hidden');
    }

    showDiscardModal(instruction, count) {
        document.getElementById('discard-instruction').innerHTML = instruction.replace('{count}', count);
        document.getElementById('discard-count').textContent = count;
        document.getElementById('confirm-discard').disabled = true;
        document.getElementById('discard-preview').innerHTML = '';
        document.getElementById('discard-modal').classList.remove('hidden');
    }

    hideDiscardModal() {
        document.getElementById('discard-modal').classList.add('hidden');
        this.discardSelection.clear();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CribbageGame };
} else {
    window.CribbageGame = CribbageGame;
}