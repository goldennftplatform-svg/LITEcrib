/*
 * LITEcrib store — durable JSON persistence for accounts (users + custody
 * mnemonics) with atomic writes. Sessions are intentionally NOT persisted:
 * a token is a bearer for THIS process; restarting invalidates them and the
 * client re-logs-in. Users however must survive restarts.
 *
 * The store file is plaintext on the host. That is acceptable for a prizeless
 * testnet prototype; production must encrypt custody mnemonics at rest
 * (KMS envelope encryption) and run the store behind a separate service.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = process.env.LITECRIB_STORE_FILE ||
    path.join(__dirname, 'data', 'users.json');

let users = [];
let loading = false;

function load() {
    try {
        users = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (!Array.isArray(users)) users = [];
    } catch (e) {
        users = [];
    }
    loading = true;
    return users;
}

function flush() {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
    fs.renameSync(tmp, FILE);           // atomic on same volume
}

function addUser(user) {
    users.push(user);
    flush();
}

function getUser(id) {
    return users.find((u) => u.id === id) || null;
}

function findByEmail(email) {
    return users.find((u) => u.email === email) || null;
}

function bySnapshot() {
    return users.map((u) => ({
        id: u.id, email: u.email, address: u.address, path: u.path, createdAt: u.createdAt
    }));
}

module.exports = { load, addUser, getUser, findByEmail, bySnapshot, _file: FILE };