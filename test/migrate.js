'use strict';
// Venue records from the first hotel numbering (8 small slots per floor, smaller rooms) move into the new one on load.  Run: node test/migrate.js (part of npm test)
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chog-migrate-')), meta = path.join(dir, 'venue_meta'); fs.mkdirSync(meta, { recursive: true });
const rec = (n, tier, floor, no, span, createdAt) => ({ id: 'h' + n, addr: '0x' + String(n).repeat(40), tier, floor, no, span, size: [11, 8], name: 'Old ' + n, cat: 'Club', desc: '', by: 'x', state: 'open', opened: true, rule: 'public', guests: [], bans: [], createdAt });
for (const r of [rec(1, 2, 1, 105, 2, 100), rec(2, 4, 2, 201, 3, 200)]) fs.writeFileSync(path.join(meta, r.addr + '.json'), JSON.stringify(r));
let n = 0; const ok = name => console.log(`  ok ${++n} ${name}`);
const h = require('../hotel').open(dir);
const a = h.byOwner('0x' + '1'.repeat(40)), b = h.byOwner('0x' + '2'.repeat(40));
assert.equal(a.no, 401); assert.equal(a.span, 2); assert.equal(a.levels, 1); assert.deepEqual(a.size, [18, 13]); ok('an old tier 2 venue gets a whole wall in the new numbering (after the seed venues) and the tier 2 room');
assert.equal(b.no, 501); assert.equal(b.span, 4); assert.equal(b.levels, 2); assert.deepEqual(b.size, [22, 15]); assert.equal(h.floors(), 6); ok('an old tier 4 venue gets the whole floor above it and the one over that; the tower is 6 floors');
assert.equal(a.name, 'Old 1'); assert.equal(a.state, 'open'); ok('name, state and the rest are kept');
const again = require('../hotel').open(dir); assert.equal(again.byOwner(a.addr).no, 401); assert.equal(again.byOwner(b.addr).no, 501); ok('a second start keeps the new numbers (nothing moves twice)');
fs.rmSync(dir, { recursive: true, force: true }); console.log(`\nall ${n} migration checks passed`);
