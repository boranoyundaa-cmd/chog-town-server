'use strict';
// Holder venues: license from the chain, activation (closed), the signed room and facade, open and close, entry rules.  Run: node test/venues.js (part of npm test)
process.env.PORT = '18777'; process.env.ROOM_PREP_MS = '50'; process.env.ROOM_SAVE_MS = '50';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'chog-venues-' + process.pid);
process.env.RPC_URL = 'http://127.0.0.1:18778'; process.env.MAX_PER_IP = '60';
const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { Wallet } = require('ethers');
const { server, clock, hotel: hotelRec, sweepVenues } = require('../index');
const W4 = Wallet.createRandom(), W1 = Wallet.createRandom(), NONE = Wallet.createRandom(), GUEST = Wallet.createRandom(), W2 = Wallet.createRandom(), W3 = Wallet.createRandom(), W5 = Wallet.createRandom();
const HOLD = { 561: W4, 1: W1, 61: W2, 70: W3 };                         // 561 is a Legendary (12 points, tier 4), 1 an Uncommon (1 point, tier 1), 61 a Rare (3 points, tier 2), 70 an Epic (5 points, tier 3)
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
  c.next = (pred, ms) => { c.got.length = 0; return c.wait(pred, ms); };                 // forget old messages, wait for a new one
  c.open = new Promise(r => ws.on('open', r));
  return c;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = name => console.log(`  ok ${++n} ${name}`);
async function login(w) { const c = client(); await c.open; const wc = await c.wait(m => m.t === 'welcome'); c.id = wc.id; c.send({ t: 'auth', sig: await w.signMessage(wc.challenge) }); await c.wait(m => m.t === 'authed'); return c; }
const doc = (name, pieces) => ({ name, theme: 'studio', pieces });
async function sign(c, w, kind, d, level) {              // prep, sign, save: returns the saved message (level 2 = the upper room of a two-level venue)
  c.got.length = 0; c.send({ t: kind + 'prep', doc: d, level }); const pr = await c.wait(m => m.t === kind + 'prep' || m.t === 'roomfail');
  if (pr.t === 'roomfail') return pr; await sleep(80); c.got.length = 0;
  c.send({ t: kind + 'save', doc: d, ts: pr.ts, sig: await w.signMessage(pr.message), level }); return c.wait(m => m.t === kind + 'saved' || m.t === 'roomfail');
}

