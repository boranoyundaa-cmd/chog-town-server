'use strict';
// The Chog Hotel's rooms (docs/game/world.md): the venues the game puts there (seed_venues.json, built by tools/build_seed_venues.js), the free room every wallet player gets,
// and the holders' venues. There is one room per wallet: it starts free (tier 0) and the owner upgrades it by asking at the reception.
// A floor is a square hall with eight wall units of 5 m: units 1 to 4 on the north back wall, 5 to 8 on the west back wall. A room takes a run of units on one wall:
// free 1, Ser 2, Fren 4 (a whole wall), Whale 4 and the same wall on the floor above, Legend all 8 and the whole floor above. Door number = floor * 100 + first unit.
// A holder's venue starts CLOSED (only the owner can enter) until it is decorated and opened; a free room is public unless its owner locks it.
// A free room nobody entered for 30 days moves to the basement (floors B1, B2... downward, door numbers -(floor * 100 + unit)) and comes back up on request.
// The rooms and the facades are signed documents kept by rooms.js stores; this file keeps the record (tier, door, name, state, entry rule, lock) as one small JSON file per wallet.
const fs = require('fs');
const path = require('path');
const { clean } = require('./filter');
const rooms = require('./rooms');
const seeds = require('./seed_venues.json');

// What a tier gives (placeholders, docs/game/design.md): room floor (W x D metres, every level), piece budget per level, lights, wall units, levels and the facade piece budget
// tier 0 is the free room. vip = a VIP lounge with its own entry rule (the upper level), stage / music = stage and DJ booth pieces and the venue music (pieces: minTier in the catalog). Nobody limits how many people are inside.
const TEMPLATES = {
  0: { size: [14, 10], pieces: 80, lights: 10, units: 1, levels: 1, facade: 0, vip: false, music: false },
  1: { size: [22, 16], pieces: 200, lights: 16, units: 2, levels: 1, facade: 20, vip: false, music: false },
  2: { size: [27, 20], pieces: 300, lights: 18, units: 4, levels: 1, facade: 40, vip: false, music: true },
  3: { size: [27, 20], pieces: 280, lights: 18, units: 4, levels: 2, facade: 60, vip: true, music: true },
  4: { size: [33, 22], pieces: 340, lights: 22, units: 8, levels: 2, facade: 80, vip: true, music: true },
};
const OLD_SIZES = { 1: [15, 11], 2: [18, 13], 3: [18, 13], 4: [22, 15] };      // the rooms before the 2026-10-15 enlargement: venues still at these sizes are shifted into the new ones on load
const FREEZE_MS = 7 * 24 * 3600e3, BASEMENT_MS = 30 * 24 * 3600e3;     // a venue whose owner fell below its tier waits 7 days frozen before it shrinks; a free room nobody entered for 30 days goes to the basement
const MUSIC = ['lobby', 'cafe', 'arcade', 'club', 'gallery', 'home'];  // the synthesized tracks (js/audio.js places)
const UNIT_M = 5, FACADE_DEPTH = 1.6, LAYOUT = 3;           // metres of wall per unit, how far a facade may reach into the hall, the numbering scheme of the records
const CATS = ['Club', 'Café', 'Arcade', 'Gallery', 'Lounge', 'Spooky', 'Workshop', 'Other'];
const RULES = ['public', 'holders', 'list'];
const CAT = rooms.CAT;
const text = (raw, max) => clean(String(raw == null ? '' : raw).slice(0, 200)).text.replace(/\[(link|address) removed\]/g, '').trim().slice(0, max);
const userList = raw => [...new Set((Array.isArray(raw) ? raw : []).map(s => String(s).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16)).filter(s => s.length >= 3))].slice(0, 50);

