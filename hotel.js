'use strict';
// The Chog Hotel's venues (docs/game/world.md): the ones the game puts there (seed_venues.json, built by tools/build_seed_venues.js) and the holders' own.
// A floor is a square hall with four wall slots: slots 1 and 2 on the north back wall, 3 and 4 on the west back wall (numbers = floor * 100 + first slot).
// A venue holds `span` slots (1 = a wall segment, 2 = a whole wall, 4 = the whole floor) and, from tier 3, `levels` 2: it also holds the same slots on the floor above,
// and its room has an upper level (a second room document, reached by stairs). A holder's venue is made from the license: it starts CLOSED (only the owner can enter),
// the owner decorates it, then opens it. The rooms and the facade are signed documents kept by rooms.js stores; this file keeps the record (tier, door, name,
// state, entry rule) as one small JSON file per wallet.
const fs = require('fs');
const path = require('path');
const { clean } = require('./filter');
const rooms = require('./rooms');
const seeds = require('./seed_venues.json');

// What a tier gives (placeholders, docs/game/design.md): room floor (W x D metres, every level), piece budget per level, lights, door slots, levels and the facade piece budget
// cap = people inside at once (both levels together; the owner always gets in), vip = a VIP lounge with its own entry rule (the upper level), stage / music = stage and DJ booth pieces and the venue music (pieces: minTier in the catalog)
const TEMPLATES = {
  1: { size: [15, 11], pieces: 120, lights: 12, span: 1, levels: 1, facade: 20, cap: 12, vip: false, music: false },
  2: { size: [18, 13], pieces: 180, lights: 14, span: 2, levels: 1, facade: 40, cap: 20, vip: false, music: true },
  3: { size: [18, 13], pieces: 160, lights: 14, span: 2, levels: 2, facade: 60, cap: 32, vip: true, music: true },
  4: { size: [22, 15], pieces: 200, lights: 16, span: 4, levels: 2, facade: 80, cap: 50, vip: true, music: true },
};
const SEED_CAP = 30, FREEZE_MS = 7 * 24 * 3600e3;                      // the game's own venues hold 30; a venue whose owner fell below its tier waits 7 days frozen before its slot is freed
const MUSIC = ['lobby', 'cafe', 'arcade', 'club', 'gallery', 'home'];  // the synthesized tracks (js/audio.js places)
const SLOT_M = 6.5, FACADE_DEPTH = 1.6, LAYOUT = 2;           // metres of wall per slot, how far a facade may reach into the hall, the numbering scheme of the records
const CATS = ['Club', 'Café', 'Arcade', 'Gallery', 'Lounge', 'Spooky', 'Workshop', 'Other'];
const RULES = ['public', 'holders', 'list'];
const CAT = rooms.CAT;
const text = (raw, max) => clean(String(raw == null ? '' : raw).slice(0, 200)).text.replace(/\[(link|address) removed\]/g, '').trim().slice(0, max);
const userList = raw => [...new Set((Array.isArray(raw) ? raw : []).map(s => String(s).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16)).filter(s => s.length >= 3))].slice(0, 50);

const slotsOf = v => Array.from({ length: v.span || 1 }, (_, i) => (v.no % 100) + i);
const facadeWidth = v => Math.min(v.span || 1, 2) * SLOT_M;      // the door's wall: a whole-floor venue still has one facade, on the north wall

// the door is always there and reachable: nothing may stand in front of it or hang over it (the whole width of the door is kept free)
const DOOR_FREE = 0.9;
function keepDoorClear(doc) {
  doc.windows = false;                                                  // a facade has no windows of its own
  doc.pieces = doc.pieces.filter(it => { const d = rooms.CAT.pieces[it.p], hw = ((it.ry || 0) % 180 ? d.fp[1] : d.fp[0]) / 2; const side = (it.ry || 0) % 180 !== 0; if (d.wall && side) return false; return Math.abs(it.x) - hw >= DOOR_FREE - 0.02; });   // wall pieces only on the back wall, none over the door
  return doc;
}

const userDocPath = (dir, addr) => path.join(dir, addr + '.json');

