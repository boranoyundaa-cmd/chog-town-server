'use strict';
// Usernames: a unique name a wallet claims by signing (free, no NFT needed, no transaction). Venue guest lists and bans use these names, not wallet addresses.
// One name per wallet, case-insensitive and unique; it can be changed once every 7 days (the old name is free again). Stored as one small JSON file.
const fs = require('fs');
const path = require('path');
const { verifyMessage } = require('ethers');

const NAME = /^[A-Za-z][A-Za-z0-9_]{2,15}$/;
const RESERVED = /^(admin|administrator|mod|moderator|staff|guard|guide|reception|chog|chogs|chogtown|system|support|owner|npc|official|monad|resident|barista)$/i;
const LOOKS_AUTO = /^(guest|chog)_?\d*$/i;                       // would pass for the automatic names ("Guest-1234", "Chog #1700")
const COOLDOWN_MS = 7 * 24 * 3600e3, MAX_AGE_MS = 2 * 60e3;
const messageFor = (name, ts) => `Chog Town username\nClaim the name "${name}" for this wallet.\nIt is free and sends no transaction.\nTime: ${ts}`;

function open(dataDir) {
  const file = path.join(dataDir, 'users.json');
  let by = { addr: {}, name: {} };                               // addr -> { name, at };  lowercase name -> addr
  try { by = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
  const persist = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(by)); fs.renameSync(tmp, file); };
  const problem = (addr, name) => {
    if (typeof name !== 'string' || !NAME.test(name)) return 'A username is 3 to 16 letters, digits or underscores, and starts with a letter.';
    if (RESERVED.test(name) || LOOKS_AUTO.test(name)) return 'That name is reserved.';
    const owner = by.name[name.toLowerCase()]; if (owner && owner !== addr) return 'That name is taken.';
    const cur = by.addr[addr]; if (cur && cur.name.toLowerCase() === name.toLowerCase() && cur.name === name) return 'That is already your name.';
    if (cur && Date.now() - cur.at < COOLDOWN_MS && cur.name.toLowerCase() !== name.toLowerCase()) return 'You can change your name once every 7 days.';
    return null;
  };
  return {
    nameOf: addr => (by.addr[addr] || {}).name || null,
    addrOf: name => by.name[String(name).toLowerCase()] || null,
    problem,
    prepare(addr, name, now = Date.now()) { const e = problem(addr, name); if (e) throw new Error(e); return { ts: now, message: messageFor(name, now) }; },
    claim(addr, name, ts, sig, now = Date.now()) {
      const e = problem(addr, name); if (e) throw new Error(e);
      ts = +ts; if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_AGE_MS) throw new Error('The signature is too old. Try again.');
      let who; try { who = verifyMessage(messageFor(name, ts), String(sig)).toLowerCase(); } catch (x) { throw new Error('That signature is not valid.'); }
      if (who !== addr) throw new Error('That signature is from another wallet.');
      const old = by.addr[addr]; if (old) delete by.name[old.name.toLowerCase()];
      by.addr[addr] = { name, at: now }; by.name[name.toLowerCase()] = addr; persist(); return name;
    },
  };
}
module.exports = { open, NAME, messageFor };