const wallOfUnit = u => (u <= 4 ? 'z' : 'x');                                                   // units 1 to 4: north wall; 5 to 8: west wall
const validRun = (s, n) => s >= 1 && s + n - 1 <= 8 && (n === 8 ? s === 1 : wallOfUnit(s) === wallOfUnit(s + n - 1));      // a run of n units from unit s sits on one wall (all eight = the whole floor)
const unitsOf = v => Array.from({ length: v.units || 1 }, (_, i) => v.unit + i);
const noOf = (floor, unit) => (floor < 0 ? floor * 100 - unit : floor * 100 + unit);
const facadeWidth = v => Math.min(v.units || 1, 4) * UNIT_M;      // the door's wall: a whole-floor venue still has one facade, on the north wall

// the door is always there and reachable: nothing may stand in front of it or hang over it (the whole width of the door is kept free)
const DOOR_FREE = 0.9;
function keepDoorClear(doc) {
  doc.windows = false;                                                  // a facade has no windows of its own
  doc.pieces = doc.pieces.filter(it => { const d = rooms.CAT.pieces[it.p], hw = ((it.ry || 0) % 180 ? d.fp[1] : d.fp[0]) / 2; const side = (it.ry || 0) % 180 !== 0; if (d.wall && side) return false; return Math.abs(it.x) - hw >= DOOR_FREE - 0.02; });   // wall pieces only on the back wall, none over the door
  return doc;
}

const userDocPath = (dir, addr) => path.join(dir, addr + '.json');

// Fit a stored room document into another room size (a move to a bigger or smaller room): floor pieces that no longer lie inside the floor, wall pieces
// that no longer fit on their wall, pieces in the way of the door or the stairs, pieces the tier or the venue kind does not allow, and pieces over the budget are dropped
// (rooms.sanitize then snaps the wall pieces onto the new walls). ctx.dropped collects what was taken out (the caller puts it in the inventory), ctx.owns says which shop pieces the wallet owns, ctx.limit is the piece budget.
function fitDoc(doc, size, tpl, tier, ctx = {}) {
  if (!doc) return null;
  const [W, D] = size, doorU = W / 2 - 1.6, stairsU = W / 2 - 4.8, eps = 1e-6, out = ctx.dropped || [];
  const keep = [];
  for (const it of (doc.pieces || [])) {
    const d = CAT.pieces[it.p]; if (!d) continue;                                                 // a piece the catalog no longer has is simply gone
    if ((d.minTier || 0) > tier || (d.venue && !tier) || (d.shop && !(ctx.owns && ctx.owns(d.shop)))) { out.push(it); continue; }
    const rot = (it.ry || 0) % 180 !== 0;
    if (d.wall) {
      const u = rot ? it.z : it.x, len = rot ? D : W, half = d.fp[0] / 2;
      if (Math.abs(u) + half > len / 2 + eps || (!rot && Math.abs(u - doorU) < half + 0.8) || (!rot && tpl.levels > 1 && Math.abs(u - stairsU) < half + 0.8)) { out.push(it); continue; }
      keep.push(it); continue;
    }
    const hw = (rot ? d.fp[1] : d.fp[0]) / 2, hd = (rot ? d.fp[0] : d.fp[1]) / 2;
    if (it.x - hw < -W / 2 - eps || it.x + hw > W / 2 + eps || it.z - hd < -D / 2 - eps || it.z + hd > D / 2 + eps) { out.push(it); continue; }
    if (d.cat !== 'floor' && d.cat !== 'ceiling') {
      if (Math.abs(it.x - doorU) < hw + 0.9 && it.z - hd < -D / 2 + 1.5) { out.push(it); continue; }
      if (tpl.levels > 1 && Math.abs(it.x - stairsU) < hw + 1.2 && it.z - hd < -D / 2 + 2.4) { out.push(it); continue; }
    }
    keep.push(it);
  }
  if (ctx.limit != null && keep.length > ctx.limit) out.push(...keep.splice(ctx.limit));
  return { ...doc, pieces: keep };
}