// Fit a stored room document into another room size (a move to a bigger or smaller room): floor pieces that no longer lie inside the floor, wall pieces
// that no longer fit on their wall, and pieces in the way of the door or the stairs are dropped (rooms.sanitize then snaps the wall pieces onto the new walls).
function fitDoc(doc, size, tpl, tier) {
  if (!doc) return null;
  const [W, D] = size, doorU = W / 2 - 1.6, stairsU = W / 2 - 4.8, eps = 1e-6;
  const pieces = (doc.pieces || []).filter(it => {
    const d = CAT.pieces[it.p]; if (!d || (d.minTier || 0) > tier) return false;
    const rot = (it.ry || 0) % 180 !== 0;
    if (d.wall) {
      const u = rot ? it.z : it.x, len = rot ? D : W, half = d.fp[0] / 2;
      if (Math.abs(u) + half > len / 2 + eps) return false;
      if (!rot && Math.abs(u - doorU) < half + 0.8) return false;
      if (!rot && tpl.levels > 1 && Math.abs(u - stairsU) < half + 0.8) return false;
      return true;
    }
    const hw = (rot ? d.fp[1] : d.fp[0]) / 2, hd = (rot ? d.fp[0] : d.fp[1]) / 2;
    if (it.x - hw < -W / 2 - eps || it.x + hw > W / 2 + eps || it.z - hd < -D / 2 - eps || it.z + hd > D / 2 + eps) return false;
    if (d.cat === 'floor' || d.cat === 'ceiling') return true;
    if (Math.abs(it.x - doorU) < hw + 0.9 && it.z - hd < -D / 2 + 1.5) return false;
    if (tpl.levels > 1 && Math.abs(it.x - stairsU) < hw + 1.2 && it.z - hd < -D / 2 + 2.4) return false;
    return true;
  });
  return { ...doc, pieces };
}