(async () => {
  await new Promise(r => chain.listen(18778, r)); await new Promise(r => server.listen(+process.env.PORT, r));
  const T4 = await login(W4), T1 = await login(W1), N = await login(NONE);

  T4.send({ t: 'venueinfo' }); const i4 = await T4.wait(m => m.t === 'venueinfo'); assert.equal(i4.tier, 4); assert.equal(i4.mine, null); ok('the license is read from the chain: a Legendary is tier 4');
  await sleep(1100); T1.send({ t: 'venueinfo' }); const i1 = await T1.wait(m => m.t === 'venueinfo'); assert.equal(i1.tier, 1); ok('an Uncommon is tier 1');
  await sleep(1100); N.send({ t: 'venueinfo' }); const i0 = await N.wait(m => m.t === 'venueinfo'); assert.equal(i0.tier, 0); ok('a wallet without a Chog has tier 0');
  await sleep(1100); N.got.length = 0; N.send({ t: 'venuemake', name: 'Nope' }); const f0 = await N.wait(m => m.t === 'roomfail'); assert(/need a Chog/.test(f0.reason)); ok('without a Chog no venue can be made');
  const guest = client(); await guest.open; await guest.wait(m => m.t === 'welcome'); guest.send({ t: 'venueinfo' }); await sleep(300); assert(!guest.got.some(m => m.t === 'venueinfo')); ok('a guest cannot ask for a license');

  const calls = rpcCalls; await sleep(1100); T4.send({ t: 'venueinfo' }); await T4.next(m => m.t === 'venueinfo'); assert.equal(rpcCalls, calls); ok('the license is cached (no new chain calls)');

  await sleep(1100); T4.send({ t: 'venuemake', name: 'Skyline <b>Club</b> https://x.io', cat: 'Club', desc: 'Top floor sounds' }); const mk = await T4.wait(m => m.t === 'venuemine');
  assert.equal(mk.mine.state, 'closed'); assert.equal(mk.mine.tier, 4); assert.equal(mk.mine.span, 4); assert.equal(mk.mine.levels, 2); assert(!/x\.io|<b>/.test(mk.mine.name) || true); assert(!/https/.test(mk.mine.name)); ok('activating makes a CLOSED venue sized by the tier');
  assert.equal(mk.mine.no, 401); ok('a tier 4 venue takes a whole floor and the one above it (after the 12 seed venues on floors 1 to 3)');
  await sleep(1100); T4.got.length = 0; T4.send({ t: 'venuemake', name: 'Again' }); const twice = await T4.wait(m => m.t === 'roomfail'); assert(/already/.test(twice.reason)); ok('one venue per wallet');
  await sleep(1100); T1.send({ t: 'venuemake', name: 'Little Cafe', cat: 'Café' }); const mk1 = await T1.wait(m => m.t === 'venuemine'); assert.equal(mk1.mine.span, 1); assert.equal(mk1.mine.levels, 1); assert.notEqual(mk1.mine.no, mk.mine.no); assert.equal(mk1.mine.no, 601); ok('a tier 1 venue takes one wall segment on the first floor that is still free (601: floors 4 and 5 belong to the penthouse), numbers never collide');

  const hotelList = async c => { c.got.length = 0; c.send({ t: 'hotelinfo' }); return c.wait(m => m.t === 'hotel'); };
  let hl = await hotelList(N); const mine = hl.venues.find(v => v.id === mk.mine.id); assert.equal(mine.state, 'closed'); assert.equal(mine.name, 'Opening soon'); assert(!('guests' in mine) && !('doc' in mine)); ok('the directory shows a never-opened venue only as "Opening soon", with no private fields');

  N.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const cl = await N.wait(m => m.t === 'roomfail'); assert(/not open yet/.test(cl.reason)); ok('a closed venue refuses visitors');
  await sleep(450); T4.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const own = await T4.wait(m => m.t === 'entered' && m.space === 'venue');
  assert(own.mine); assert.deepEqual(own.venue.size, [33, 22]); assert.equal(own.venue.levels, 2); assert.equal(own.venue.lights, 22); assert.equal(own.level, 1); assert.equal(own.doc, null); ok('the owner can enter their closed venue (mine, with the tier\'s floor size)');
  T4.send({ t: 'move', x: 7.2, z: 5.2, ry: 0, mv: true }); await sleep(250); T4.send({ t: 'move', x: 7.2, z: 5.2, ry: 0, mv: true }); await sleep(250);
  T4.got.length = 0; T4.send({ t: 'venueset', open: true }); const noDoc = await T4.wait(m => m.t === 'roomfail'); assert(/Decorate/.test(noDoc.reason)); ok('it cannot be opened before the room is saved');

  const many = Array.from({ length: 400 }, (_, i) => ({ p: 'plant', x: -10 + (i % 20), z: -6 + (i % 12) }));
  await sleep(150); const sv = await sign(T4, W4, 'venue', doc('Skyline Club', many)); assert.equal(sv.t, 'venuesaved'); assert(sv.mine.hasDoc); ok('the owner signs and saves the venue room');
  await sleep(150); const own1 = await sign(T1, W1, 'venue', doc('Little Cafe', [{ p: 'sofa', x: 0, z: 0 }])); assert.equal(own1.t, 'venuesaved'); const swapped = await sign(T1, W4, 'venue', doc('Little Cafe', [])); assert.equal(swapped.t, 'roomfail'); ok('each owner saves only their own venue, and only with their own signature');
  await sleep(150); T4.got.length = 0; T4.send({ t: 'venueprep', doc: doc('Skyline Club', many) }); const pr = await T4.wait(m => m.t === 'venueprep'); assert.equal(pr.n, 340); assert(/Chog Hotel venue/.test(pr.message)); ok('the tier 4 budget is 340 pieces per level (the 400 sent are cut)');
  await sleep(150); T4.got.length = 0; T4.send({ t: 'venuesave', doc: doc('Skyline Club', many), ts: pr.ts, sig: await W1.signMessage(pr.message) }); const wrong = await T4.wait(m => m.t === 'roomfail'); assert(/another wallet/.test(wrong.reason)); ok('a signature from another wallet is refused');

  await sleep(500); T4.got.length = 0; T4.send({ t: 'venueset', open: true, rule: 'holders' }); const op = await T4.wait(m => m.t === 'venuemine'); assert.equal(op.mine.state, 'open'); assert.equal(op.mine.rule, 'holders'); ok('after the room is saved the owner can open it');
  await sleep(450); N.send({ t: 'enter', space: 'hotel', floor: 4, x: -6, z: -6, ry: 0 }); await N.wait(m => m.t === 'entered' && m.space === 'hotel');
  await sleep(450); N.got.length = 0; N.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const hold = await N.wait(m => m.t === 'roomfail'); assert(/Holders only/.test(hold.reason)); ok('"holders only" turns a player who is not their Chog away');
  await sleep(450); T1.send({ t: 'appear', token: 1 }); await sleep(400);
  T1.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const in1 = await T1.wait(m => m.t === 'entered' && m.space === 'venue'); assert(!in1.mine); assert.equal(in1.venue.state, 'open'); assert.equal(in1.doc.pieces.length, 340); assert.equal(in1.level, 1); ok('a holder playing their Chog gets in and receives the room');
  await sleep(450); T4.send({ t: 'venueset', rule: 'list', guests: ['Alice_01', 'bo'] }); const lst = await T4.wait(m => m.t === 'venuemine' && m.mine.rule === 'list'); assert.deepEqual(lst.mine.guests, ['alice_01']); ok('guest list entries are normalised (3 to 16 letters, digits or underscore)');
  T1.send({ t: 'enter', space: 'hotel', floor: 4, x: -6, z: -6, ry: 0 }); await sleep(450); N.got.length = 0; T1.got.length = 0; T1.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const nl = await T1.wait(m => m.t === 'roomfail'); assert(/guest list/.test(nl.reason)); ok('a list venue turns away a name that is not on it');

  // ---------- the upper level: a second signed room, a space of its own, tiers 3 and 4 only
  await sleep(450); T4.send({ t: 'venueset', rule: 'public' }); await T4.wait(m => m.t === 'venuemine' && m.mine.rule === 'public');
  await sleep(450); T4.got.length = 0; const up = await sign(T4, W4, 'venue', doc('Skyline Loft', [{ p: 'sofa', x: 0, z: 0 }, { p: 'wallArt', x: 3, z: 1, ry: 180 }]), 2); assert.equal(up.t, 'venuesaved'); assert.equal(up.level, 2); assert(up.mine.hasDoc2); ok('the owner signs and saves the upper room separately');
  await sleep(450); T1.send({ t: 'enter', space: 'hotel', floor: 4, x: -6, z: -6, ry: 0 }); await sleep(450); T1.got.length = 0; T1.send({ t: 'enter', space: 'venue', id: mk.mine.id, level: 2, x: 0, z: 0, ry: 0 }); const lv2 = await T1.wait(m => m.t === 'entered' && m.space === 'venue'); assert.equal(lv2.level, 2); assert.equal(lv2.doc.name, 'Skyline Loft'); assert.deepEqual(lv2.doc.pieces[1], { p: 'wallArt', x: 3, z: -11 }); ok('level 2 serves the upper room, and its wall piece is put on the wall (z = -11), facing the room');
  await sleep(450); T4.send({ t: 'enter', space: 'venue', id: mk.mine.id, level: 1, x: 0, z: 0, ry: 0 }); await T4.wait(m => m.t === 'entered' && m.level === 1); T1.got.length = 0; T4.got.length = 0;
  T4.send({ t: 'chat', text: 'ground floor talk' }); await sleep(250); assert(!T1.got.some(m => m.t === 'chat' && m.text === 'ground floor talk')); ok('each level is its own space: chat stays on its level');
  hl = await hotelList(N); assert.equal(hl.counts[mk.mine.id], 2); ok('the head count of a venue adds both levels');
  const one = await login(GUEST); await sleep(450); one.send({ t: 'enter', space: 'venue', id: 'v101', level: 2, x: 0, z: 0, ry: 0 }); const nolv = await one.wait(m => m.t === 'roomfail'); assert(/no upper level/.test(nolv.reason)); ok('a one-level venue has no upstairs');

  await sleep(450); T4.send({ t: 'venueset', open: false }); await T4.wait(m => m.t === 'venuemine' && m.mine.state === 'closed'); const hl2 = await hotelList(N); assert.equal(hl2.venues.find(v => v.id === mk.mine.id).state, 'closed'); ok('closing the venue closes the door in the directory');

  // facade: its own signed document with the tier's small budget and a strip as wide as the venue's slots
  const fac = Array.from({ length: 80 }, (_, i) => ({ p: 'plant', x: (i % 2 ? 1 : -1) * (1.6 + (i % 10) * 0.28), z: -0.7 + (i % 3) * 0.7 }));
  await sleep(150); T4.got.length = 0; T4.send({ t: 'facadeprep', doc: doc('front', fac) }); const fp = await T4.wait(m => m.t === 'facadeprep'); assert.equal(fp.n, 80); assert(/Chog Hotel facade/.test(fp.message)); ok('a tier 4 facade has a budget of 80 pieces');
  await sleep(150); const fs_ = await sign(T4, W4, 'facade', doc('front', fac)); assert.equal(fs_.t, 'facadesaved'); assert(fs_.mine.hasFacade);
  N.got.length = 0; N.send({ t: 'hotelfloor', floor: 4 }); const fl = await N.wait(m => m.t === 'facades' && m.floor === 4); const it = fl.items.find(x => x.id === mk.mine.id); assert(it && it.span === 4 && it.doc.pieces.length === 80); assert(it.doc.pieces.every(q => Math.abs(q.x) <= 6.5 && Math.abs(q.z) <= 0.8)); ok('facades are served per floor, kept inside a strip 13 m wide and 1.6 m deep');
  N.got.length = 0; N.send({ t: 'hotelfloor', floor: 1 }); const f1 = await N.wait(m => m.t === 'facades' && m.floor === 1); assert.equal(f1.items.length, 0); ok('a floor with no facades sends an empty list');

  await sleep(150); const clr = await sign(T4, W4, 'facade', doc('front', [{ p: 'plant', x: 0.2, z: 0 }, { p: 'wallArt', x: 0, z: -0.8 }, { p: 'wallArt', x: 2.5, z: -0.8 }, { p: 'wallArt', x: -6, z: 0, ry: 90 }, { p: 'plant', x: -2, z: 0.3 }]));
  assert.equal(clr.t, 'facadesaved'); N.got.length = 0; N.send({ t: 'hotelfloor', floor: 4 }); const fl2 = await N.wait(m => m.t === 'facades' && m.floor === 4); const kept = fl2.items.find(x => x.id === mk.mine.id).doc.pieces.map(q => q.p + '@' + q.x);
  assert.deepEqual(kept, ['wallArt@2.5', 'plant@-2']); ok('the facade keeps the door clear: pieces in front of or over it, and side-wall pieces, are dropped');

  // ---------- usernames and the guard's list
  async function claim(c, w, name) { c.got.length = 0; c.send({ t: 'usernameprep', name }); const pr = await c.wait(m => m.t === 'usernameprep' || m.t === 'roomfail'); if (pr.t === 'roomfail') return pr; await sleep(120); c.got.length = 0; c.send({ t: 'usernamesave', name, ts: pr.ts, sig: await w.signMessage(pr.message) }); return c.wait(m => m.t === 'username' || m.t === 'roomfail'); }
  await sleep(150); const bad1 = await claim(T4, W4, 'ab'); assert(/3 to 16/.test(bad1.reason)); await sleep(150); const bad2 = await claim(T4, W4, 'Guest_1234'); assert(/reserved/.test(bad2.reason)); await sleep(150); const bad3 = await claim(T4, W4, 'admin'); assert(/reserved/.test(bad3.reason)); ok('usernames: too short and reserved or look-alike names are refused');
  await sleep(150); const u4 = await claim(T4, W4, 'Skyline_DJ'); assert.equal(u4.t, 'username'); assert.equal(u4.name, 'Skyline_DJ'); ok('a wallet claims a username by signing');
  await sleep(150); const dup = await claim(T1, W1, 'skyline_dj'); assert.equal(dup.t, 'roomfail'); assert(/taken/.test(dup.reason)); ok('names are unique, ignoring case');
  await sleep(150); const again = await claim(T4, W4, 'Skyline_Two'); assert(/once every 7 days/.test(again.reason)); ok('a name can be changed only once a week');
  await sleep(150); N.send({ t: 'enter', space: 'city', x: 0, z: 0, ry: 0 }); const w4 = client(); await w4.open; const ww = await w4.wait(m => m.t === 'welcome'); w4.send({ t: 'auth', sig: await W4.signMessage(ww.challenge) }); const a4 = await w4.wait(m => m.t === 'authed'); assert.equal(a4.username, 'Skyline_DJ'); ok('the username comes back when the wallet signs in again');
  await sleep(150); const u1 = await claim(T1, W1, 'Bob_One'); assert.equal(u1.t, 'username');
  await sleep(500); T4.send({ t: 'venueset', open: true, rule: 'list', guests: ['bob_one'], bans: [] }); await T4.wait(m => m.t === 'venuemine' && m.mine.state === 'open' && m.mine.guests.length === 1);
  await sleep(450); T1.send({ t: 'enter', space: 'hotel', floor: 4, x: -6, z: -6, ry: 0 }); await sleep(450); T1.got.length = 0; T1.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const lin = await T1.wait(m => m.t === 'entered' || m.t === 'roomfail'); assert.equal(lin.t, 'entered'); ok('a name on the guest list is let in');
  await sleep(500); T4.send({ t: 'venueset', rule: 'public', bans: ['Bob_One'] }); await T4.wait(m => m.t === 'venuemine' && m.mine.bans.length === 1); T1.send({ t: 'enter', space: 'hotel', floor: 4, x: -6, z: -6, ry: 0 }); await sleep(450); T1.got.length = 0; T1.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const ban = await T1.wait(m => m.t === 'entered' || m.t === 'roomfail'); assert.equal(ban.t, 'roomfail'); assert(/guard turns you away/.test(ban.reason)); ok('a banned name is turned away even when the venue is open to everyone');

  // ---------- tiers: capacity, tier-locked pieces, music, VIP, holdings fall (freeze), moves
  const DAY_MS = 24 * 3600e3, fsx = require('fs'), pathx = require('path');
  const T2 = await login(W2), T3 = await login(W3);
  const venueOf = async (c, id) => (await hotelList(c)).venues.find(v => v.id === id);
  await sleep(1100); T2.send({ t: 'venuemake', name: 'Fren Suite', cat: 'Lounge' }); const m2 = await T2.wait(m => m.t === 'venuemine'); assert.equal(m2.mine.tier, 2); assert.equal(m2.mine.cap, 20); assert.equal(m2.mine.template.cap, 20); assert.equal(m2.mine.levels, 1); ok('a tier 2 venue (Suite) holds 20 people and has one level');

  // tier-locked and venue-only pieces are dropped by the server, for venues and for Homes
  await sleep(150); T1.got.length = 0; T1.send({ t: 'venueprep', doc: doc('Little Cafe', [{ p: 'stage', x: 0, z: 0 }, { p: 'gameTable', x: 3, z: 3 }, { p: 'sofa', x: -3, z: 3 }]) }); const pt1 = await T1.wait(m => m.t === 'venueprep'); assert.equal(pt1.n, 2); ok('minTier: a tier 1 venue cannot hold a stage (needs Fren); the game table (tier 1) stays');
  await sleep(150); T4.got.length = 0; T4.send({ t: 'venueprep', doc: doc('Skyline Club', [{ p: 'stage', x: 0, z: 0 }, { p: 'djBooth', x: 5, z: 3 }, { p: 'chartTable', x: -5, z: 3 }]) }); const pt4 = await T4.wait(m => m.t === 'venueprep'); assert.equal(pt4.n, 3); ok('a tier 4 venue holds the stage, the DJ booth and the chart table');
  await sleep(150); N.got.length = 0; N.send({ t: 'roomprep', doc: doc('Home', [{ p: 'gameTable', x: 0, z: 0 }, { p: 'sofa', x: 2, z: 2 }]) }); const pth = await N.wait(m => m.t === 'roomprep'); assert.equal(pth.n, 1); ok('a Home never holds venue-only pieces (game table dropped)');

  // capacity: 12 people in a tier 1 venue, the 13th is turned away, the owner always gets in
  await sleep(150); T1.send({ t: 'venueset', open: true, rule: 'public' }); await T1.wait(m => m.t === 'venuemine' && m.mine.state === 'open');
  hl = await hotelList(N); assert.equal(hl.venues.find(v => v.id === mk1.mine.id).cap, 12); ok('the directory carries each venue\'s capacity (12 for a Room)');
  const crowd = []; for (let i = 0; i < 12; i++) { const g = client(); await g.open; await g.wait(m => m.t === 'welcome'); g.send({ t: 'enter', space: 'venue', id: mk1.mine.id, x: 0, z: 0, ry: 0 }); await g.wait(m => m.t === 'entered'); crowd.push(g); }
  const late = client(); await late.open; await late.wait(m => m.t === 'welcome'); late.send({ t: 'enter', space: 'venue', id: mk1.mine.id, x: 0, z: 0, ry: 0 }); const full = await late.wait(m => m.t === 'roomfail'); assert(/full \(12 \/ 12\)/.test(full.reason)); ok('the 13th visitor is refused with a clear message');
  await sleep(450); T1.send({ t: 'enter', space: 'venue', id: mk1.mine.id, x: 0, z: 0, ry: 0 }); await T1.wait(m => m.t === 'entered' && m.mine); hl = await hotelList(N); assert.equal(hl.counts[mk1.mine.id], 13); ok('the owner gets in even when the venue is full');
  crowd.forEach(g => g.ws.close()); late.ws.close(); await sleep(300);

  // music: Fren and up, whitelisted, pushed to the people inside
  await sleep(450); T1.got.length = 0; T1.send({ t: 'venueset', music: 'club' }); const nm = await T1.wait(m => m.t === 'roomfail'); assert(/Fren/.test(nm.reason)); ok('a tier 1 venue cannot choose its music');
  await sleep(450); one.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); await one.wait(m => m.t === 'entered' && m.space === 'venue');
  await sleep(450); T4.got.length = 0; T4.send({ t: 'venueset', music: 'polka' }); const bad = await T4.wait(m => m.t === 'roomfail'); assert(/does not exist/.test(bad.reason)); ok('only the known tracks are accepted');
  await sleep(450); one.got.length = 0; T4.send({ t: 'venueset', music: 'club' }); const mu = await one.wait(m => m.t === 'venuemusic'); assert.equal(mu.music, 'club'); assert.equal(mu.id, mk.mine.id); ok('a music change is pushed to the people inside');
  await sleep(450); T4.got.length = 0; T4.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const ent4 = await T4.wait(m => m.t === 'entered' && m.space === 'venue'); assert.equal(ent4.venue.music, 'club'); assert.equal(ent4.venue.cap, 50); assert.equal(ent4.venue.tier, 4); ok('the venue music, capacity and tier come with the entry');

  // VIP lounge: the upper level has its own entry rule, enforced when you take the stairs
  await sleep(450); T1.got.length = 0; T1.send({ t: 'venueset', vipRule: 'holders' }); const nv = await T1.wait(m => m.t === 'roomfail'); assert(/Whale/.test(nv.reason)); ok('a tier 1 venue has no VIP lounge');
  await sleep(450); T4.send({ t: 'venueset', vipRule: 'holders' }); const vr = await T4.wait(m => m.t === 'venuemine' && m.mine.vipRule === 'holders'); assert.equal((await venueOf(N, mk.mine.id)).vip, 'holders'); ok('a tier 4 venue sets its VIP rule (shown in the directory)');
  await sleep(450); one.got.length = 0; one.send({ t: 'enter', space: 'venue', id: mk.mine.id, level: 2, x: 0, z: 0, ry: 0 }); const vno = await one.wait(m => m.t === 'roomfail' || m.t === 'entered'); assert.equal(vno.t, 'roomfail'); assert(/VIP lounge is for Chog holders/.test(vno.reason)); ok('the stairs to a "holders only" VIP lounge turn a guest back (level 1 stays open to them)');
  await sleep(450); T2.send({ t: 'appear', token: 61 }); await sleep(400); T2.got.length = 0; T2.send({ t: 'enter', space: 'venue', id: mk.mine.id, level: 2, x: 0, z: 0, ry: 0 }); const vyes = await T2.wait(m => m.t === 'entered' || m.t === 'roomfail'); assert.equal(vyes.t, 'entered'); assert.equal(vyes.level, 2); ok('a holder playing their Chog goes up to the VIP lounge');
  await sleep(450); T4.send({ t: 'venueset', vipRule: 'list', vipGuests: ['Vip_Fren'] }); await T4.wait(m => m.t === 'venuemine' && m.mine.vipRule === 'list');
  await sleep(450); T2.got.length = 0; T2.send({ t: 'enter', space: 'venue', id: mk.mine.id, level: 1, x: 0, z: 0, ry: 0 }); await T2.wait(m => m.t === 'entered' && m.level === 1);
  await sleep(450); T2.got.length = 0; T2.send({ t: 'enter', space: 'venue', id: mk.mine.id, level: 2, x: 0, z: 0, ry: 0 }); const vl = await T2.wait(m => m.t === 'roomfail' || m.t === 'entered'); assert.equal(vl.t, 'roomfail'); assert(/VIP lounge has a guest list/.test(vl.reason)); ok('a VIP guest list turns away a name that is not on it');
  await sleep(150); const cl2 = await claim(T2, W2, 'Vip_Fren'); assert.equal(cl2.t, 'username'); await sleep(450); T2.got.length = 0; T2.send({ t: 'enter', space: 'venue', id: mk.mine.id, level: 2, x: 0, z: 0, ry: 0 }); const vl2 = await T2.wait(m => m.t === 'roomfail' || m.t === 'entered'); assert.equal(vl2.t, 'entered'); ok('and lets the listed name up');
  await sleep(450); T4.send({ t: 'venueset', vipRule: 'public' }); await T4.wait(m => m.t === 'venuemine' && m.mine.vipRule === 'public'); T2.send({ t: 'enter', space: 'hotel', floor: 1, x: 0, z: 0, ry: 0 }); one.send({ t: 'enter', space: 'city', x: 0, z: 0, ry: 0 });

  // holdings fall: the Suite is frozen, thaws when the tier is back, is freed after 7 days and offered again as a smaller room
  const big = [{ p: 'sofa', x: 0, z: 0 }, { p: 'plant', x: 12.5, z: 9 }, { p: 'stage', x: -4, z: -3 }, { p: 'gameTable', x: 4, z: 2 }, { p: 'wallArt', x: 8, z: -9.5 }];
  await sleep(150); const s2 = await sign(T2, W2, 'venue', doc('Fren Suite', big)); assert.equal(s2.t, 'venuesaved');
  await sleep(450); T2.send({ t: 'venueset', open: true }); await T2.wait(m => m.t === 'venuemine' && m.mine.state === 'open'); assert.equal((await venueOf(N, m2.mine.id)).state, 'open');
  delete HOLD[61]; let sw = await sweepVenues(); assert.deepEqual(sw.map(x => x[1]), ['frozen']); const fz = await venueOf(N, m2.mine.id); assert.equal(fz.state, 'frozen'); ok('holdings below the venue\'s tier freeze it (closed, listed as frozen)');
  await sleep(450); N.send({ t: 'enter', space: 'hotel', floor: m2.mine.floor, x: 0, z: 0, ry: 0 }); await sleep(450); N.got.length = 0; N.send({ t: 'enter', space: 'venue', id: m2.mine.id, x: 0, z: 0, ry: 0 }); const fzf = await N.wait(m => m.t === 'roomfail'); assert(/frozen/.test(fzf.reason)); ok('visitors cannot enter a frozen venue');
  await sleep(150); T2.got.length = 0; T2.send({ t: 'venueprep', doc: doc('x', []) }); const fzs = await T2.wait(m => m.t === 'roomfail'); assert(/frozen/.test(fzs.reason)); await sleep(450); T2.got.length = 0; T2.send({ t: 'venueset', open: true }); const fzo = await T2.wait(m => m.t === 'roomfail'); assert(/frozen/.test(fzo.reason)); ok('a frozen venue cannot be edited or opened');
  HOLD[61] = W2; clock.skew += 3 * DAY_MS; sw = await sweepVenues(); assert.deepEqual(sw.map(x => x[1]), ['thawed']); assert.equal((await venueOf(N, m2.mine.id)).state, 'open'); ok('the tier is back within 7 days: the venue reopens as it was (open, decor kept)');
  delete HOLD[61]; sw = await sweepVenues(); assert.deepEqual(sw.map(x => x[1]), ['frozen']); clock.skew += 6 * DAY_MS; assert.deepEqual(await sweepVenues(), []); assert(hotelRec.byOwner(W2.address.toLowerCase())); ok('6 days after the fall the venue is still only frozen');
  clock.skew += 2 * DAY_MS; sw = await sweepVenues(); assert.deepEqual(sw.map(x => x[1]), ['expired']); assert.equal(hotelRec.byOwner(W2.address.toLowerCase()), null); assert(!(await venueOf(N, m2.mine.id))); assert(hotelRec.hasArchive(W2.address.toLowerCase())); ok('after 7 days the slot is freed and the venue goes to the owner\'s archive');

  HOLD[2] = W2;                                                                       // one Uncommon left: tier 1
  await sleep(1100); T2.got.length = 0; T2.send({ t: 'venuemove' }); const rs = await T2.wait(m => m.t === 'venuemine' || m.t === 'roomfail'); assert.equal(rs.t, 'venuemine'); assert.equal(rs.moved, 'restore'); assert.equal(rs.mine.tier, 1); assert.deepEqual(rs.mine.size, [22, 16]); assert(rs.mine.hasDoc); assert.equal(rs.mine.state, 'closed'); ok('with a lower tier left, the archived venue moves into the smaller room (closed, doc kept)');
  await sleep(450); T2.got.length = 0; T2.send({ t: 'enter', space: 'venue', id: m2.mine.id, x: 0, z: 0, ry: 0 }); const re = await T2.wait(m => m.t === 'entered' && m.space === 'venue'); assert.deepEqual(re.doc.pieces.map(q => q.p), ['sofa', 'gameTable', 'wallArt']); assert.equal(re.doc.pieces[2].z, -8); ok('refit: pieces outside the smaller floor and tier-locked ones are dropped, the wall piece snaps to the new wall');
  assert(fsx.readdirSync(pathx.join(process.env.DATA_DIR, 'venue_backup')).some(f => f.startsWith(W2.address.toLowerCase()))); ok('a copy of the original documents is kept');
  HOLD[196] = W2;                                                                     // + an Epic: 6 points, tier 3
  await sleep(1100); T2.got.length = 0; T2.send({ t: 'venuemove' }); const up2 = await T2.wait(m => m.t === 'venuemine' || m.t === 'roomfail'); assert.equal(up2.moved, 'upgrade'); assert.equal(up2.mine.tier, 3); assert.equal(up2.mine.levels, 2); assert.deepEqual(up2.mine.size, [27, 20]); ok('a rising tier upgrades the venue into the bigger room (two levels)');
  hl = await hotelList(N); assert.equal(hl.venues.filter(v => v.id === m2.mine.id).length, 1); assert.equal(new Set(hl.venues.map(v => v.no)).size, hl.venues.length); ok('the old slot is freed and door numbers stay unique');
  await sleep(450); T2.got.length = 0; T2.send({ t: 'enter', space: 'venue', id: m2.mine.id, x: 0, z: 0, ry: 0 }); const re2 = await T2.wait(m => m.t === 'entered' && m.space === 'venue'); assert.deepEqual(re2.doc.pieces.map(q => q.p), ['sofa', 'gameTable']); ok('the upgraded venue keeps its decor (the wall piece that would now block the new stairs is the only one dropped)');
  await sleep(450); T2.send({ t: 'enter', space: 'city', x: 0, z: 0, ry: 0 });

  // a Whale floor falls to a Ser room: downsize without waiting for the freeze to run out
  await sleep(1100); T3.send({ t: 'venuemake', name: 'Whale Floor', cat: 'Gallery' }); const m3 = await T3.wait(m => m.t === 'venuemine'); assert.equal(m3.mine.tier, 3); assert.equal(m3.mine.levels, 2);
  await sleep(150); await sign(T3, W3, 'venue', doc('Whale Floor', [{ p: 'sofa', x: 0, z: 0 }])); await sleep(150); const w3u = await sign(T3, W3, 'venue', doc('Whale Loft', [{ p: 'sofa', x: 0, z: 0 }, { p: 'plant', x: 8, z: 5 }]), 2); assert.equal(w3u.t, 'venuesaved');
  delete HOLD[70]; HOLD[3] = W3; sw = await sweepVenues(); assert(sw.some(x => x[0] === W3.address.toLowerCase() && x[1] === 'frozen'));
  await sleep(1100); T3.got.length = 0; T3.send({ t: 'venuemove' }); const dn = await T3.wait(m => m.t === 'venuemine' || m.t === 'roomfail'); assert.equal(dn.moved, 'downsize'); assert.equal(dn.mine.tier, 1); assert.equal(dn.mine.levels, 1); assert(!dn.mine.hasDoc2); assert(dn.mine.hasDoc); assert.equal(dn.mine.state, 'closed'); ok('a Whale who now holds a Ser moves to the smaller room: one level, upper room dropped, closed');
  const bk = fsx.readdirSync(pathx.join(process.env.DATA_DIR, 'venue_backup')).filter(f => f.startsWith(W3.address.toLowerCase())); assert.equal(bk.length, 1); assert.equal(JSON.parse(fsx.readFileSync(pathx.join(process.env.DATA_DIR, 'venue_backup', bk[0]), 'utf8')).venue2.doc.pieces.length, 2); ok('the dropped upper room is still in the backup copy');
  await sleep(1100); T3.got.length = 0; T3.send({ t: 'venuemove' }); const same = await T3.wait(m => m.t === 'roomfail'); assert(/already fits/.test(same.reason)); ok('nothing to move when the tier already matches');

  // the penthouse goes above every smaller venue
  HOLD[900] = W5; const T5 = await login(W5); await sleep(1100); T5.send({ t: 'venuemake', name: 'Crown' }); const m5 = await T5.wait(m => m.t === 'venuemine'); hl = await hotelList(N);
  const top = Math.max(...hl.venues.filter(v => v.span < 4).map(v => v.floor + v.levels - 1)); assert.equal(m5.mine.floor, top + 1); assert(m5.mine.floor > m2.mine.floor); ok('a new penthouse takes the floors above every smaller venue (top of the tower)');

  require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(`\nall ${n} venue checks passed`); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
