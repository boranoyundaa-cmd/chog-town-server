'use strict';
// Records and documents from earlier versions move into the current model on load: the first hotel numbering, the slot numbering (4 slots of 10 m) becomes wall units (8 of 5 m),
// venues and Homes from before the enlargement get their size, and every old Home becomes a free room.  Run: node test/migrate.js (part of npm test)
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const hotelLib = require('../hotel'), roomsLib = require('../rooms'), inventoryLib = require('../inventory');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chog-migrate-')), meta = path.join(dir, 'venue_meta'); fs.mkdirSync(meta, { recursive: true });
const rec = (n, tier, floor, no, span, createdAt) => ({ id: 'h' + n, addr: '0x' + String(n).repeat(40), tier, floor, no, span, size: [11, 8], name: 'Old ' + n, cat: 'Club', desc: '', by: 'x', state: 'open', opened: true, rule: 'public', guests: [], bans: [], createdAt });
for (const r of [rec(1, 2, 1, 105, 2, 100), rec(2, 4, 2, 201, 3, 200)]) fs.writeFileSync(path.join(meta, r.addr + '.json'), JSON.stringify(r));
let n = 0; const ok = name => console.log(`  ok ${++n} ${name}`);
const h = hotelLib.open(dir);
const a = h.byOwner('0x' + '1'.repeat(40)), b = h.byOwner('0x' + '2'.repeat(40));
assert.equal(a.no, 401); assert.equal(a.units, 4); assert.equal(a.levels, 1); assert.deepEqual(a.size, [27, 20]); ok('an old tier 2 venue gets a whole wall in the new numbering (after the seed venues) and the tier 2 room');
assert.equal(b.no, 501); assert.equal(b.units, 8); assert.equal(b.levels, 2); assert.deepEqual(b.size, [33, 22]); assert.equal(h.floors(), 6); ok('an old tier 4 venue gets the whole floor above it and the one over that; the tower is 6 floors');
assert.equal(a.name, 'Old 1'); assert.equal(a.state, 'open'); ok('name, state and the rest are kept');
const again = hotelLib.open(dir); assert.equal(again.byOwner(a.addr).no, 401); assert.equal(again.byOwner(b.addr).no, 501); ok('a second start keeps the new numbers (nothing moves twice)');
const seedNos = h.list().filter(v => !v.by.includes('x') && v.id.startsWith('v')).map(v => v.no);
assert.deepEqual(seedNos.slice(0, 6), [101, 103, 105, 107, 201, 203]); assert(h.list().filter(v => v.id.startsWith('v')).every(v => v.units === 2)); ok('the 12 seed venues move from slots to units: slot s becomes units 2s-1 and 2s (101, 103, 105, 107, 201...)');

// ---- the slot numbering (2026-10-15 morning): old slot s becomes units 2s-1 and 2s, the span doubles, nothing leaves its floor or wall
const dirU = fs.mkdtempSync(path.join(os.tmpdir(), 'chog-units-')), metaU = path.join(dirU, 'venue_meta'); fs.mkdirSync(metaU, { recursive: true });
const slot = (n, tier, floor, no, span) => Object.assign(rec(n, tier, floor, no, span, n), { layout: 2, levels: tier >= 3 ? 2 : 1, size: hotelLib.TEMPLATES[tier].size });
for (const r of [slot(3, 1, 4, 402, 1), slot(4, 1, 4, 403, 1), slot(5, 2, 5, 501, 2), slot(6, 2, 5, 503, 2), slot(7, 4, 6, 601, 4)]) fs.writeFileSync(path.join(metaU, r.addr + '.json'), JSON.stringify(r));
const hu = hotelLib.open(dirU), at = k => hu.byOwner('0x' + String(k).repeat(40));
assert.deepEqual([3, 4, 5, 6, 7].map(k => [at(k).floor, at(k).unit, at(k).units, at(k).no]), [[4, 3, 2, 403], [4, 5, 2, 405], [5, 1, 4, 501], [5, 5, 4, 505], [6, 1, 8, 601]]); ok('slot venues keep their floor and wall: slot 2 span 1 is units 3-4 (door 403), slot 3 is units 5-6 (405), a whole wall is units 1-4 or 5-8, the whole floor is 8 units');
assert.equal(at(7).levels, 2); assert.equal(hotelLib.open(dirU).byOwner(at(4).addr).no, 405); ok('levels are kept and a second start does not move anything again');
const nu = hu.create('0x' + '9'.repeat(40), 0); assert.equal(nu.floor, 4); assert.equal(nu.unit, 1); ok('a new free room takes the first free unit (floor 4, unit 1: the units before the migrated venue were never used)');