function open(dataDir, opts = {}) {
  const now = opts.now || Date.now;                                       // a clock the tests can move
  const shop = opts.shop || null;                                         // shop.js: the owner's extra budget and which shop pieces they own (read from its cache, never from the chain here)
  const extraOf = v => (shop && v.addr ? shop.budget(v.addr, v.tier) : { pieces: 0, lights: 0 });
  const metaDir = path.join(dataDir, 'venue_meta'), archDir = path.join(dataDir, 'venue_archive'), backDir = path.join(dataDir, 'venue_backup');
  for (const d of [metaDir, archDir, backDir]) fs.mkdirSync(d, { recursive: true });
  const docs = rooms.open(dataDir, 'venue_docs', 'venue'), docs2 = rooms.open(dataDir, 'venue2_docs', 'venue upper level'), facades = rooms.open(dataDir, 'facade_docs', 'facade');
  const all = new Map(), byOwner = new Map();
  for (const v of seeds) all.set(v.id, { ...v, span: 1, levels: 1, state: 'open', opened: true, rule: 'public', guests: [], bans: [], music: '', vipRule: 'public', vipGuests: [], size: v.size || TEMPLATES[1].size, addr: null });
  const legacy = [];
  for (const f of fs.readdirSync(metaDir)) {
    if (!f.endsWith('.json')) continue;
    try { const v = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf8')); if (v.layout === LAYOUT) { all.set(v.id, v); byOwner.set(v.addr, v); } else legacy.push(v); } catch (e) { /* skip a broken file */ }
  }
  const writeJson = (file, obj) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); };
  const persist = v => writeJson(userDocPath(metaDir, v.addr), v);

  // the first free run of `span` slots (on `levels` floors in a row) in one wall of a floor; floors are added as needed.
  // A whole-floor venue (the penthouse) goes above everything else: it starts at the floor over the highest smaller venue.
  function allocate(span, levels) {
    const used = new Set(); let base = 0;
    for (const v of all.values()) {
      for (let l = 0; l < (v.levels || 1); l++) for (const s of slotsOf(v)) used.add((v.floor + l) * 10 + s);
      if (!((v.span || 1) === 4 && (v.levels || 1) > 1)) base = Math.max(base, v.floor + (v.levels || 1) - 1);
    }
    const starts = span === 1 ? [1, 2, 3, 4] : span === 2 ? [1, 3] : [1];
    for (let floor = span === 4 && levels > 1 ? base + 1 : 1; ; floor++) for (const start of starts) {
      let free = true; for (let l = 0; l < levels && free; l++) for (let i = 0; i < span; i++) if (used.has((floor + l) * 10 + start + i)) { free = false; break; }
      if (free) return { floor, slot: start };
    }
  }
  // records from the first numbering (8 small slots per floor, smaller rooms) get a place in the new one, oldest first; their rooms and facades are kept
  for (const v of legacy.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    const t = TEMPLATES[v.tier] || TEMPLATES[1], { floor, slot } = allocate(t.span, t.levels);
    Object.assign(v, { floor, no: floor * 100 + slot, span: t.span, levels: t.levels, size: t.size, layout: LAYOUT }); all.set(v.id, v); byOwner.set(v.addr, v); persist(v);
  }
  const capOf = v => (v.addr ? (TEMPLATES[v.tier] || TEMPLATES[1]).cap : SEED_CAP);
  const vipOf = v => ((v.levels || 1) > 1 && v.vipRule && v.vipRule !== 'public' ? v.vipRule : null);
  const view = v => ({ id: v.id, no: v.no, floor: v.floor, span: v.span || 1, levels: v.levels || 1, name: v.opened ? v.name : 'Opening soon', cat: v.opened ? v.cat : 'Other', desc: v.opened ? v.desc : '', by: v.by, state: v.state, rule: v.rule, cap: capOf(v), vip: vipOf(v) });
  const sizeOf = v => v.size || TEMPLATES[1].size;
  const tplOf = v => (v.addr ? TEMPLATES[v.tier] : TEMPLATES[1]);
  const ownsOf = v => (shop && v.addr ? shop.ownsFn(v.addr, v.tier) : undefined);
  const facadeLim = (v, tpl = TEMPLATES[v.tier]) => ({ limit: tpl.facade, size: [Math.min(v.span || 1, 2) * SLOT_M, FACADE_DEPTH], name: v.name, post: keepDoorClear, tier: v.tier, owns: ownsOf(v) });
  const venueLim = v => ({ limit: TEMPLATES[v.tier].pieces + extraOf(v).pieces, size: sizeOf(v), name: v.name, tier: v.tier, venue: true, owns: ownsOf(v) });
  const archived = addr => { try { return JSON.parse(fs.readFileSync(userDocPath(archDir, addr), 'utf8')); } catch (e) { return null; } };
  const daysLeft = v => (v.state === 'frozen' && v.frozenAt ? Math.max(0, Math.ceil((v.frozenAt + FREEZE_MS - now()) / 86400e3)) : null);

  // the slot is freed and the venue (record and every document) is kept in the archive for its owner
  function archive(v) {
    const addr = v.addr;
    writeJson(userDocPath(archDir, addr), { meta: v, venue: docs.get(addr), venue2: docs2.get(addr), facade: facades.get(addr), at: now() });
    all.delete(v.id); byOwner.delete(addr); try { fs.unlinkSync(userDocPath(metaDir, addr)); } catch (e) { /* none */ }
    docs.drop(addr); docs2.drop(addr); facades.drop(addr);
  }

  return {
    TEMPLATES, FACADE_DEPTH, CATS, RULES, MUSIC, SLOT_M, FREEZE_MS, facadeWidth, capOf,
    get: id => { const v = all.get(id); if (!v) return null; return v.addr ? { ...v, doc: (docs.get(v.addr) || {}).doc || null, doc2: (docs2.get(v.addr) || {}).doc || null } : v; },
    byOwner: addr => byOwner.get(addr) || null,
    hasArchive: addr => !!archived(addr),
    owners: () => [...byOwner.keys()],
    floors: () => [...all.values()].reduce((n, v) => Math.max(n, v.floor + (v.levels || 1) - 1), 0),
    sizeOf,
    // the public list: no room documents (visitors get one when they walk in); a never-opened venue shows only that it is opening soon
    list: () => [...all.values()].map(view),
    // the owner's own view of their venue
    mine: addr => { const v = byOwner.get(addr); return v ? { ...view(v), name: v.name, cat: v.cat, desc: v.desc, tier: v.tier, size: v.size, guests: v.guests, bans: v.bans, music: v.music || '', vipRule: v.vipRule || 'public', vipGuests: v.vipGuests || [], frozenAt: v.frozenAt || null, daysLeft: daysLeft(v), hasDoc: !!docs.get(addr), hasDoc2: !!docs2.get(addr), hasFacade: !!facades.get(addr), facade: (facades.get(addr) || {}).doc || null, facadeSize: [facadeWidth(v), FACADE_DEPTH], template: { ...TEMPLATES[v.tier], pieces: TEMPLATES[v.tier].pieces + extraOf(v).pieces, lights: TEMPLATES[v.tier].lights + extraOf(v).lights, extra: extraOf(v) } } : null; },
    // activate: a venue exists, closed, with its door number. One per wallet.
    activate(addr, tier, o = {}) {
      if (byOwner.has(addr)) throw new Error('You already have a venue.');
      const t = TEMPLATES[tier]; if (!t) throw new Error('You need a Chog to open a venue.');
      const { floor, slot } = allocate(t.span, t.levels);
      const v = { id: 'h' + addr.slice(2, 10), addr, tier, layout: LAYOUT, floor, no: floor * 100 + slot, span: t.span, levels: t.levels, size: t.size, name: text(o.name, 32) || 'My Venue', cat: CATS.includes(o.cat) ? o.cat : 'Other', desc: text(o.desc, 120), by: text(o.by, 24) || 'A Chog holder',
        state: 'closed', opened: false, rule: 'public', guests: [], bans: [], music: '', vipRule: 'public', vipGuests: [], createdAt: now() };
      all.set(v.id, v); byOwner.set(addr, v); persist(v); return v;
    },
    // update: what the owner may change without a signature (name, kind, description, entry rule, lists, open or closed, music, VIP rule)
    update(addr, patch) {
      const v = byOwner.get(addr); if (!v) throw new Error('You have no venue yet.');
      const t = TEMPLATES[v.tier];
      if (patch.name !== undefined) v.name = text(patch.name, 32) || v.name;
      if (patch.cat !== undefined && CATS.includes(patch.cat)) v.cat = patch.cat;
      if (patch.desc !== undefined) v.desc = text(patch.desc, 120);
      if (patch.by !== undefined) v.by = text(patch.by, 24) || v.by;
      if (patch.rule !== undefined && RULES.includes(patch.rule)) v.rule = patch.rule;
      if (patch.guests !== undefined) v.guests = userList(patch.guests);
      if (patch.bans !== undefined) v.bans = userList(patch.bans);
      if (patch.music !== undefined) {
        if (patch.music && !MUSIC.includes(patch.music)) throw new Error('That track does not exist.');
        if (patch.music && !t.music) throw new Error('You need a Fren venue or better to choose the music.');
        v.music = patch.music || '';
      }
      if (patch.vipRule !== undefined && RULES.includes(patch.vipRule)) {
        if (patch.vipRule !== 'public' && !t.vip) throw new Error('You need a Whale venue or better for a VIP lounge.');
        v.vipRule = patch.vipRule;
      }
      if (patch.vipGuests !== undefined) v.vipGuests = userList(patch.vipGuests);
      if (patch.open !== undefined) {
        if (v.state === 'frozen') { if (patch.open) throw new Error('Your venue is frozen: you hold fewer Chogs than this venue needs.'); }
        else {
          if (patch.open && !docs.get(addr)) throw new Error('Decorate and save your room first, then open it.');
          v.state = patch.open ? 'open' : 'closed'; if (patch.open) v.opened = true;
        }
      }
      persist(v); return v;
    },
    docs, docs2, facades,
    // the room store of one level (1 = the entrance level, 2 = upstairs, only for tiers with two levels)
    store: (v, level) => (level === 2 ? docs2 : docs),
    limitsOf: v => venueLim(v),
    facadeLimits: v => facadeLim(v),
    lightsOf: v => tplOf(v).lights + extraOf(v).lights,
    piecesOf: v => tplOf(v).pieces + extraOf(v).pieces,
    // the facades on one floor (small documents, sent when a player steps onto it)
    facadesOn: floor => [...all.values()].filter(v => v.floor === floor && v.addr).map(v => { const f = facades.get(v.addr); return f ? { id: v.id, no: v.no, span: v.span, doc: f.doc } : null; }).filter(Boolean),
    // can this player walk in? -> null (yes) or the guard's reason (usernames and the Chog they play come from the server's player record).
    // ctx: { count: people inside right now, not counting this player, level: 1 | 2 }
    entry(v, p, ctx = {}) {
      if (v.addr && v.addr === p.addr) return null;
      if (v.state === 'frozen') return 'This venue is frozen right now.';
      if (v.state !== 'open') return v.opened ? 'This venue is closed right now.' : 'This venue is not open yet.';
      const u = (p.username || '').toLowerCase();
      if (u && (v.bans || []).includes(u)) return 'The guard turns you away.';
      if (v.rule === 'holders' && !p.token) return 'Holders only. Play as your Chog to come in.';
      if (v.rule === 'list' && !(u && (v.guests || []).includes(u))) return 'The guard checks the guest list. Your name is not on it.';
      if (ctx.level === 2 && vipOf(v) === 'holders' && !p.token) return 'The VIP lounge is for Chog holders. Play as your Chog to go up.';
      if (ctx.level === 2 && vipOf(v) === 'list' && !(u && (v.vipGuests || []).includes(u))) return 'The VIP lounge has a guest list. Your name is not on it.';
      if ((ctx.count || 0) >= capOf(v)) return `This venue is full (${capOf(v)} / ${capOf(v)}). Try again in a moment.`;
      return null;
    },

    // ---- holdings: the owner's tier against the venue's (called with a fresh chain reading). Returns what changed: 'frozen' | 'thawed' | 'expired' | null
    reconcile(addr, tier) {
      const v = byOwner.get(addr); if (!v) return null;
      if (tier >= v.tier) { if (v.state !== 'frozen') return null; v.state = v.prevState === 'open' ? 'open' : 'closed'; v.frozenAt = null; delete v.prevState; persist(v); return 'thawed'; }
      if (v.state !== 'frozen') { v.prevState = v.state; v.state = 'frozen'; v.frozenAt = now(); persist(v); return 'frozen'; }
      if (now() - (v.frozenAt || 0) >= FREEZE_MS) { archive(v); return 'expired'; }
      return null;
    },
    // what the owner may be offered for this tier: move up, move to a smaller room, or take the archived venue into a room
    offerFor(addr, tier) {
      const v = byOwner.get(addr);
      if (v) return tier > v.tier ? { kind: 'upgrade', tier } : tier > 0 && tier < v.tier ? { kind: 'downsize', tier } : null;
      return tier > 0 && archived(addr) ? { kind: 'restore', tier } : null;
    },
    // move the venue (or the archived one) into the room of `tier`: a new slot (the door number may change), the documents refitted, the old slot freed. A copy of the originals is kept.
    relocate(addr, tier) {
      const t = TEMPLATES[tier]; if (!t) throw new Error('You need a Chog to open a venue.');
      let v = byOwner.get(addr), recs;
      if (v) { if (tier === v.tier) throw new Error('Your venue already fits your tier.'); recs = { venue: docs.get(addr), venue2: docs2.get(addr), facade: facades.get(addr) }; }
      else { const a = archived(addr); if (!a) throw new Error('You have no venue yet.'); v = a.meta; recs = a; }
      writeJson(path.join(backDir, addr + '-' + now() + '.json'), { meta: v, venue: recs.venue, venue2: recs.venue2, facade: recs.facade, at: now() });
      const wasFrozen = v.state === 'frozen', prev = wasFrozen ? v.prevState : v.state, from = { floor: v.floor, levels: v.levels || 1 };
      all.delete(v.id); byOwner.delete(addr);                                       // free the old slot first: a smaller room may take the same door
      const { floor, slot } = allocate(t.span, t.levels);
      Object.assign(v, { tier, floor, no: floor * 100 + slot, span: t.span, levels: t.levels, size: t.size, layout: LAYOUT, frozenAt: null });
      v.state = wasFrozen || !recs.venue ? 'closed' : prev === 'open' ? 'open' : 'closed'; delete v.prevState;
      if (!t.vip) v.vipRule = 'public'; if (!t.music) v.music = '';
      all.set(v.id, v); byOwner.set(addr, v); persist(v);
      const lim = venueLim(v);
      if (recs.venue) docs.put(addr, fitDoc(recs.venue.doc, t.size, t, tier), lim); else docs.drop(addr);
      if (recs.venue2 && t.levels > 1) docs2.put(addr, fitDoc(recs.venue2.doc, t.size, t, tier), lim); else docs2.drop(addr);
      if (recs.facade) {
        const fl = facadeLim(v, t), W = fl.size[0], fd = recs.facade.doc;
        facades.put(addr, { ...fd, pieces: (fd.pieces || []).filter(it => { const d = CAT.pieces[it.p]; return d && (d.minTier || 0) <= tier && Math.abs(it.x) + d.fp[0] / 2 <= W / 2 + 1e-6; }) }, fl);
      } else facades.drop(addr);
      try { fs.unlinkSync(userDocPath(archDir, addr)); } catch (e) { /* it was not archived */ }
      return { venue: v, from };
    },
  };
}
module.exports = { open, TEMPLATES, CATS, RULES, MUSIC, SLOT_M, FACADE_DEPTH, FREEZE_MS, fitDoc };