function open(dataDir, opts = {}) {
  const now = opts.now || Date.now;                                       // a clock the tests can move
  const shop = opts.shop || null;                                         // shop.js: the owner's extra budget and which shop pieces they own (read from its cache, never from the chain here)
  const nameOf = opts.nameOf || (() => null);                             // users.js: the username of a wallet (a free room is named after it)
  const inv = opts.inventory || null;                                     // inventory.js: where pieces go that no longer fit
  const extraOf = v => (shop && v.addr ? shop.budget(v.addr, v.tier) : { pieces: 0, lights: 0 });
  const metaDir = path.join(dataDir, 'venue_meta'), backDir = path.join(dataDir, 'venue_backup'), oldHomes = path.join(dataDir, 'rooms_old');
  for (const d of [metaDir, backDir]) fs.mkdirSync(d, { recursive: true });
  const docs = rooms.open(dataDir, 'venue_docs', 'venue'), docs2 = rooms.open(dataDir, 'venue2_docs', 'venue upper level'), facades = rooms.open(dataDir, 'facade_docs', 'facade');
  const all = new Map(), byOwner = new Map();
  const writeJson = (file, obj) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); };
  const persist = v => writeJson(userDocPath(metaDir, v.addr), v);
  const stash = (addr, pieces) => { if (inv && addr && pieces && pieces.length) inv.add(addr, pieces); };

  // ---- loading: the game's own venues, then the records on disk (older numberings are moved into the units)
  // the second numbering (4 slots of 10 m per floor, `span` slots): old slot s becomes units 2s-1 and 2s, so a venue keeps its floor and its wall. Door numbers follow the first unit (101, 103, 105, 107...).
  const toUnits = v => { const slot = v.no % 100, unit = 2 * slot - 1; Object.assign(v, { unit, units: 2 * (v.span || 1), no: v.floor * 100 + unit, layout: LAYOUT }); delete v.span; return v; };
  for (const v of seeds) all.set(v.id, toUnits({ ...v, span: 1, levels: 1, state: 'open', opened: true, rule: 'public', guests: [], bans: [], music: '', vipRule: 'public', vipGuests: [], size: v.size || TEMPLATES[1].size, addr: null }));
  const legacy = [];
  for (const f of fs.readdirSync(metaDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf8'));
      if (v.layout === LAYOUT) { all.set(v.id, v); byOwner.set(v.addr, v); }
      else if (v.layout === 2) { toUnits(v); all.set(v.id, v); byOwner.set(v.addr, v); persist(v); }
      else legacy.push(v);
    } catch (e) { /* skip a broken file */ }
  }
  const occupied = ignore => {                                            // every unit in use, as 'floor:unit' (an upper level holds its units on the floor above too)
    const used = new Set();
    for (const v of all.values()) { if (v === ignore) continue; for (let l = 0; l < (v.levels || 1); l++) for (const u of unitsOf(v)) used.add((v.floor + l) + ':' + u); }
    return used;
  };
  // the first free run of n units (on `levels` floors in a row) in one wall of a floor; floors are added as needed.
  // A whole-floor venue (the penthouse) goes above everything else: it starts at the floor over the highest smaller venue. `ignore` = the room that is moving (its own units count as free).
  function allocate(n, levels, ignore) {
    const used = occupied(ignore); let base = 0;
    for (const v of all.values()) if (v !== ignore && v.floor > 0 && !((v.units || 1) === 8 && (v.levels || 1) > 1)) base = Math.max(base, v.floor + (v.levels || 1) - 1);
    const starts = []; for (let s = 1; s <= 9 - n; s++) if (validRun(s, n)) starts.push(s);
    for (let floor = n === 8 && levels > 1 ? base + 1 : 1; ; floor++) for (const unit of starts) {
      let free = true; for (let l = 0; l < levels && free; l++) for (let i = 0; i < n; i++) if (used.has((floor + l) + ':' + (unit + i))) { free = false; break; }
      if (free) return { floor, unit };
    }
  }
  function allocateBasement(ignore) {                                     // cold storage: single units, first fit, floors added downward
    const used = occupied(ignore);
    for (let floor = -1; ; floor--) for (let unit = 1; unit <= 8; unit++) if (!used.has(floor + ':' + unit)) return { floor, unit };
  }
  const place = v => Object.assign(v, { no: noOf(v.floor, v.unit) });
  // records from the first numbering (8 small slots per floor, smaller rooms) get a place in the new one, oldest first; their rooms and facades are kept
  for (const v of legacy.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
    const t = TEMPLATES[v.tier] || TEMPLATES[1], p = allocate(t.units, t.levels);
    delete v.span; Object.assign(v, { floor: p.floor, unit: p.unit, units: t.units, levels: t.levels, size: t.size, layout: LAYOUT }); place(v); all.set(v.id, v); byOwner.set(v.addr, v); persist(v);
  }

  const tplOf = v => (v.addr ? TEMPLATES[v.tier] : TEMPLATES[1]);
  const isFree = v => !!v.addr && !v.tier;
  const nameFor = v => v.name || (isFree(v) ? (nameOf(v.addr) ? nameOf(v.addr) + "'s room" : 'Guest room') : '');
  const vipOf = v => ((v.levels || 1) > 1 && v.vipRule && v.vipRule !== 'public' ? v.vipRule : null);
  const view = v => ({ id: v.id, no: v.no, tag: v.floor < 0 ? 'B' + (-v.floor) + String(v.unit).padStart(2, '0') : undefined, floor: v.floor, unit: v.unit, units: v.units || 1, levels: v.levels || 1, free: isFree(v), tier: v.addr ? v.tier : undefined,
    name: v.opened ? nameFor(v) : 'Opening soon', cat: v.opened ? v.cat : 'Other', desc: v.opened ? v.desc : '', by: v.by || (isFree(v) ? nameOf(v.addr) || '' : ''), state: v.state, rule: v.rule, locked: !!v.locked, vip: vipOf(v) });
  const sizeOf = v => v.size || TEMPLATES[1].size;
  const ownsOf = v => (shop && v.addr ? shop.ownsFn(v.addr, v.tier) : undefined);
  const facadeLim = (v, tpl = TEMPLATES[v.tier]) => ({ limit: tpl.facade, size: [Math.min(v.units || 1, 4) * UNIT_M, FACADE_DEPTH], name: nameFor(v), post: keepDoorClear, tier: v.tier, owns: ownsOf(v) });
  const venueLim = v => ({ limit: TEMPLATES[v.tier].pieces + extraOf(v).pieces, size: sizeOf(v), name: nameFor(v) || 'My Room', tier: v.tier, venue: v.tier > 0, owns: ownsOf(v) });
  // venues still at a room size from before the 2026-10-15 enlargement move into their tier's new room on load: the size is updated and the room documents are shifted
  // (rooms.shiftDoc: every piece keeps its place against the back walls) and re-stored as the server's own refit. A document already stamped with the new size is left alone.
  const sameSize = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  for (const v of byOwner.values()) {
    const t = TEMPLATES[v.tier], old = OLD_SIZES[v.tier]; if (!t || !sameSize(v.size, old) || sameSize(old, t.size)) continue;
    v.size = t.size; const lim = venueLim(v);
    for (const st of [docs, docs2]) { const r = st.get(v.addr); if (r && r.doc && !sameSize(r.sz, t.size)) st.put(v.addr, rooms.shiftDoc(r.doc, old, t.size), lim); }
    persist(v);
  }
  const daysLeft = v => (v.state === 'frozen' && v.frozenAt ? Math.max(0, Math.ceil((v.frozenAt + FREEZE_MS - now()) / 86400e3)) : null);

  function newRecord(addr, tier, p, o) {
    const t = TEMPLATES[tier], free = !tier;
    return place({ id: 'h' + addr.slice(2, 10), addr, tier, layout: LAYOUT, floor: p.floor, unit: p.unit, units: t.units, levels: t.levels, size: t.size,
      name: text(o.name, 32) || '', cat: CATS.includes(o.cat) ? o.cat : 'Other', desc: text(o.desc, 120), by: text(o.by, 24) || (free ? '' : 'A Chog holder'),
      state: free ? 'open' : 'closed', opened: free, rule: 'public', guests: [], bans: [], music: '', vipRule: 'public', vipGuests: [], locked: false, lastEntered: now(), createdAt: now() });
  }
  // one room per wallet, at the first free run of units. tier 0 = the free room (open, public); a higher tier starts a CLOSED venue.
  function create(addr, tier, o = {}) {
    if (byOwner.has(addr)) throw new Error('You already have a room.');
    const t = TEMPLATES[tier]; if (!t) throw new Error('You need a Chog to open a venue.');
    const v = newRecord(addr, tier, allocate(t.units, t.levels), o);
    if (tier && !v.name) v.name = 'My Venue';
    all.set(v.id, v); byOwner.set(addr, v); persist(v); return v;
  }

  // ---- the Homes from before the Hotel rooms (rooms/<wallet>.json) become free rooms: 20 x 15 m shifted into 14 x 10 m with the existing shiftDoc, what no longer fits goes to the inventory.
  // A wallet that already has a venue keeps it: its Home pieces go to the inventory. The Home file is moved to rooms_old/ so it is never read twice.
  {
    const homes = rooms.open(dataDir), hdir = path.join(dataDir, 'rooms'); let files = []; try { files = fs.readdirSync(hdir); } catch (e) { /* no Homes */ }
    for (const f of files) {
      const m = /^(0x[0-9a-f]{40})\.json$/.exec(f); if (!m) continue; const addr = m[1];
      try {
        const r = homes.get(addr); let doc = r && r.doc && Array.isArray(r.doc.pieces) ? r.doc : null; const dropped = [];
        if (doc && doc.pieces.length) {
          if (byOwner.has(addr)) dropped.push(...doc.pieces);
          else {
            const t = TEMPLATES[0], v = create(addr, 0, { name: doc.name && doc.name !== 'My Home' ? doc.name : '' }), lim = venueLim(v);
            const fit = fitDoc(rooms.shiftDoc(doc, r.sz || rooms.LIMITS.size, t.size), t.size, t, 0, { dropped, limit: lim.limit });
            docs.put(addr, { ...fit, name: doc.name }, lim);
          }
          stash(addr, dropped);
        } else if (!byOwner.has(addr) && doc) create(addr, 0, {});
        fs.mkdirSync(oldHomes, { recursive: true }); fs.renameSync(path.join(hdir, f), path.join(oldHomes, f));
      } catch (e) { /* the file stays where it is and is tried again on the next start */ }
    }
  }

  // refit a room to another size, tier and place: the record, the room documents (decor moves with it), the facade. What no longer fits goes to the inventory. A copy of the originals is kept.
  function reshape(v, tier, p) {
    const addr = v.addr, t = TEMPLATES[tier], oldSize = v.size, wasFrozen = v.state === 'frozen', prev = wasFrozen ? v.prevState : v.state;
    const r1 = docs.get(addr), r2 = docs2.get(addr), fr = facades.get(addr);
    writeJson(path.join(backDir, addr + '-' + now() + '.json'), { meta: JSON.parse(JSON.stringify(v)), venue: r1, venue2: r2, facade: fr, at: now() });
    Object.assign(v, { tier, floor: p.floor, unit: p.unit, units: t.units, levels: t.levels, size: t.size, frozenAt: null, lastEntered: now() }); place(v); delete v.prevState;
    if (tier && !v.name) { const dn = r1 && r1.doc && r1.doc.name; v.name = dn && dn !== 'My Home' && dn !== 'My Room' ? text(dn, 32) : nameOf(addr) ? nameOf(addr) + "'s venue" : 'My Venue'; }          // a room that was only named by its decor keeps that name as a venue
    if (!tier) { Object.assign(v, { state: 'open', opened: true, rule: 'public', vipRule: 'public', music: '' }); if (/^(My Venue|.* venue)$/.test(v.name || '') && /^(My Venue|.+'s venue)$/.test(v.name)) v.name = ''; }          // a free room is named after its owner again unless the name was their own choice
    else if (wasFrozen) v.state = 'closed';
    if (!t.vip) v.vipRule = 'public'; if (!t.music) v.music = '';
    persist(v);
    const lim = venueLim(v), dropped = [], ctx = { dropped, owns: lim.owns, limit: lim.limit };
    const refit = r => rooms.shiftDoc(r.doc, oldSize, t.size);
    if (r1 && r1.doc) docs.put(addr, fitDoc(sameSize(oldSize, t.size) ? r1.doc : refit(r1), t.size, t, tier, ctx), lim); else docs.drop(addr);
    if (r2 && r2.doc && t.levels > 1) docs2.put(addr, fitDoc(sameSize(oldSize, t.size) ? r2.doc : refit(r2), t.size, t, tier, ctx), lim);
    else { if (r2 && r2.doc) dropped.push(...(r2.doc.pieces || [])); docs2.drop(addr); }
    if (fr && fr.doc && t.facade) { const fl = facadeLim(v, t), W = fl.size[0]; facades.put(addr, { ...fr.doc, pieces: (fr.doc.pieces || []).filter(it => { const d = CAT.pieces[it.p]; return d && (d.minTier || 0) <= tier && Math.abs(it.x) + d.fp[0] / 2 <= W / 2 + 1e-6; }) }, fl); }
    else facades.drop(addr);
    stash(addr, dropped); return dropped.length;
  }
  const snap = v => ({ floor: v.floor, unit: v.unit, units: v.units || 1, levels: v.levels || 1, no: v.no, tier: v.tier });

  return {
    TEMPLATES, FACADE_DEPTH, CATS, RULES, MUSIC, UNIT_M, FREEZE_MS, BASEMENT_MS, facadeWidth,
    get: id => { const v = all.get(id); if (!v) return null; return v.addr ? { ...v, doc: (docs.get(v.addr) || {}).doc || null, doc2: (docs2.get(v.addr) || {}).doc || null } : v; },
    byOwner: addr => byOwner.get(addr) || null,
    // the holders: the wallets whose room asks for a license reading (free rooms do not)
    owners: () => [...byOwner.values()].filter(v => v.tier > 0).map(v => v.addr),
    count: () => all.size,
    floors: () => [...all.values()].reduce((n, v) => Math.max(n, v.floor > 0 ? v.floor + (v.levels || 1) - 1 : 0), 0),
    basement: () => [...all.values()].reduce((n, v) => Math.max(n, v.floor < 0 ? -v.floor : 0), 0),
    sizeOf, isFree, nameFor,
    // the public list: above ground only (the basement is for the elevator), holders and the game's venues first, free rooms below them; no room documents (visitors get one when they walk in);
    // a never-opened venue shows only that it is opening soon
    list: () => [...all.values()].filter(v => v.floor > 0).sort((a, b) => (isFree(a) ? 1 : 0) - (isFree(b) ? 1 : 0) || a.no - b.no).map(view),
    onFloor: floor => [...all.values()].filter(v => v.floor === floor).sort((a, b) => a.unit - b.unit).map(view),
    view,
    // the owner's own view of their room
    mine: addr => {
      const v = byOwner.get(addr); if (!v) return null; const t = TEMPLATES[v.tier], x = extraOf(v);
      return { ...view(v), name: nameFor(v), cat: v.cat, desc: v.desc, tier: v.tier, size: v.size, guests: v.guests, bans: v.bans, music: v.music || '', vipRule: v.vipRule || 'public', vipGuests: v.vipGuests || [], frozenAt: v.frozenAt || null, daysLeft: daysLeft(v),
        basement: v.floor < 0, hasDoc: !!docs.get(addr), hasDoc2: !!docs2.get(addr), hasFacade: !!facades.get(addr), facade: (facades.get(addr) || {}).doc || null, facadeSize: [facadeWidth(v), FACADE_DEPTH],
        template: { ...t, pieces: t.pieces + x.pieces, lights: t.lights + x.lights, extra: x } };
    },
    // create the room of a wallet (check-in makes the free one, tier 0). One per wallet.
    create, activate: (addr, tier, o) => create(addr, tier, o),
    // update: what the owner may change without a signature (name, kind, description, entry rule, lists, open or closed, music, VIP rule). A free room only has a name.
    update(addr, patch) {
      const v = byOwner.get(addr); if (!v) throw new Error('You have no room yet.');
      const t = TEMPLATES[v.tier];
      if (!v.tier) {
        for (const k of ['rule', 'guests', 'bans', 'music', 'vipRule', 'vipGuests', 'open']) if (patch[k] !== undefined && !(k === 'rule' && patch[k] === 'public') && !(Array.isArray(patch[k]) && !patch[k].length) && patch[k] !== '') throw new Error('You need a Chog venue for that. Ask at the reception about an upgrade.');
        if (patch.name !== undefined) v.name = text(patch.name, 32);
        if (patch.cat !== undefined && CATS.includes(patch.cat)) v.cat = patch.cat;
        if (patch.desc !== undefined) v.desc = text(patch.desc, 120);
        persist(v); return v;
      }
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
    // the free room takes the name of the saved document when the owner renamed it
    renamed(addr, name) { const v = byOwner.get(addr); if (v && isFree(v) && name && name !== 'My Home' && name !== 'My Room' && v.name !== name) { v.name = text(name, 32); persist(v); return true; } return false; },
    // lock or unlock the door: while locked only the owner gets in (people inside stay)
    setLocked(addr, on) { const v = byOwner.get(addr); if (!v) throw new Error('You have no room yet.'); if (!!v.locked === !!on) return v; v.locked = !!on; persist(v); return v; },
    docs, docs2, facades,
    // the room store of one level (1 = the entrance level, 2 = upstairs, only for tiers with two levels)
    store: (v, level) => (level === 2 ? docs2 : docs),
    limitsOf: v => venueLim(v),
    facadeLimits: v => facadeLim(v),
    lightsOf: v => (v.addr ? TEMPLATES[v.tier] : TEMPLATES[1]).lights + extraOf(v).lights,
    piecesOf: v => tplOf(v).pieces + extraOf(v).pieces,
    // the facades on one floor (small documents, sent when a player steps onto it)
    facadesOn: floor => [...all.values()].filter(v => v.floor === floor && v.addr && v.tier).map(v => { const f = facades.get(v.addr); return f ? { id: v.id, no: v.no, unit: v.unit, units: v.units, doc: f.doc } : null; }).filter(Boolean),
    // somebody walked into the room: it counts as visited (the 30 days of a free room start again)
    visited(id) { const v = all.get(id); if (!v || !v.addr) return; const stale = now() - (v.lastEntered || 0) > 3600e3; v.lastEntered = now(); if (stale) persist(v); },
    // can this player walk in? -> null (yes) or the guard's reason (usernames and the Chog they play come from the server's player record).
    // ctx: { level: 1 | 2 }
    entry(v, p, ctx = {}) {
      if (v.addr && v.addr === p.addr) return null;
      if (v.locked) return 'This room is locked by its owner.';
      if (v.state === 'frozen') return 'This venue is frozen right now.';
      if (v.state !== 'open') return v.opened ? 'This venue is closed right now.' : 'This venue is not open yet.';
      const u = (p.username || '').toLowerCase();
      if (u && (v.bans || []).includes(u)) return 'The guard turns you away.';
      if (v.rule === 'holders' && !p.token) return 'Holders only. Play as your Chog to come in.';
      if (v.rule === 'list' && !(u && (v.guests || []).includes(u))) return 'The guard checks the guest list. Your name is not on it.';
      if (ctx.level === 2 && vipOf(v) === 'holders' && !p.token) return 'The VIP lounge is for Chog holders. Play as your Chog to go up.';
      if (ctx.level === 2 && vipOf(v) === 'list' && !(u && (v.vipGuests || []).includes(u))) return 'The VIP lounge has a guest list. Your name is not on it.';
      return null;
    },

    // ---- holdings: the owner's tier against the venue's (called with a fresh chain reading). Returns what changed: 'frozen' | 'thawed' | 'expired' | null
    // 'expired': 7 days frozen, so the room shrinks to what the license gives (a free room when no Chog is left), keeping its first unit and freeing the rest
    reconcile(addr, tier) {
      const v = byOwner.get(addr); if (!v || !v.tier) return null;
      if (tier >= v.tier) { if (v.state !== 'frozen') return null; v.state = v.prevState === 'open' ? 'open' : 'closed'; v.frozenAt = null; delete v.prevState; persist(v); return 'thawed'; }
      if (v.state !== 'frozen') { v.prevState = v.state; v.state = 'frozen'; v.frozenAt = now(); persist(v); return 'frozen'; }
      if (now() - (v.frozenAt || 0) >= FREEZE_MS) { reshape(v, tier, validRun(v.unit, TEMPLATES[tier].units) ? { floor: v.floor, unit: v.unit } : allocate(TEMPLATES[tier].units, TEMPLATES[tier].levels, v)); return 'expired'; }
      return null;
    },
    // what the owner may be offered for this tier: a bigger room (the receptionist does it), or a move to a smaller one
    offerFor(addr, tier) {
      const v = byOwner.get(addr); if (!v) return null;
      return tier > v.tier ? { kind: 'upgrade', tier } : tier > 0 && tier < v.tier ? { kind: 'downsize', tier } : null;
    },
    // ask for the room of `tier`: it grows in place when the units next to it (and the floor above, where needed) are free, otherwise it moves to the first free run of the right length.
    // Returns { venue, from, moved }; throws a reason the player can read.
    upgrade(addr, tier) {
      const v = byOwner.get(addr); if (!v) throw new Error('You have no room yet. Check in at the reception first.');
      const t = TEMPLATES[tier]; if (!t || !tier) throw new Error('You need a Chog to upgrade your room.');
      if (tier === v.tier) throw new Error('Your room already is the biggest your Chogs allow.');
      if (tier < v.tier) throw new Error('Your room is bigger than your Chogs allow now.');
      const from = snap(v); let p = null;
      if (v.floor > 0 && validRun(v.unit, t.units)) {
        const used = occupied(v); let free = true;
        for (let l = 0; l < t.levels && free; l++) for (let i = 0; i < t.units; i++) if (used.has((v.floor + l) + ':' + (v.unit + i))) { free = false; break; }
        if (free) p = { floor: v.floor, unit: v.unit };
      }
      const moved = !p; if (!p) p = allocate(t.units, t.levels, v);
      reshape(v, tier, p); return { venue: v, from, moved };
    },
    // a lower tier: the venue shrinks to the room of that tier in place (same first unit)
    downsize(addr, tier) {
      const v = byOwner.get(addr); if (!v) throw new Error('You have no room yet.');
      const t = TEMPLATES[tier]; if (!t || !tier || tier >= v.tier) throw new Error('Your venue already fits your tier.');
      const from = snap(v); reshape(v, tier, validRun(v.unit, t.units) ? { floor: v.floor, unit: v.unit } : allocate(t.units, t.levels, v));
      return { venue: v, from, moved: false };
    },
    // a free room from the basement goes back up: first free unit, or a new top floor
    reactivate(addr) {
      const v = byOwner.get(addr); if (!v) throw new Error('You have no room yet.');
      if (v.floor >= 0) throw new Error('Your room is not in the basement.');
      const from = snap(v), p = allocate(v.units, v.levels, v); Object.assign(v, { floor: p.floor, unit: p.unit, lastEntered: now() }); place(v); persist(v);
      return { venue: v, from, moved: true };
    },
    // free rooms nobody entered for 30 days move to the basement (`busy(room)` = somebody is inside right now); run at start and every day
    sweepBasement(busy) {
      const moved = [];
      for (const v of [...byOwner.values()]) {
        if (v.tier || v.floor < 0 || now() - (v.lastEntered || v.createdAt || 0) < BASEMENT_MS || (busy && busy(v))) continue;
        const from = snap(v), p = allocateBasement(v); Object.assign(v, { floor: p.floor, unit: p.unit }); place(v); persist(v); moved.push({ addr: v.addr, id: v.id, from, no: v.no });
      }
      return moved;
    },
  };
}
module.exports = { open, TEMPLATES, CATS, RULES, MUSIC, UNIT_M, FACADE_DEPTH, FREEZE_MS, BASEMENT_MS, fitDoc, validRun, noOf };
