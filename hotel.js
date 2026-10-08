'use strict';
// The Chog Hotel's venues (docs/game/world.md): the ones the game puts there (seed_venues.json, built by tools/build_seed_venues.js) and the holders' own.
// A venue is a room document plus where its door is: number = floor * 100 + first slot (slots 1..8; 1..4 on the long wall, 5..8 on the short one), `span` slots wide.
// A holder's venue is made from the license: it starts CLOSED (only the owner can enter), the owner decorates it, then opens it. The room and the facade are
// signed documents kept by rooms.js stores; this file keeps the record (tier, door, name, state, entry rule) as one small JSON file per wallet.
const fs = require('fs');
const path = require('path');
const { clean } = require('./filter');
const rooms = require('./rooms');
const seeds = require('./seed_venues.json');

// What a tier gives (placeholders, docs/game/design.md): room floor (W x D metres), piece budget, facade width in door slots and facade piece budget
const TEMPLATES = {
  1: { size: [9, 7], pieces: 60, span: 1, facade: 12 },
  2: { size: [11, 8], pieces: 90, span: 2, facade: 24 },
  3: { size: [13, 9], pieces: 130, span: 3, facade: 40 },
  4: { size: [15, 11], pieces: 180, span: 3, facade: 60 },
};
const SLOT_M = 3, FACADE_DEPTH = 1.4;                       // metres of wall per door slot, and how far a facade may reach into the corridor
const CATS = ['Club', 'Café', 'Arcade', 'Gallery', 'Lounge', 'Spooky', 'Workshop', 'Other'];
const RULES = ['public', 'holders', 'list'];
const text = (raw, max) => clean(String(raw == null ? '' : raw).slice(0, 200)).text.replace(/\[(link|address) removed\]/g, '').trim().slice(0, max);
const userList = raw => [...new Set((Array.isArray(raw) ? raw : []).map(s => String(s).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16)).filter(s => s.length >= 3))].slice(0, 50);

// the door is always there and reachable: nothing may stand in front of it or hang over it (the facade strip is 1.4 m deep, so the whole width of the door is kept free)
const DOOR_FREE = 0.9;
function keepDoorClear(doc) {
  doc.windows = false;                                                  // a facade has no windows of its own
  doc.pieces = doc.pieces.filter(it => { const d = rooms.CAT.pieces[it.p], hw = ((it.ry || 0) % 180 ? d.fp[1] : d.fp[0]) / 2; const side = (it.ry || 0) % 180 !== 0; if (d.wall && side) return false; return Math.abs(it.x) - hw >= DOOR_FREE - 0.02; });   // wall pieces only on the back wall, none over the door
  return doc;
}

