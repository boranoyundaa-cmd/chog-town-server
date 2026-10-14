'use strict';
// Venue records from the first hotel numbering (8 small slots per floor, smaller rooms) move into the new one on load.  Run: node test/migrate.js (part of npm test)
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chog-migrate-')), meta = path.join(dir, 'venue_meta'); fs.mkdirSync(meta, { recursive: true });
const rec = (n, tier, floor, no, span, createdAt) => ({ id: 'h' + n, addr: '0x' + String(n).repeat(40), tier, floor, no, span, size: [11, 8], name: 'Old ' + n, cat: 'Club', desc: '', by: 'x', state: 'open', opened: true, rule: 'public', guests: [], bans: [], createdAt });
for (const r of [rec(1, 2, 1, 105, 2, 100), rec(2, 4, 2, 201, 3, 200)]) fs.writeFileSync(path.join(meta, r.addr + '.json'), JSON.stringify(r));
let n = 0; const ok = name => console.log(`  ok ${++n} ${name}`);
const h = require('../hotel').open(dir);
const a = h.byOwner('0x' + '1'.repeat(40)), b = h.byOwner('0x' + '2'.repeat(40));
assert.equal(a.no, 401); assert.equal(a.span, 2); assert.equal(a.levels, 1); assert.deepEqual(a.size, [27, 20]); ok('an old tier 2 venue gets a whole wall in the new numbering (after the seed venues) and the tier 2 room');
assert.equal(b.no, 501); assert.equal(b.span, 4); assert.equal(b.levels, 2); assert.deepEqual(b.size, [33, 22]); assert.equal(h.floors(), 6); ok('an old tier 4 venue gets the whole floor above it and the one over that; the tower is 6 floors');
assert.equal(a.name, 'Old 1'); assert.equal(a.state, 'open'); ok('name, state and the rest are kept');
const again = require('../hotel').open(dir); assert.equal(again.byOwner(a.addr).no, 401); assert.equal(again.byOwner(b.addr).no, 501); ok('a second start keeps the new numbers (nothing moves twice)');
// ---- the enlargement of 2026-10-15 (Home 13 x 10 -> 20 x 15, venues 15x11 / 18x13 / 22x15 -> 22x16 / 27x20 / 33x22): saved rooms keep their place against the back walls
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'chog-grow-')), AD = '0x' + 'a'.repeat(40), AH = '0x' + 'b'.repeat(40);
for (const d of ['venue_meta', 'venue_docs', 'venue2_docs', 'rooms']) fs.mkdirSync(path.join(dir2, d), { recursive: true });
const wr = (sub, addr, o) => fs.writeFileSync(path.join(dir2, sub, addr + '.json'), JSON.stringify(o));
const oldDoc = { name: 'Old', theme: 'studio', pieces: [{ p: 'sofa', x: -5, z: -3.5 }, { p: 'wallArt', x: 2, z: -6.5 }, { p: 'wallArt', x: -9, z: 1, ry: 90 }] };           // a tier 3 room (18 x 13): north wall z = -6.5, west wall x = -9
wr('venue_meta', AD, { id: 'hold', addr: AD, tier: 3, layout: 2, floor: 1, no: 101, span: 2, levels: 2, size: [18, 13], name: 'Grown', cat: 'Club', desc: '', by: 'x', state: 'open', opened: true, rule: 'public', guests: [], bans: [], createdAt: 1 });
wr('venue_docs', AD, { addr: AD, doc: oldDoc, hash: 'h', sig: '0xsig', ts: 1, savedAt: 1 }); wr('venue2_docs', AD, { addr: AD, doc: oldDoc, hash: 'h', sig: '0xsig', ts: 1, savedAt: 1 });
wr('rooms', AH, { addr: AH, doc: { name: 'My Home', theme: 'studio', pieces: [{ p: 'bed', x: -4, z: -2.5, ry: 90 }, { p: 'sofa', x: 3, z: 1 }, { p: 'wallArt', x: 1, z: -5 }] }, hash: 'h', sig: '0xsig', ts: 1, savedAt: 1 });      // a Home (13 x 10)
const gh = require('../hotel').open(dir2), v = gh.byOwner(AD), docOf = r => r.doc.pieces.map(q => [q.p, q.x, q.z, q.ry || 0]);
assert.deepEqual(v.size, [27, 20]); ok('a venue still in its old room gets the tier\'s new size');
const vrec = require('../rooms').open(dir2, 'venue_docs', 'venue').get(AD);
assert.deepEqual(docOf(vrec), [['sofa', -9.5, -7, 0], ['wallArt', -2.5, -10, 0], ['wallArt', -13.5, -2.5, 90]]); assert.equal(vrec.refit, true); assert.equal(vrec.sig, null); assert.deepEqual(vrec.sz, [27, 20]); ok('its room document is shifted: floor pieces keep their distance from the back corner, wall pieces stay on their (new) wall');
assert.deepEqual(docOf(require('../rooms').open(dir2, 'venue2_docs', 'venue').get(AD)), docOf(vrec)); ok('the upper level is shifted the same way');
const home = require('../rooms').open(dir2).get(AH);
assert.deepEqual(docOf(home), [['bed', -7.5, -5, 90], ['sofa', -0.5, -1.5, 0], ['wallArt', -2.5, -7.5, 0]]); assert.equal(home.sig, null); assert.deepEqual(home.sz, [20, 15]); ok('a saved Home (13 x 10) is shifted into the 20 x 15 floor on first read');
require('../hotel').open(dir2); assert.deepEqual(docOf(require('../rooms').open(dir2, 'venue_docs', 'venue').get(AD)), docOf(vrec)); assert.deepEqual(docOf(require('../rooms').open(dir2).get(AH)), docOf(home)); ok('a second start moves nothing again');
const cl = require('../rooms').sanitize({ name: 'x', pieces: [{ p: 'pendantLamp', x: 1, z: 1 }, { p: 'ceilingNeon', x: 2, z: 2 }, { p: 'sofa', x: 0, z: 0 }] }); assert.deepEqual(cl.pieces.map(q => q.p), ['sofa']); ok('saved rooms with the removed ceiling lamps still load: those pieces are dropped, the rest stays');
fs.rmSync(dir2, { recursive: true, force: true });
fs.rmSync(dir, { recursive: true, force: true }); console.log(`\nall ${n} migration checks passed`);
