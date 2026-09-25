// Runs on GitHub Actions against the PUBLIC site. No local server or build.
const { chromium, devices } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const url = 'https://goldennftplatform-svg.github.io/LITEcrib/';

(async () => {
    fs.mkdirSync('public-evidence', { recursive: true });
    // Wait for Pages to publish the revision under test, rather than test stale JS.
    const expected = fs.readFileSync('network.js', 'utf8').replace(/\r\n/g, '\n');
    let published = false;
    for (let i = 0; i < 60; i++) {
        const response = await fetch(url + 'network.js?revision=' + process.env.GITHUB_SHA + '&attempt=' + i);
        if (response.ok && (await response.text()).replace(/\r\n/g, '\n') === expected) {
            published = true;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    assert.ok(published, 'Pages must serve the committed networking file');
    const browser = await chromium.launch();
    try {
        for (const [label, options, mode] of [
            ['desktop', { viewport: { width: 1440, height: 1000 } }, '1v1'],
            ['phone', devices['Pixel 7'], '1v1'],
            ['trio', { viewport: { width: 1280, height: 900 } }, '3player']
        ]) {
            const context = await browser.newContext(options);
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            try {
                await page.goto(url + '?test=' + process.env.GITHUB_SHA, { waitUntil: 'networkidle' });
                await page.waitForFunction(() => window.game && window.game.network.connected);
                await page.locator('#player-name').fill('GITHUB TEST');
                await page.locator('#join-btn').click();
                await page.locator('#modal-actions [data-action="OK"]').click();
                await page.locator('.mode-card[data-mode="' + mode + '"]').click();
                await page.locator('#play-ai-btn').click();
                await page.waitForFunction(() => document.querySelector('#game-screen').classList.contains('active'));
                assert.equal(await page.evaluate(() => game.engine.players.length), mode === '1v1' ? 2 : 3);
                assert.equal(await page.evaluate(() => game.engine.phase), 'DISCARD');
                const discardCount = await page.evaluate(() => game.engine.getState(game.localPlayerIndex).discardCount);
                for (let i = 0; i < discardCount; i++) {
                    await page.locator('#hand-cards .card[data-index="' + i + '"]').click();
                }
                await page.locator('#discard-btn').click();
                await page.waitForFunction(() => game.engine.phase !== 'DISCARD');
                let played = 0;
                let counted = 0;
                const deadline = Date.now() + 90000;
                while (Date.now() < deadline) {
                    const phase = await page.evaluate(() => game.engine.phase);
                    if (phase === 'DISCARD') break; // Next hand after scoring.
                    for (const selector of ['#play-btn', '#go-btn', '#count-btn']) {
                        const button = page.locator(selector);
                        if (await button.isVisible() && await button.isEnabled()) {
                            await button.click();
                            if (selector === '#play-btn') played++;
                            if (selector === '#count-btn') counted++;
                            break;
                        }
                    }
                    await page.waitForTimeout(250);
                }
                assert.ok(played > 0, 'Human played cards through the UI');
                assert.ok(counted > 0, 'Human counted through the UI');
                assert.equal(await page.evaluate(() => game.engine.phase), 'DISCARD', 'Scoring completes and the next hand is dealt');
                await page.screenshot({ path: 'public-evidence/' + label + '.png', fullPage: true });
                assert.deepEqual(errors, [], 'No uncaught browser errors');
                console.log(label + ': public landing, buttons, discard, play, count and next hand PASS');
            } finally {
                fs.writeFileSync('public-evidence/' + label + '-errors.json', JSON.stringify(errors));
                await context.close();
            }
        }
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