function open(dataDir) {
  const metaDir = path.join(dataDir, 'venue_meta'); fs.mkdirSync(metaDir, { recursive: true });
  const docs = rooms.open(dataDir, 'venue_docs', 'venue'), facades = rooms.open(dataDir, 'facade_docs', 'facade');
  const all = new Map(), byOwner = new Map();
  for (const v of seeds) all.set(v.id, { ...v, span: 1, state: 'open', opened: true, rule: 'public', guests: [], bans: [], size: rooms.LIMITS.size, addr: null });
  for (const f of fs.readdirSync(metaDir)) {
    if (!f.endsWith('.json')) continue;
    try { const v = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf8')); all.set(v.id, v); byOwner.set(v.addr, v); } catch (e) { /* skip a broken file */ }
  }
  const persist = v => { const file = path.join(metaDir, v.addr + '.json'), tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, file); };
  const arm = s => (s <= 4 ? 0 : 1);

  // the first free run of `span` slots in one arm of a floor (floors are added as needed: floor 1, 2, 3 ...)
  function allocate(span) {
    const used = new Set(); for (const v of all.values()) for (let i = 0; i < (v.span || 1); i++) used.add(v.floor * 10 + (v.no % 100) + i);
    for (let floor = 1; ; floor++) for (let start = 1; start + span - 1 <= 8; start++) {
      if (arm(start) !== arm(start + span - 1)) continue;
      let free = true; for (let i = 0; i < span; i++) if (used.has(floor * 10 + start + i)) { free = false; break; }
      if (free) return { floor, slot: start };
    }
  }
  const view = v => ({ id: v.id, no: v.no, floor: v.floor, span: v.span || 1, name: v.opened ? v.name : 'Opening soon', cat: v.opened ? v.cat : 'Other', desc: v.opened ? v.desc : '', by: v.by, state: v.state, rule: v.rule });
  const sizeOf = v => v.size || rooms.LIMITS.size;

  return {
    TEMPLATES, FACADE_DEPTH, CATS, RULES, SLOT_M,
    get: id => { const v = all.get(id); if (!v) return null; return v.addr ? { ...v, doc: (docs.get(v.addr) || {}).doc || null } : v; },
    byOwner: addr => byOwner.get(addr) || null,
    floors: () => [...all.values()].reduce((n, v) => Math.max(n, v.floor), 0),
    sizeOf,
    // the public list: no room documents (visitors get one when they walk in); a never-opened venue shows only that it is opening soon
    list: () => [...all.values()].map(view),
    // the owner's own view of their venue
    mine: addr => { const v = byOwner.get(addr); return v ? { ...view(v), name: v.name, cat: v.cat, desc: v.desc, tier: v.tier, size: v.size, guests: v.guests, bans: v.bans, hasDoc: !!docs.get(addr), hasFacade: !!facades.get(addr), facade: (facades.get(addr) || {}).doc || null, template: TEMPLATES[v.tier] } : null; },
    // activate: a venue exists, closed, with its door number. One per wallet.
    activate(addr, tier, o = {}) {
      if (byOwner.has(addr)) throw new Error('You already have a venue.');
      const t = TEMPLATES[tier]; if (!t) throw new Error('You need a Chog to open a venue.');
      const { floor, slot } = allocate(t.span);
      const v = { id: 'h' + addr.slice(2, 10), addr, tier, floor, no: floor * 100 + slot, span: t.span, size: t.size, name: text(o.name, 32) || 'My Venue', cat: CATS.includes(o.cat) ? o.cat : 'Other', desc: text(o.desc, 120), by: text(o.by, 24) || 'A Chog holder',
        state: 'closed', opened: false, rule: 'public', guests: [], bans: [], createdAt: Date.now() };
      all.set(v.id, v); byOwner.set(addr, v); persist(v); return v;
    },
    // update: what the owner may change without a signature (name, kind, description, entry rule, lists, open or closed)
    update(addr, patch) {
      const v = byOwner.get(addr); if (!v) throw new Error('You have no venue yet.');
      if (patch.name !== undefined) v.name = text(patch.name, 32) || v.name;
      if (patch.cat !== undefined && CATS.includes(patch.cat)) v.cat = patch.cat;
      if (patch.desc !== undefined) v.desc = text(patch.desc, 120);
      if (patch.by !== undefined) v.by = text(patch.by, 24) || v.by;
      if (patch.rule !== undefined && RULES.includes(patch.rule)) v.rule = patch.rule;
      if (patch.guests !== undefined) v.guests = userList(patch.guests);
      if (patch.bans !== undefined) v.bans = userList(patch.bans);
      if (patch.open !== undefined) {
        if (patch.open && !docs.get(addr)) throw new Error('Decorate and save your room first, then open it.');
        v.state = patch.open ? 'open' : 'closed'; if (patch.open) v.opened = true;
      }
      persist(v); return v;
    },
    docs, facades,
    limitsOf: v => ({ limit: TEMPLATES[v.tier].pieces, size: sizeOf(v), name: v.name }),
    facadeLimits: v => ({ limit: TEMPLATES[v.tier].facade, size: [v.span * SLOT_M, FACADE_DEPTH], name: v.name, post: keepDoorClear }),
    // the facades on one floor (small documents, sent when a player steps onto the floor)
    facadesOn: floor => [...all.values()].filter(v => v.floor === floor && v.addr).map(v => { const f = facades.get(v.addr); return f ? { id: v.id, no: v.no, span: v.span, doc: f.doc } : null; }).filter(Boolean),
    // can this player walk in? -> null (yes) or the guard's reason (usernames and the Chog they play come from the server's player record)
    entry(v, p) {
      if (v.addr && v.addr === p.addr) return null;
      if (v.state !== 'open') return v.opened ? 'This venue is closed right now.' : 'This venue is not open yet.';
      const u = (p.username || '').toLowerCase();
      if (u && (v.bans || []).includes(u)) return 'The guard turns you away.';
      if (v.rule === 'holders' && !p.token) return 'Holders only. Play as your Chog to come in.';
      if (v.rule === 'list' && !(u && (v.guests || []).includes(u))) return 'The guard checks the guest list. Your name is not on it.';
      return null;
    },
  };
}
module.exports = { open, TEMPLATES, CATS, RULES };
