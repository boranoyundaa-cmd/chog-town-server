'use strict';
// Rooms for everyone: check-in (a free room per wallet), wall units, upgrades (in place and by moving), lock, holder venues (signed room and facade, entry rules, music, VIP),
// freeze and fall back to a free room, downsize, inventory, basement, hotel numbers, the Exhibition entry.  Run: node test/venues.js (part of npm test)
process.env.PORT = '18777'; process.env.ROOM_PREP_MS = '50'; process.env.ROOM_SAVE_MS = '50'; process.env.VENUE_MS = '60'; process.env.HOTELINFO_MS = '300'; process.env.CHECKIN_IP_MAX = '8';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'chog-venues-' + process.pid);
process.env.RPC_URL = 'http://127.0.0.1:18778'; process.env.MAX_PER_IP = '80';
const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { Wallet } = require('ethers');
const { server, clock, hotel: hotelRec, sweepVenues, sweepBasement, hotelInfo } = require('../index');
const W4 = Wallet.createRandom(), W1 = Wallet.createRandom(), NONE = Wallet.createRandom(), GUEST = Wallet.createRandom(), W2 = Wallet.createRandom(), W3 = Wallet.createRandom(), W5 = Wallet.createRandom(), W6 = Wallet.createRandom(), W7 = Wallet.createRandom();
const HOLD = { 561: W4, 1: W1, 61: W2, 70: W3, 196: W5 };                 // 561 is a Legendary (12 points, tier 4), 1 an Uncommon (1 point, tier 1), 61 a Rare (3 points, tier 2), 70 and 196 Epics (5 points, tier 3)
let rpcCalls = 0;
const chain = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    const answer = q => {
      rpcCalls++; const d = q.params[0].data;
      if (d.startsWith('0x70a08231')) { const a = '0x' + d.slice(-40); return Object.values(HOLD).filter(w => w.address.toLowerCase() === a).length; }
      const tok = parseInt(d.slice(10), 16), w = HOLD[tok]; return w ? w.address.toLowerCase() : '0x' + '1'.repeat(40);
    };
    const one = q => { const v = answer(q); return { jsonrpc: '2.0', id: q.id, result: '0x' + (typeof v === 'number' ? v.toString(16) : v.slice(2)).padStart(64, '0') }; };
    const q = JSON.parse(body); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  });
});
const URL = 'ws://127.0.0.1:' + process.env.PORT;
function client() {
  const ws = new WebSocket(URL), c = { ws, got: [], send: m => ws.send(JSON.stringify(m)), waiters: [] };
  ws.on('message', d => { const m = JSON.parse(d); c.got.push(m); c.waiters.slice().forEach(w => w(m)); });
  c.wait = (pred, ms = 6000) => new Promise((res, rej) => {
    const hit = c.got.find(pred); if (hit) return res(hit);
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + pred)), ms);
    const w = m => { if (pred(m)) { clearTimeout(t); c.waiters.splice(c.waiters.indexOf(w), 1); res(m); } }; c.waiters.push(w);
  });
  c.open = new Promise(r => ws.on('open', r));
  return c;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = name => console.log(`  ok ${++n} ${name}`);
async function login(w) { const c = client(); await c.open; const wc = await c.wait(m => m.t === 'welcome'); c.id = wc.id; c.send({ t: 'auth', sig: await w.signMessage(wc.challenge) }); await c.wait(m => m.t === 'authed'); return c; }
const doc = (name, pieces) => ({ name, theme: 'studio', pieces });
const idOf = w => 'h' + w.address.toLowerCase().slice(2, 10);
async function sign(c, w, kind, d, level) {              // prep, sign, save: returns the saved message (level 2 = the upper room of a two-level venue)
  await sleep(80); c.got.length = 0; c.send({ t: kind + 'prep', doc: d, level }); const pr = await c.wait(m => m.t === kind + 'prep' || m.t === 'roomfail');
  if (pr.t === 'roomfail') return pr; await sleep(80); c.got.length = 0;
  c.send({ t: kind + 'save', doc: d, ts: pr.ts, sig: await w.signMessage(pr.message), level }); return c.wait(m => m.t === kind + 'saved' || m.t === 'roomfail');
}
async function checkin(c, w) { await sleep(80); c.got.length = 0; c.send({ t: 'checkinprep' }); const pr = await c.wait(m => m.t === 'checkinprep' || m.t === 'roomfail'); if (pr.t === 'roomfail') return pr; await sleep(80); c.got.length = 0; c.send({ t: 'checkin', ts: pr.ts, sig: await w.signMessage(pr.message) }); return c.wait(m => m.t === 'checkin' || m.t === 'roomfail'); }
async function ask(c, msg, type) { await sleep(90); c.got.length = 0; c.send(msg); return c.wait(m => m.t === (type || msg.t) || m.t === 'roomfail'); }
async function enter(c, id, level) { await sleep(450); c.got.length = 0; c.send({ t: 'enter', space: 'venue', id, level, x: 0, z: 0, ry: 0 }); return c.wait(m => m.t === 'entered' || m.t === 'roomfail'); }
const hotelList = async c => { c.got.length = 0; c.send({ t: 'hotelinfo' }); return c.wait(m => m.t === 'hotel'); };
const mineOf = w => hotelRec.mine(w.address.toLowerCase());