// ---- the enlargement of 2026-10-15 (Home 13 x 10 -> 20 x 15, venues 15x11 / 18x13 / 22x15 -> 22x16 / 27x20 / 33x22): saved rooms keep their place against the back walls;
// and then every Home becomes a free room (14 x 10 m, 80 pieces) with the pieces that no longer fit in the inventory
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chog-grow-')), AD = '0x' + 'a'.repeat(40), AH = '0x' + 'b'.repeat(40), AF = '0x' + 'c'.repeat(40), AV = '0x' + 'd'.repeat(40);
for (const d of ['venue_meta', 'venue_docs', 'venue2_docs', 'rooms']) fs.mkdirSync(path.join(dir2, d), { recursive: true });
const wr = (sub, addr, o) => fs.writeFileSync(path.join(dir2, sub, addr + '.json'), JSON.stringify(o));
const oldDoc = { name: 'Old', theme: 'studio', pieces: [{ p: 'sofa', x: -5, z: -3.5 }, { p: 'wallArt', x: 2, z: -6.5 }, { p: 'wallArt', x: -9, z: 1, ry: 90 }] };           // a tier 3 room (18 x 13): north wall z = -6.5, west wall x = -9
wr('venue_meta', AD, { id: 'hold', addr: AD, tier: 3, layout: 2, floor: 4, no: 401, span: 2, levels: 2, size: [18, 13], name: 'Grown', cat: 'Club', desc: '', by: 'x', state: 'open', opened: true, rule: 'public', guests: [], bans: [], createdAt: 1 });
wr('venue_docs', AD, { addr: AD, doc: oldDoc, hash: 'h', sig: '0xsig', ts: 1, savedAt: 1 }); wr('venue2_docs', AD, { addr: AD, doc: oldDoc, hash: 'h', sig: '0xsig', ts: 1, savedAt: 1 });
wr('rooms', AH, { addr: AH, doc: { name: 'My Home', theme: 'studio', pieces: [{ p: 'bed', x: -4, z: -2.5, ry: 90 }, { p: 'sofa', x: 3, z: 1 }, { p: 'wallArt', x: 1, z: -5 }] }, hash: 'h', sig: '0xsig', ts: 1, savedAt: 1 });      // a Home (13 x 10)
const big = Array.from({ length: 100 }, (_, i) => ({ p: 'plant', x: -9 + (i % 11), z: -6 + 0.8 * Math.floor(i / 11) }));            // 100 pieces on a 20 x 15 floor that all still lie inside 14 x 10 after the shift: over the free room's 80
wr('rooms', AF, { addr: AF, doc: { name: 'Greenhouse', theme: 'studio', pieces: big }, hash: 'h', sig: '0xsig', ts: 1, savedAt: 1, sz: [20, 15] });
wr('rooms', AV, { addr: AV, doc: { name: 'Old home of a holder', theme: 'studio', pieces: [{ p: 'sofa', x: 0, z: 0 }, { p: 'plant', x: 2, z: 2 }] }, hash: 'h', sig: '0xsig', ts: 1, savedAt: 1, sz: [20, 15] });
wr('venue_meta', AV, { id: 'hv', addr: AV, tier: 1, layout: 3, floor: 7, unit: 1, units: 2, no: 701, levels: 1, size: [22, 16], name: 'Holder', cat: 'Club', desc: '', by: 'x', state: 'open', opened: true, rule: 'public', guests: [], bans: [], createdAt: 1 });
const inv = inventoryLib.open(dir2), gh = hotelLib.open(dir2, { inventory: inv }), v = gh.byOwner(AD), docOf = r => r.doc.pieces.map(q => [q.p, q.x, q.z, q.ry || 0]);
assert.deepEqual(v.size, [27, 20]); assert.equal(v.no, 401); assert.equal(v.units, 4); ok('a venue still in its old room gets the tier\'s new size (and its units)');
const vrec = roomsLib.open(dir2, 'venue_docs', 'venue').get(AD);
assert.deepEqual(docOf(vrec), [['sofa', -9.5, -7, 0], ['wallArt', -2.5, -10, 0], ['wallArt', -13.5, -2.5, 90]]); assert.equal(vrec.refit, true); assert.equal(vrec.sig, null); assert.deepEqual(vrec.sz, [27, 20]); ok('its room document is shifted: floor pieces keep their distance from the back corner, wall pieces stay on their (new) wall');
assert.deepEqual(docOf(roomsLib.open(dir2, 'venue2_docs', 'venue').get(AD)), docOf(vrec)); ok('the upper level is shifted the same way');
const fh = gh.byOwner(AH); assert(fh && !fh.tier && fh.state === 'open' && fh.units === 1 && fh.levels === 1); assert.deepEqual(fh.size, [14, 10]); ok('a saved Home becomes a free room: tier 0, one unit, 14 x 10 m');
const homeRec = roomsLib.open(dir2, 'venue_docs', 'venue').get(AH);
assert.deepEqual(docOf(homeRec), [['bed', -4.5, -2.5, 90], ['sofa', 2.5, 1, 0], ['wallArt', 0.5, -5, 0]]); assert.deepEqual(homeRec.sz, [14, 10]); ok('its pieces keep their place against the back walls (the old 13 x 10 Home was shifted into 20 x 15 first, then into 14 x 10)');
assert(!fs.existsSync(path.join(dir2, 'rooms', AH + '.json')) && fs.existsSync(path.join(dir2, 'rooms_old', AH + '.json'))); ok('the Home file is moved to rooms_old, so it is never read twice');
const gr = roomsLib.open(dir2, 'venue_docs', 'venue').get(AF); assert.equal(gr.doc.pieces.length, 80); assert.equal(gh.byOwner(AF).name, 'Greenhouse');
const stored = inv.get(AF); assert.equal(stored.length, 20); assert(stored.every(x => x.p === 'plant')); ok('a Home over the free budget keeps 80 pieces; the other 20 are in the inventory');
const vs = inv.get(AV); assert.deepEqual(vs.map(x => x.p), ['sofa', 'plant']); assert.equal(gh.byOwner(AV).tier, 1); ok('a wallet that already has a venue keeps it: its old Home pieces go to the inventory');
hotelLib.open(dir2, { inventory: inv }); assert.deepEqual(docOf(roomsLib.open(dir2, 'venue_docs', 'venue').get(AD)), docOf(vrec)); assert.deepEqual(docOf(roomsLib.open(dir2, 'venue_docs', 'venue').get(AH)), docOf(homeRec)); assert.equal(inv.get(AF).length, 20); ok('a second start moves nothing again');
const cl = roomsLib.sanitize({ name: 'x', pieces: [{ p: 'pendantLamp', x: 1, z: 1 }, { p: 'ceilingNeon', x: 2, z: 2 }, { p: 'sofa', x: 0, z: 0 }] }); assert.deepEqual(cl.pieces.map(q => q.p), ['sofa']); ok('saved rooms with the removed ceiling lamps still load: those pieces are dropped, the rest stays');
for (const d of [dir, dirU, dir2]) fs.rmSync(d, { recursive: true, force: true });
console.log(`\nall ${n} migration checks passed`);
