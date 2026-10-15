'use strict';
// The wall units on their own (no server): runs on one wall, first fit, new floors on top, the basement filling downward, reactivate.  Run: node test/units.js (part of npm test)
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const hotelLib = require('../hotel');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chog-units-')); let t = 1e12; const DAY = 86400e3;
const h = hotelLib.open(dir, { now: () => t }), A = i => '0x' + String(i).padStart(8, '0') + '0'.repeat(32);
let n = 0; const ok = name => console.log(`  ok ${++n} ${name}`);
const { validRun } = hotelLib;
assert(validRun(1, 4) && validRun(5, 4) && !validRun(3, 4) && !validRun(2, 4) && validRun(1, 8) && !validRun(5, 8) && validRun(3, 2) && !validRun(4, 2) && validRun(7, 2) && validRun(4, 1) && validRun(5, 1) && !validRun(8, 2)); ok('runs sit on one wall: units 1-4 north, 5-8 west; a whole wall starts at 1 or 5; the whole floor is 8 units');
assert.equal(hotelLib.noOf(4, 3), 403); assert.equal(hotelLib.noOf(-1, 3), -103); assert.equal(hotelLib.noOf(-12, 8), -1208); ok('door numbers: floor x 100 + first unit; the basement counts down (B1 unit 3 is -103)');
const rooms = []; for (let i = 1; i <= 8; i++) rooms.push(h.create(A(i), 0, {}));
assert.deepEqual(rooms.map(r => r.no), [401, 402, 403, 404, 405, 406, 407, 408]); ok('eight free rooms fill the eight units of floor 4');
const ninth = h.create(A(9), 0, {}); assert.equal(ninth.no, 501); assert.equal(h.floors(), 5); ok('the ninth goes on a new floor on top (501)');
assert.throws(() => h.create(A(1), 0, {}), /already/); ok('one room per wallet');
// upgrade rules: a Fren needs a free wall; with units 1-4 taken by free rooms it moves to the next wall, then a new floor
let u = h.upgrade(A(5), 2); assert(u.moved && u.venue.no === 505 && u.venue.units === 4 && u.from.no === 405); ok('a Fren room next to taken units moves to the first free whole wall (the west wall of floor 5; the ninth room holds unit 1 of its north wall)');
u = h.upgrade(A(9), 1); assert(!u.moved && u.venue.no === 501 && u.venue.units === 2); ok('a Ser room grows in place when the next unit is free');
u = h.upgrade(A(3), 1); assert(u.moved && u.venue.no === 503 && u.venue.units === 2 && u.from.no === 403); ok('a Ser room with a neighbour moves to the first run of 2 units that is free (503, 504)');
assert.throws(() => h.upgrade(A(3), 1), /biggest/); assert.throws(() => h.upgrade(A(3), 0), /need a Chog/); assert.throws(() => h.upgrade(A(99), 1), /no room/); ok('the reasons: at the maximum, no Chog, no room');
// shrink in place keeps the first unit
const d = h.downsize(A(5), 1); assert.equal(d.venue.no, 505); assert.equal(d.venue.units, 2); ok('a smaller tier shrinks in place: the door number stays, the rest is freed');
// basement: idle free rooms fill B1 first, then B2
const idle = []; for (let i = 10; i <= 20; i++) idle.push(h.create(A(i), 0, {}));      // eleven more rooms, then nobody goes in
t += 31 * DAY; for (const i of [1, 2, 4, 6, 7, 8]) h.visited(h.byOwner(A(i)).id);       // 3, 5 and 9 are holders; these six were visited just now
const moved = h.sweepBasement();
assert.deepEqual(moved.map(m => m.addr).sort(), idle.map(r => r.addr).sort()); ok('the sweep moves exactly the free rooms nobody entered for 30 days (holders and visited rooms stay)');
assert.deepEqual(moved.map(m => m.no), [-101, -102, -103, -104, -105, -106, -107, -108, -201, -202, -203]); assert.equal(h.basement(), 2); ok('they fill B1 first (-101 to -108), then B2 (-201...): first fit, floors added downward');
assert.equal(h.list().filter(v => v.floor < 0).length, 0); assert.equal(h.onFloor(-1).length, 8); assert.equal(h.onFloor(-2).length, 3); ok('the public list leaves the basement out; the floor view has its rooms');
assert.equal(h.byOwner(A(1)).no, 401); assert.equal(h.byOwner(A(5)).no, 505); ok('the other door numbers did not move');
const back = h.reactivate(moved[0].addr); assert(back.venue.no === 403 && back.moved && back.from.no === -101); assert.throws(() => h.reactivate(moved[0].addr), /not in the basement/); ok('reactivate moves a room back up to the first free unit (403, left by the Ser that moved), and only once');
const nos = new Set([back.venue.no]); for (let i = 11; i <= 20; i++) { const r = h.reactivate(A(i)); assert(r.venue.no > 0 && !nos.has(r.venue.no)); nos.add(r.venue.no); } assert.equal(h.basement(), 0); ok('everybody comes back to a free unit or a new floor on top, with unique door numbers');
// a busy room is not moved; a room entered recently is not moved
t += 31 * DAY; h.visited(h.byOwner(A(1)).id); const busyId = back.venue.id; const none = h.sweepBasement(v => v.id === busyId); assert(!none.some(m => m.addr === back.venue.addr)); ok('a room with somebody inside stays up');
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nall ${n} unit checks passed`);