(async () => {
  await new Promise(r => chain.listen(18778, r)); await new Promise(r => server.listen(+process.env.PORT, r));
  const T4 = await login(W4), T1 = await login(W1), N = await login(NONE), T2 = await login(W2), T3 = await login(W3), T5 = await login(W5), T6 = await login(W6);
  const G = await login(GUEST), town = client(); await town.open; await town.wait(m => m.t === 'welcome');

  // ---------- the license
  await sleep(80); T4.send({ t: 'venueinfo' }); const i4 = await T4.wait(m => m.t === 'venueinfo'); assert.equal(i4.tier, 4); assert.equal(i4.mine, null); assert.equal(i4.templates[0].pieces, 80); ok('the license is read from the chain: a Legendary is tier 4');
  await sleep(80); T1.send({ t: 'venueinfo' }); assert.equal((await T1.wait(m => m.t === 'venueinfo')).tier, 1); ok('an Uncommon is tier 1');
  await sleep(80); N.send({ t: 'venueinfo' }); assert.equal((await N.wait(m => m.t === 'venueinfo')).tier, 0); ok('a wallet without a Chog has tier 0');
  const guest = client(); await guest.open; await guest.wait(m => m.t === 'welcome'); guest.send({ t: 'venueinfo' }); await sleep(300); assert(!guest.got.some(m => m.t === 'venueinfo')); ok('a guest cannot ask for a license');
  const calls = rpcCalls; await sleep(80); T4.got.length = 0; T4.send({ t: 'venueinfo' }); await T4.wait(m => m.t === 'venueinfo'); assert.equal(rpcCalls, calls); ok('the license is cached (no new chain calls)');

  // ---------- check-in: every wallet gets a free room at the first free unit; a Fren can grow in place
  let r = await ask(G, { t: 'upgrade' }); assert(!r.ok && r.code === 'no-room'); ok('without a room there is nothing to upgrade');
  const c2 = await checkin(T2, W2); assert(c2.ok && c2.no === 401 && c2.mine.units === 1); ok('check-in gives a free room at the first free unit: door 401 (floor 4, unit 1; floors 1 to 3 are the game\'s own)');
  r = await ask(T2, { t: 'upgrade' }); assert(r.ok && !r.moved && r.no === 401 && r.tier === 2 && r.from.no === 401); assert.equal(r.mine.units, 4); assert.deepEqual(r.mine.size, [27, 20]); ok('a Fren room grows in place when units 2 to 4 are free: same door, 4 units, 27 x 20 m');
  const c4 = await checkin(T4, W4), c1 = await checkin(T1, W1), c0 = await checkin(N, NONE), c3 = await checkin(T3, W3), c5 = await checkin(T5, W5);
  assert.deepEqual([c4.no, c1.no, c0.no, c3.no, c5.no], [405, 406, 407, 408, 501]); ok('later check-ins take the next free units, and a new floor on top when floor 4 is full (405, 406, 407, 408, then 501)');
  r = await ask(T2, { t: 'upgrade' }); assert(!r.ok && r.code === 'max' && /Fren/.test(r.reason)); ok('asking again at the same tier says why not (already a Fren room)');
  r = await ask(N, { t: 'upgrade' }); assert(!r.ok && r.code === 'tier-low' && /need a Chog/.test(r.reason)); ok('a wallet without a Chog cannot upgrade: tier too low');

  // ---------- upgrades
  r = await ask(T5, { t: 'upgrade' }); assert(r.ok && !r.moved && r.no === 501 && r.tier === 3); assert.equal(r.mine.units, 4); assert.equal(r.mine.levels, 2); ok('a Whale room grows in place with the floor above when both are free (door 501 stays)');
  r = await ask(T1, { t: 'upgrade' }); assert(r.ok && r.moved && r.from.no === 406 && r.no === 505 && r.tier === 1); assert.equal(r.mine.units, 2); ok('a Ser room whose neighbour unit is taken moves to the first free run of 2 units on one wall: 406 -> 505');
  r = await ask(T3, { t: 'upgrade' }); assert(r.ok && r.moved && r.from.no === 408 && r.no === 605); assert.equal(r.mine.levels, 2); ok('a Whale room that cannot grow moves to the first free 4-unit wall with the floor above free: 408 -> 605');
  r = await ask(T4, { t: 'upgrade' }); assert(r.ok && r.moved && r.from.no === 405 && r.no === 801 && r.mine.units === 8 && r.mine.levels === 2); assert.deepEqual(r.mine.size, [33, 22]); ok('a Legend room takes a whole floor and the one above: the penthouse goes over every smaller room (801)');
  r = await ask(T4, { t: 'upgrade' }); assert(!r.ok && r.code === 'max' && /biggest/.test(r.reason)); ok('a Legend is at the maximum');
  let hl = await hotelList(town); assert.equal(hl.floors, 9); assert.equal(new Set(hl.venues.map(v => v.no)).size, hl.venues.length); ok('door numbers stay unique and the tower is 9 floors tall');
  const nosNow = Object.fromEntries(hl.venues.map(v => [v.id, v.no])); assert.equal(nosNow[idOf(W2)], 401); assert.equal(nosNow[idOf(W5)], 501); assert.equal(nosNow[idOf(NONE)], 407); ok('rooms that did not move keep their door numbers');
  const first = hl.venues.findIndex(v => v.free); assert(first > 12); assert(hl.venues.slice(first).every(v => v.free)); assert(hl.venues.slice(0, first).every(v => !v.free)); ok('the directory lists the game\'s venues and holders first, free rooms below them');
  const late = await checkin(G, GUEST); assert(late.ok && late.no === 405); ok('a freed unit is the first free place for the next room (405, where the Legend used to be)');
  const c6 = await checkin(T6, W6); assert.equal(c6.no, 406); ok('and the next one after it takes 406');
  const W7c = await login(W7), over = await checkin(W7c, W7); assert(over.t === 'roomfail' && /Too many/.test(over.reason)); ok('the 9th check-in from one address in a day is refused');

  // ---------- lock
  const idN = idOf(NONE), visitor = await login(Wallet.createRandom());
  let e = await enter(visitor, idN); assert.equal(e.t, 'entered'); assert(e.venue.free && !e.venue.locked); ok('a free room is public: a visitor walks in');
  r = await ask(N, { t: 'roomlock', locked: true }, 'lock'); assert(r.ok && r.locked && r.mine.locked); await sleep(350); assert(!visitor.got.some(m => m.t === 'kicked')); ok('the owner locks the room; the person inside is not kicked');
  const stranger = await login(Wallet.createRandom()); e = await enter(stranger, idN); assert.equal(e.t, 'roomfail'); assert(/locked/.test(e.reason)); ok('a locked room refuses everybody but its owner');
  hl = await hotelList(town); assert.equal(hl.venues.find(v => v.id === idN).locked, true); ok('the directory (and so the door plate) says it is locked');
  e = await enter(N, idN); assert(e.t === 'entered' && e.mine && e.venue.locked); ok('the owner can enter their locked room');
  r = await ask(N, { t: 'roomlock', locked: false }, 'lock'); assert(r.ok && !r.locked); e = await enter(stranger, idN); assert.equal(e.t, 'entered'); ok('unlocking opens the door again');
  r = await ask(await login(Wallet.createRandom()), { t: 'roomlock', locked: true }, 'lock'); assert(!r.ok && /Check in/.test(r.reason)); ok('without a room there is nothing to lock');

  // ---------- a holder venue: the signed room, open and close, entry rules, facade
  const mk4 = mineOf(W4), id4 = idOf(W4); assert.equal(mk4.state, 'open'); assert.equal(mk4.tier, 4); ok('an upgraded room stays open: it was a public room, now with a Legend\'s size');
  const many = Array.from({ length: 400 }, (_, i) => ({ p: 'plant', x: -10 + (i % 20), z: -6 + (i % 12) }));
  const sv = await sign(T4, W4, 'venue', doc('Skyline Club', many)); assert.equal(sv.t, 'venuesaved'); assert(sv.mine.hasDoc); ok('the owner signs and saves the venue room');
  const own1 = await sign(T1, W1, 'venue', doc('Little Cafe', [{ p: 'sofa', x: 0, z: 0 }])); assert.equal(own1.t, 'venuesaved'); const swapped = await sign(T1, W4, 'venue', doc('Little Cafe', [])); assert.equal(swapped.t, 'roomfail'); ok('each owner saves only their own room, and only with their own signature');
  await sleep(80); T4.got.length = 0; T4.send({ t: 'venueprep', doc: doc('Skyline Club', many) }); const pr = await T4.wait(m => m.t === 'venueprep'); assert.equal(pr.n, 340); assert(/Chog Hotel venue/.test(pr.message)); ok('the tier 4 budget is 340 pieces per level (the 400 sent are cut)');
  await sleep(80); T6.got.length = 0; T6.send({ t: 'venueprep', doc: doc('x', many) }); assert.equal((await T6.wait(m => m.t === 'venueprep')).n, 80); ok('a free room holds 80 pieces');
  await sleep(80); T4.got.length = 0; T4.send({ t: 'venuesave', doc: doc('Skyline Club', many), ts: pr.ts, sig: await W1.signMessage(pr.message) }); assert(/another wallet/.test((await T4.wait(m => m.t === 'roomfail')).reason)); ok('a signature from another wallet is refused');
  r = await ask(T4, { t: 'venueset', open: false }, 'venuemine'); assert.equal(r.mine.state, 'closed'); e = await enter(stranger, id4); assert(e.t === 'roomfail' && /closed/.test(e.reason)); ok('the owner closes the venue: visitors are refused');
  e = await enter(T4, id4); assert(e.mine); assert.deepEqual(e.venue.size, [33, 22]); assert.equal(e.venue.levels, 2); assert.equal(e.venue.lights, 22); assert.equal(e.venue.units, 8); assert(!('cap' in e.venue)); ok('the owner enters their closed venue (the tier\'s floor size; no capacity any more)');
  r = await ask(T4, { t: 'roomlock', locked: true }, 'lock'); r = await ask(T4, { t: 'venueset', open: true, rule: 'holders' }, 'venuemine'); assert.equal(r.mine.state, 'open'); e = await enter(stranger, id4); assert(e.t === 'roomfail' && /locked/.test(e.reason)); ok('a locked venue stays locked even when it is open');
  r = await ask(T4, { t: 'roomlock', locked: false }, 'lock'); e = await enter(stranger, id4); assert(e.t === 'roomfail' && /Holders only/.test(e.reason)); ok('its own rules apply on top once it is unlocked: "holders only" turns a guest away');
  await sleep(450); T1.send({ t: 'appear', token: 1 }); await sleep(400); e = await enter(T1, id4); assert.equal(e.t, 'entered'); assert(!e.mine); assert.equal(e.doc.pieces.length, 340); ok('a holder playing their Chog gets in and receives the room');
  r = await ask(T4, { t: 'venueset', rule: 'list', guests: ['Alice_01', 'bo'] }, 'venuemine'); assert.deepEqual(r.mine.guests, ['alice_01']); ok('guest list entries are normalised (3 to 16 letters, digits or underscore)');
  e = await enter(T1, id4); assert(e.t === 'roomfail' && /guest list/.test(e.reason)); ok('a list venue turns away a name that is not on it');
  r = await ask(T4, { t: 'venueset', rule: 'public' }, 'venuemine');
  const up = await sign(T4, W4, 'venue', doc('Skyline Loft', [{ p: 'sofa', x: 0, z: 0 }, { p: 'wallArt', x: 3, z: 1, ry: 180 }]), 2); assert.equal(up.t, 'venuesaved'); assert.equal(up.level, 2); assert(up.mine.hasDoc2); ok('the owner signs and saves the upper room separately');
  e = await enter(T1, id4, 2); assert.equal(e.level, 2); assert.equal(e.doc.name, 'Skyline Loft'); assert.deepEqual(e.doc.pieces[1], { p: 'wallArt', x: 3, z: -11 }); ok('level 2 serves the upper room, and its wall piece is put on the wall (z = -11), facing the room');
  e = await enter(G, 'v101', 2); assert(e.t === 'roomfail' && /no upper level/.test(e.reason)); ok('a one-level room has no upstairs');
  e = await enter(T6, idOf(W6), 2); assert(e.t === 'roomfail' && /no upper level/.test(e.reason)); ok('neither has a free room');

  const fac = Array.from({ length: 80 }, (_, i) => ({ p: 'plant', x: (i % 2 ? 1 : -1) * (1.6 + (i % 10) * 0.28), z: -0.7 + (i % 3) * 0.7 }));
  await sleep(80); T4.got.length = 0; T4.send({ t: 'facadeprep', doc: doc('front', fac) }); const fp = await T4.wait(m => m.t === 'facadeprep'); assert.equal(fp.n, 80); assert(/Chog Hotel facade/.test(fp.message)); ok('a tier 4 facade has a budget of 80 pieces');
  const fs_ = await sign(T4, W4, 'facade', doc('front', fac)); assert.equal(fs_.t, 'facadesaved'); assert.deepEqual(fs_.mine.facadeSize, [20, 1.6]);
  const fl = await ask(town, { t: 'hotelfloor', floor: 8 }, 'facades'); const it = fl.items.find(x => x.id === id4); assert(it && it.units === 8 && it.no === 801 && it.doc.pieces.length === 80); assert(it.doc.pieces.every(q => Math.abs(q.x) <= 6.5 && Math.abs(q.z) <= 0.8)); ok('facades are served per floor, kept inside a strip 20 m wide and 1.6 m deep');
  assert.equal((await ask(town, { t: 'hotelfloor', floor: 1 }, 'facades')).items.length, 0); ok('a floor with no facades sends an empty list');
  const nf = await sign(N, NONE, 'facade', doc('front', fac)); assert(nf.t === 'roomfail' && /hall wall/.test(nf.reason)); ok('a free room has no facade: the hall wall is for venues');
  const clr = await sign(T4, W4, 'facade', doc('front', [{ p: 'plant', x: 0.2, z: 0 }, { p: 'wallArt', x: 0, z: -0.8 }, { p: 'wallArt', x: 2.5, z: -0.8 }, { p: 'wallArt', x: -6, z: 0, ry: 90 }, { p: 'plant', x: -2, z: 0.3 }]));
  assert.equal(clr.t, 'facadesaved'); const kept = (await ask(town, { t: 'hotelfloor', floor: 8 }, 'facades')).items.find(x => x.id === id4).doc.pieces.map(q => q.p + '@' + q.x); assert.deepEqual(kept, ['wallArt@2.5', 'plant@-2']); ok('the facade keeps the door clear: pieces in front of or over it, and side-wall pieces, are dropped');

  // ---------- no capacity limit
  assert.equal(mineOf(W1).state, 'open');
  const crowd = []; for (let i = 0; i < 16; i++) { const g = client(); await g.open; await g.wait(m => m.t === 'welcome'); g.send({ t: 'enter', space: 'venue', id: idOf(W1), x: 0, z: 0, ry: 0 }); const re = await g.wait(m => m.t === 'entered' || m.t === 'roomfail'); assert.equal(re.t, 'entered'); crowd.push(g); }
  hl = await hotelList(town); assert.equal(hl.counts[idOf(W1)], 16); assert(!('cap' in hl.venues.find(v => v.id === idOf(W1)))); ok('a Ser room takes 16 people (the old limit was 12): nobody is turned away for numbers');
  const info = await town.wait(m => m.t === 'hotelinfo' && m.busiest && m.busiest.inside === 16, 4000); assert.equal(info.busiest.door, 505); assert.equal(info.floors, 9); assert.equal(info.basement, 0); assert(info.rooms >= 19 && info.winner === null && Array.isArray(info.events)); ok('the town gets a hotelinfo message when the busiest room changes: floors, basement, rooms, busiest room, events, winner');
  crowd.forEach(g => g.ws.close()); await sleep(300);

  // ---------- usernames (the guard's lists use them)
  async function claim(c, w, name) { c.got.length = 0; c.send({ t: 'usernameprep', name }); const p = await c.wait(m => m.t === 'usernameprep' || m.t === 'roomfail'); if (p.t === 'roomfail') return p; await sleep(120); c.got.length = 0; c.send({ t: 'usernamesave', name, ts: p.ts, sig: await w.signMessage(p.message) }); return c.wait(m => m.t === 'username' || m.t === 'roomfail'); }
  await sleep(150); assert(/3 to 16/.test((await claim(T4, W4, 'ab')).reason)); await sleep(150); assert(/reserved/.test((await claim(T4, W4, 'Guest_1234')).reason)); await sleep(150); assert(/reserved/.test((await claim(T4, W4, 'admin')).reason)); ok('usernames: too short and reserved or look-alike names are refused');
  await sleep(150); const u4 = await claim(T4, W4, 'Skyline_DJ'); assert.equal(u4.name, 'Skyline_DJ'); ok('a wallet claims a username by signing');
  await sleep(150); assert(/taken/.test((await claim(T1, W1, 'skyline_dj')).reason)); ok('names are unique, ignoring case');
  await sleep(150); assert(/once every 7 days/.test((await claim(T4, W4, 'Skyline_Two')).reason)); ok('a name can be changed only once a week');
  await sleep(150); assert.equal((await claim(T1, W1, 'Bob_One')).t, 'username');
  r = await ask(T4, { t: 'venueset', open: true, rule: 'list', guests: ['bob_one'], bans: [] }, 'venuemine'); e = await enter(T1, id4); assert.equal(e.t, 'entered'); ok('a name on the guest list is let in');
  r = await ask(T4, { t: 'venueset', rule: 'public', bans: ['Bob_One'] }, 'venuemine'); e = await enter(T1, id4); assert(e.t === 'roomfail' && /guard turns you away/.test(e.reason)); ok('a banned name is turned away even when the venue is open to everyone');
  r = await ask(T4, { t: 'venueset', bans: [] }, 'venuemine');
  hl = await hotelList(town); assert.equal(hl.venues.find(v => v.id === idN).name, 'Guest room'); r = await ask(N, { t: 'venueset', name: 'Night Owl' }, 'venuemine'); assert.equal(r.mine.name, 'Night Owl'); ok('a free room without a name is called "Guest room" in the directory (or after the owner username); the owner can rename it');
  assert(/Chog venue/.test((await ask(N, { t: 'venueset', rule: 'holders' }, 'venuemine')).reason)); ok('entry rules, lists and music are for venues: a free room only has a name');

  // ---------- tiers: tier-locked pieces, music, VIP
  await sleep(150); T1.got.length = 0; T1.send({ t: 'venueprep', doc: doc('Little Cafe', [{ p: 'stage', x: 0, z: 0 }, { p: 'gameTable', x: 3, z: 3 }, { p: 'sofa', x: -3, z: 3 }]) }); assert.equal((await T1.wait(m => m.t === 'venueprep')).n, 2); ok('minTier: a tier 1 venue cannot hold a stage (needs Fren); the game table (tier 1) stays');
  await sleep(150); T4.got.length = 0; T4.send({ t: 'venueprep', doc: doc('Skyline Club', [{ p: 'stage', x: 0, z: 0 }, { p: 'djBooth', x: 5, z: 3 }, { p: 'chartTable', x: -5, z: 3 }]) }); assert.equal((await T4.wait(m => m.t === 'venueprep')).n, 3); ok('a tier 4 venue holds the stage, the DJ booth and the chart table');
  await sleep(150); T6.got.length = 0; T6.send({ t: 'venueprep', doc: doc('x', [{ p: 'gameTable', x: 0, z: 0 }, { p: 'sofa', x: 2, z: 2 }]) }); assert.equal((await T6.wait(m => m.t === 'venueprep')).n, 1); ok('a free room never holds venue-only pieces (game table dropped)');
  assert(/Fren/.test((await ask(T1, { t: 'venueset', music: 'club' }, 'venuemine')).reason)); ok('a tier 1 venue cannot choose its music');
  assert(/does not exist/.test((await ask(T4, { t: 'venueset', music: 'polka' }, 'venuemine')).reason)); ok('only the known tracks are accepted');
  const inside = await login(Wallet.createRandom()); await enter(inside, id4); inside.got.length = 0; T4.send({ t: 'venueset', music: 'club' }); const mu = await inside.wait(m => m.t === 'venuemusic'); assert.equal(mu.music, 'club'); ok('a music change is pushed to the people inside');
  assert(/Whale/.test((await ask(T1, { t: 'venueset', vipRule: 'holders' }, 'venuemine')).reason)); ok('a tier 1 venue has no VIP lounge');
  r = await ask(T4, { t: 'venueset', vipRule: 'holders' }, 'venuemine'); assert.equal((await hotelList(town)).venues.find(v => v.id === id4).vip, 'holders'); ok('a tier 4 venue sets its VIP rule (shown in the directory)');
  e = await enter(stranger, id4, 2); assert(e.t === 'roomfail' && /VIP lounge is for Chog holders/.test(e.reason)); ok('the stairs to a "holders only" VIP lounge turn a guest back');
  e = await enter(T1, id4, 2); assert.equal(e.t, 'entered'); assert.equal(e.level, 2); ok('a holder playing their Chog goes up to the VIP lounge');
  r = await ask(T4, { t: 'venueset', vipRule: 'public' }, 'venuemine');

  // ---------- holdings fall: a Fren venue freezes, thaws, then (after 7 days) falls back to a free room in place; what does not fit goes to the inventory
  const DAY_MS = 24 * 3600e3, id2 = idOf(W2);
  const big = [{ p: 'sofa', x: -9, z: -6 }, { p: 'plant', x: 12.5, z: 9 }, { p: 'stage', x: -4, z: -3 }, { p: 'gameTable', x: 4, z: 2 }, { p: 'wallArt', x: 8, z: -9.5 }];
  const s2 = await sign(T2, W2, 'venue', doc('Fren Suite', big)); assert.equal(s2.t, 'venuesaved'); r = await ask(T2, { t: 'venueset', open: true }, 'venuemine'); assert.equal(r.mine.state, 'open');
  delete HOLD[61]; let sw = await sweepVenues(); assert.deepEqual(sw.filter(x => x[0] === W2.address.toLowerCase()).map(x => x[1]), ['frozen']); assert.equal((await hotelList(town)).venues.find(v => v.id === id2).state, 'frozen'); ok('holdings below the venue\'s tier freeze it (closed, listed as frozen)');
  e = await enter(stranger, id2); assert(e.t === 'roomfail' && /frozen/.test(e.reason)); ok('visitors cannot enter a frozen venue');
  assert(/frozen/.test((await ask(T2, { t: 'venueprep', doc: doc('x', []) }, 'venueprep')).reason)); ok('a frozen venue cannot be edited');
  HOLD[61] = W2; clock.skew += 3 * DAY_MS; sw = await sweepVenues(); assert(sw.some(x => x[0] === W2.address.toLowerCase() && x[1] === 'thawed')); assert.equal((await hotelList(town)).venues.find(v => v.id === id2).state, 'open'); ok('the tier is back within 7 days: the venue reopens as it was (open, decor kept)');
  delete HOLD[61]; await sweepVenues(); clock.skew += 6 * DAY_MS; assert(!(await sweepVenues()).some(x => x[0] === W2.address.toLowerCase())); assert.equal(mineOf(W2).tier, 2); ok('6 days after the fall the venue is still only frozen');
  clock.skew += 2 * DAY_MS; sw = await sweepVenues(); assert(sw.some(x => x[0] === W2.address.toLowerCase() && x[1] === 'expired'));
  const m2 = mineOf(W2); assert.equal(m2.tier, 0); assert.equal(m2.no, 401); assert.equal(m2.units, 1); assert.equal(m2.levels, 1); assert.deepEqual(m2.size, [14, 10]); assert.equal(m2.state, 'open'); assert(m2.free); ok('after 7 days with no Chog the venue falls back to a free room in place: it keeps its first unit (401) and frees the rest');
  e = await enter(stranger, id2); assert(e.t === 'entered' && e.doc.pieces.map(q => q.p).join() === 'sofa'); ok('the free room keeps the decor that fits against the back walls (the sofa); the rest is out of the room');
  r = await ask(T2, { t: 'invget' }, 'inventory'); const inv = r.items.map(x => x.p + (x.locked ? ':' + x.locked : '')).sort(); assert.deepEqual(inv, ['gameTable:tier', 'plant', 'stage:tier', 'wallArt']); ok('what no longer fits is in the inventory, with a note on the pieces a free room cannot place (stage, game table: tier-locked)');
  r = await ask(G, { t: 'invget' }, 'inventory'); assert.deepEqual(r.items, []); ok('every wallet has its own inventory');
  const s2b = await sign(T2, W2, 'venue', doc('Fren Suite', [{ p: 'sofa', x: 0, z: 0 }, { p: 'plant', x: 2, z: 2 }])); assert.equal(s2b.t, 'venuesaved'); r = await ask(T2, { t: 'invget' }, 'inventory'); assert.deepEqual(r.items.map(x => x.p).sort(), ['gameTable', 'stage', 'wallArt']); ok('placing a stored piece again takes it out of the inventory');
  HOLD[2] = W2; r = await ask(T2, { t: 'upgrade' }); assert(r.ok && !r.moved && r.no === 401 && r.tier === 1 && r.mine.units === 2); ok('the Chog is back: the room grows to a Ser room in place (401, units 1 and 2)');
  r = await ask(T2, { t: 'invget' }, 'inventory'); assert(r.items.find(x => x.p === 'stage').locked === 'tier'); ok('a stage stays in the inventory, marked tier-locked, until the room is a Fren\'s');

  // a Whale who falls to a Ser: downsize in place, the upper level's pieces go to the inventory
  const id3 = idOf(W3), w3a = await sign(T3, W3, 'venue', doc('Whale Floor', [{ p: 'sofa', x: 0, z: 0 }])); assert.equal(w3a.t, 'venuesaved'); const w3u = await sign(T3, W3, 'venue', doc('Whale Loft', [{ p: 'sofa', x: 0, z: 0 }, { p: 'plant', x: 8, z: 5 }]), 2); assert.equal(w3u.t, 'venuesaved');
  delete HOLD[70]; HOLD[3] = W3; sw = await sweepVenues(); assert(sw.some(x => x[0] === W3.address.toLowerCase() && x[1] === 'frozen'));
  const dn = await ask(T3, { t: 'venuemove' }, 'venuemine'); assert.equal(dn.moved, 'downsize'); assert.equal(dn.mine.tier, 1); assert.equal(dn.mine.levels, 1); assert.equal(dn.mine.units, 2); assert.equal(dn.mine.no, 605); assert(!dn.mine.hasDoc2); assert(dn.mine.hasDoc); assert.equal(dn.mine.state, 'closed'); ok('a Whale who now holds a Ser shrinks in place: same door (605), one level, 2 units, upper room dropped, closed');
  const bk = require('fs').readdirSync(require('path').join(process.env.DATA_DIR, 'venue_backup')).filter(f => f.startsWith(W3.address.toLowerCase())); assert.equal(bk.length, 2); assert.equal(JSON.parse(require('fs').readFileSync(require('path').join(process.env.DATA_DIR, 'venue_backup', bk.sort().pop()), 'utf8')).venue2.doc.pieces.length, 2); ok('the dropped upper room is still in the backup copy');
  r = await ask(T3, { t: 'invget' }, 'inventory'); assert.deepEqual(r.items.map(x => x.p).sort(), ['plant', 'sofa']); ok('and its pieces are in the inventory');
  r = await ask(T3, { t: 'venuemove' }, 'venuemine'); assert(/already fits/.test(r.reason)); ok('nothing to move when the tier already matches');

  // ---------- the Exhibition entry is a snapshot of the saved room (the contest week is fixed to a Wednesday so the test does not depend on the day it runs)
  const skew0 = clock.skew; clock.skew = Date.UTC(2026, 9, 14, 12) - Date.now();
  const sv6 = await sign(T6, W6, 'venue', doc('Fresh Room', [{ p: 'sofa', x: 0, z: 0 }])); assert.equal(sv6.t, 'venuesaved');
  await sleep(500); T6.got.length = 0; T6.send({ t: 'ex_prep' }); const xp = await T6.wait(m => m.t === 'ex_prep' || m.t === 'ex_fail'); assert.equal(xp.t, 'ex_prep'); await sleep(500); T6.send({ t: 'ex_submit', ts: xp.ts, sig: await W6.signMessage(xp.message) }); const xd = await T6.wait(m => m.t === 'ex_done' || m.t === 'ex_fail'); assert.equal(xd.t, 'ex_done'); assert(xd.you.entered && xd.you.hasRoom);
  const entry = xd.entries[0]; stranger.got.length = 0; await sleep(450); stranger.send({ t: 'enter', space: 'exhibit', id: entry.id, x: 0, z: 0, ry: 0 }); const xe = await stranger.wait(m => m.t === 'entered' || m.t === 'roomfail'); assert.equal(xe.t, 'entered'); assert.deepEqual(xe.exhibit.size, [14, 10]); assert.equal(xe.doc.name, 'Fresh Room'); clock.skew = skew0; ok('a contest entry is a snapshot of the wallet\'s room, shown at that room\'s size (14 x 10 m)');

  // ---------- the basement: a free room nobody entered for 30 days moves down; holders never do; it comes back on request
  const idle = idOf(NONE); await enter(visitor, idOf(W6)); await sleep(450); N.send({ t: 'enter', space: 'city', x: 0, z: 0, ry: 0 }); await N.wait(m => m.t === 'entered' && m.space === 'city'); await sleep(100);
  clock.skew += 31 * DAY_MS; const moved = sweepBasement(); const movedAddrs = moved.map(x => x.addr);
  assert(movedAddrs.includes(NONE.address.toLowerCase())); assert(!movedAddrs.includes(W4.address.toLowerCase()) && !movedAddrs.includes(W1.address.toLowerCase()) && !movedAddrs.includes(W5.address.toLowerCase()) && !movedAddrs.includes(W3.address.toLowerCase())); ok('after 30 days the idle free rooms move to the basement; holder venues never do');
  assert(!movedAddrs.includes(W6.address.toLowerCase())); ok('a room with somebody inside stays up');
  const bn = mineOf(NONE); assert(bn.basement && bn.floor === -1 && bn.no < 0 && bn.tag && /^B1\d\d$/.test(bn.tag)); assert.equal(mineOf(W2).no, 401); ok('a basement room has a negative door number and a tag (B101...), and the other doors do not move');
  hl = await hotelList(town); assert(!hl.venues.some(v => v.id === idle)); assert.equal(hl.basement, 1); ok('the directory lists above-ground rooms only; the basement is counted for the elevator');
  const bf = await ask(town, { t: 'hotelfloor', floor: -1 }, 'facades'); assert(bf.rooms.some(x => x.id === idle && x.free)); ok('a basement floor sends its rooms when a player steps onto it');
  const dummy = await login(Wallet.createRandom()); await sleep(450); dummy.got.length = 0; dummy.send({ t: 'enter', space: 'hotel', floor: -1, x: 0, z: 0, ry: 0 }); const bfl = await dummy.wait(m => m.t === 'entered' || m.t === 'roomfail'); assert.equal(bfl.t, 'entered'); assert.equal(bfl.floor, -1); ok('the elevator can go to B1');
  await sleep(450); dummy.got.length = 0; dummy.send({ t: 'enter', space: 'hotel', floor: -2 }); assert(/no such floor/.test((await dummy.wait(m => m.t === 'roomfail')).reason)); ok('a basement floor that does not exist is refused');
  e = await enter(dummy, idle); assert.equal(e.t, 'entered'); ok('a basement room can still be visited');
  r = await ask(N, { t: 'reactivate' }); assert(r.ok && r.moved && r.from.no === bn.no && r.no > 0 && !r.mine.basement); ok('reactivate moves the room back up to the first free unit');
  assert(!(await ask(town, { t: 'hotelfloor', floor: -1 }, 'facades')).rooms.some(x => x.id === idle)); r = await ask(N, { t: 'reactivate' }); assert(!r.ok && r.code === 'above'); ok('a room that is not in the basement cannot be reactivated');
  const hi = hotelInfo(); assert.equal(hi.basement, 1); assert(hi.rooms === hotelRec.count()); ok('the hotel numbers count every room');

  require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(`\nall ${n} room checks passed`); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
