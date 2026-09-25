/*
 * LITEcrib auth — SSO for the games portal.
 *
 *   register(email, password) -> { token, user }   issues a NEW user wallet
 *                                                  (independent BIP39 mnemonic)
 *   login(email, password)    -> { token, user }
 *   me(token)                 -> user (wallet address/path, NEVER mnemonic)
 *   verifyExport(user, pw)    -> { mnemonic }      password re-checked first
 *
 * Sessions are opaque 32-byte random bearer tokens in an in-memory Map
 * (lost on restart; the client re-logs-in). Passwords are salted scrypt.
 * Throttle guard: /login and /export refuse after 5 failures per 15 min.
 */
'use strict';

const crypto = require('crypto');
const store = require('./store');
const wallet = require('./lit-wallet');

const sessions = new Map();                    // token -> userId
const failures = new Map();                    // key -> { fails, until }
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function genId() {
    return 'u_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
}

function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

function constantTimeEq(a, b) {
    const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
    const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
    return crypto.timingSafeEqual(ha, hb);
}

function throttleKey(scope, email, ip) {
    return scope + ':' + String(email || '').toLowerCase() + ':' + (ip || '');
}

function throttled(key) {
    const rec = failures.get(key);
    if (rec && rec.until > Date.now()) return rec.fails >= MAX_FAILS;
    return false;
}

function recordFailure(key) {
    const rec = failures.get(key);
    if (rec && rec.until > Date.now()) {
        rec.fails += 1;
    } else {
        failures.set(key, { fails: 1, until: Date.now() + FAIL_WINDOW_MS });
    }
}

function clearFailures(key) {
    failures.delete(key);
}

function publicUser(u) {
    return { id: u.id, email: u.email, address: u.address, path: u.path, createdAt: u.createdAt };
}

function newSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId, until: Date.now() + SESSION_TTL_MS });
    return token;
}

function registerUser(email, password, ip) {
    const e = String(email || '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw { code: 400, message: 'invalid email' };
    if (typeof password !== 'string' || password.length < 8) throw { code: 400, message: 'password must be at least 8 characters' };
    if (store.findByEmail(e)) throw { code: 409, message: 'email already registered' };

    const w = wallet.issueUserWallet();          // fresh BIP39 mnemonic -> USER_PATH
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
        id: genId(),
        email: e,
        salt,
        hash: hashPassword(password, salt),
        mnemonic: w.mnemonic,                    // custody copy (see store.js note)
        address: w.address,
        path: w.path,
        createdAt: Date.now()
    };
    store.addUser(user);
    return { token: newSession(user.id), user: publicUser(user) };
}

function login(email, password, ip) {
    const key = throttleKey('login', email, ip);
    if (throttled(key)) throw { code: 429, message: 'too many attempts; try again later' };

    const user = store.findByEmail(String(email || '').toLowerCase().trim());
    const ok = !!(user && constantTimeEq(hashPassword(String(password || ''), user.salt), user.hash));
    if (!ok) {
        recordFailure(key);
        throw { code: 401, message: 'invalid email or password' };
    }
    clearFailures(key);
    return { token: newSession(user.id), user: publicUser(user) };
}

function getSessionUser(token) {
    if (!token || typeof token !== 'string') return null;
    const rec = sessions.get(token);
    if (!rec) return null;
    if (rec.until < Date.now()) {
        sessions.delete(token);
        return null;
    }
    return store.getUser(rec.userId) || null;
}

function exportWallet(user, password, ip) {
    const key = throttleKey('export', user.email, ip);
    if (throttled(key)) throw { code: 429, message: 'too many attempts; try again later' };
    if (!constantTimeEq(hashPassword(String(password || ''), user.salt), user.hash)) {
        recordFailure(key);
        throw { code: 403, message: 'password incorrect' };
    }
    clearFailures(key);
    return { mnemonic: user.mnemonic, address: user.address, path: user.path };
}

module.exports = {
    registerUser,
    login,
    getSessionUser,
    exportWallet,
    publicUser,
    _sessions: sessions
};