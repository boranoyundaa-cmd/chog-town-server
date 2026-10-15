'use strict';
// The phone companion (docs/engineering/server.md "Phone"): the PC hands the phone a key (Lev's key card, a QR code), the phone keeps it and reads its room with it.
//   code(addr)    a one-time pairing code for a signed-in wallet (8 letters, 10 minutes)
//   pair(code)    the phone trades the code for a key it keeps (30 days); a wallet holds at most 3 keys, the oldest goes first
//   addrOf(key)   the wallet a kept key belongs to, or null
//   visit / tip / today   today's numbers of a room (distinct visitors, tips in CHOG), kept in memory and reset at 00:00 UTC (a restart starts the day over)
// Keys are stored hashed in DATA_DIR/phone_keys.json; codes live in memory only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAIR_MS = 10 * 60e3, KEY_MS = 30 * 24 * 3600e3, KEYS_PER_WALLET = 3;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';          // 32 letters without look-alikes (I, O, 0, 1): a byte % 32 is unbiased

function open(dir, o = {}) {
  const now = o.now || Date.now, file = path.join(dir, 'phone_keys.json');
  let keys = {}; try { keys = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { /* no keys yet */ }
  const save = () => { try { fs.writeFileSync(file + '.tmp', JSON.stringify(keys)); fs.renameSync(file + '.tmp', file); } catch (e) { console.log('phone keys not saved', e.message); } };
  const hash = k => crypto.createHash('sha256').update(String(k)).digest('hex');
  const codes = new Map();                                   // code -> { addr, exp }
  const day = () => new Date(now()).toISOString().slice(0, 10);
  let statsDay = day(), stats = new Map();                  // venue id -> { seen: Set, tips }
  const statOf = id => { if (day() !== statsDay) { statsDay = day(); stats = new Map(); } if (!stats.has(id)) stats.set(id, { seen: new Set(), tips: 0 }); return stats.get(id); };
  return {
    code(addr) {
      const t = now(); for (const [c, v] of codes) if (v.exp < t || v.addr === addr) codes.delete(c);          // one live code per wallet
      let c; do { c = Array.from(crypto.randomBytes(8), b => ALPHA[b % ALPHA.length]).join(''); } while (codes.has(c));
      codes.set(c, { addr, exp: t + PAIR_MS }); return { code: c, exp: t + PAIR_MS };
    },
    pair(code) {
      const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), v = codes.get(c), t = now();
      if (!v || v.exp < t) return null; codes.delete(c);
      for (const [h, k] of Object.entries(keys)) if (k.exp < t) delete keys[h];
      const mine = Object.entries(keys).filter(([, k]) => k.addr === v.addr).sort((a, b) => a[1].at - b[1].at);
      while (mine.length >= KEYS_PER_WALLET) delete keys[mine.shift()[0]];
      const key = crypto.randomBytes(24).toString('hex'); keys[hash(key)] = { addr: v.addr, at: t, exp: t + KEY_MS }; save();
      return { key, addr: v.addr };
    },
    addrOf(key) { if (typeof key !== 'string' || key.length > 100) return null; const k = keys[hash(key)]; return k && k.exp > now() ? k.addr : null; },
    visit(id, who) { statOf(id).seen.add(who); },
    tip(id, amount) { statOf(id).tips += amount; },
    today(id) { const s = statOf(id); return { visitors: s.seen.size, tips: s.tips }; },
  };
}
module.exports = { open, PAIR_MS, KEY_MS, KEYS_PER_WALLET };
