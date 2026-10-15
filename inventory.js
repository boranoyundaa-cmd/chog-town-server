'use strict';
// Inventory: pieces a wallet owns but has no room for (docs/game/world.md, Rooms). A piece lands here when a room shrinks (it no longer fits the floor, the budget or the tier)
// and when a Home from before the Hotel rooms is moved into a free room. Nothing is ever lost: the player places the piece again from the editor's "Stored" tab.
// One small JSON file per wallet: a list of { p, c?, txt? } (the piece, its tint and its words, no position). A placed piece is taken out again when a saved room holds more of it than before.
const fs = require('fs');
const path = require('path');
const CAT = require('./room_catalog.json');

const MAX = 400, HEX = /^#[0-9a-f]{6}$/i;
const OK = /^0x[0-9a-f]{40}$/;

function open(dataDir) {
  const dir = path.join(dataDir, 'inventory'); fs.mkdirSync(dir, { recursive: true });
  const cache = new Map(), file = a => path.join(dir, a + '.json');
  const tidy = it => {                                                    // one stored piece, rebuilt from a whitelist
    const def = it && CAT.pieces[it.p]; if (!def) return null;
    const o = { p: it.p }; if (typeof it.c === 'string' && HEX.test(it.c)) o.c = it.c.toLowerCase();
    if (def.edit && typeof it.txt === 'string' && it.txt.trim()) o.txt = it.txt.slice(0, 24);
    return o;
  };
  const load = addr => {
    if (!OK.test(addr || '')) return [];
    if (cache.has(addr)) return cache.get(addr);
    let items = []; try { items = JSON.parse(fs.readFileSync(file(addr), 'utf8')).items || []; } catch (e) { /* none yet */ }
    items = items.map(tidy).filter(Boolean); cache.set(addr, items); if (cache.size > 500) cache.delete(cache.keys().next().value); return items;
  };
  const store = (addr, items) => { cache.set(addr, items); const tmp = file(addr) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ items })); fs.renameSync(tmp, file(addr)); };
  return {
    MAX,
    get: addr => load(addr).slice(),
    // put pieces away (positions are dropped); returns how many were kept (the rest would be over the cap)
    add(addr, pieces) {
      if (!OK.test(addr || '')) return 0;
      const items = load(addr).slice(); let n = 0;
      for (const it of pieces || []) { const t = tidy(it); if (t && items.length < MAX) { items.push(t); n++; } }
      if (n) store(addr, items); return n;
    },
    // a room was saved: for every piece the new document holds more of than the old one, take that many out of the inventory (the same tint first)
    consume(addr, before, after) {
      const items = load(addr).slice(); if (!items.length) return 0;
      const count = list => { const m = {}; for (const it of list || []) m[it.p] = (m[it.p] || 0) + 1; return m; };
      const b = count(before), a = count(after); let taken = 0;
      for (const p of Object.keys(a)) {
        let extra = a[p] - (b[p] || 0);
        for (const it of (after || []).filter(q => q.p === p)) {
          if (extra <= 0) break;
          let i = items.findIndex(s => s.p === p && (s.c || '') === (it.c || '') && (s.txt || '') === (it.txt || '')); if (i < 0) i = items.findIndex(s => s.p === p);
          if (i < 0) break; items.splice(i, 1); extra--; taken++;
        }
      }
      if (taken) store(addr, items); return taken;
    },
  };
}
module.exports = { open, MAX };
