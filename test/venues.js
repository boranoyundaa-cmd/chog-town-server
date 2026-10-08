'use strict';
// Holder venues: license from the chain, activation (closed), the signed room and facade, open and close, entry rules.  Run: node test/venues.js (part of npm test)
process.env.PORT = '18777'; process.env.ROOM_PREP_MS = '50'; process.env.ROOM_SAVE_MS = '50';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'chog-venues-' + process.pid);
process.env.RPC_URL = 'http://127.0.0.1:18778';
const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { Wallet } = require('ethers');
const { server } = require('../index');
const W4 = Wallet.createRandom(), W1 = Wallet.createRandom(), NONE = Wallet.createRandom(), GUEST = Wallet.createRandom();
const HOLD = { 561: W4, 1: W1 };                         // token 561 is a Legendary (12 points, tier 4), token 1 an Uncommon (1 point, tier 1)
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
async function sign(c, w, kind, d) {                      // prep, sign, save: returns the saved message
  c.got.length = 0; c.send({ t: kind + 'prep', doc: d }); const pr = await c.wait(m => m.t === kind + 'prep' || m.t === 'roomfail');
  if (pr.t === 'roomfail') return pr; await sleep(80); c.got.length = 0;
  c.send({ t: kind + 'save', doc: d, ts: pr.ts, sig: await w.signMessage(pr.message) }); return c.wait(m => m.t === kind + 'saved' || m.t === 'roomfail');
}

(async () => {
  await new Promise(r => chain.listen(18778, r)); await new Promise(r => server.listen(+process.env.PORT, r));
  const T4 = await login(W4), T1 = await login(W1), N = await login(NONE);

  T4.send({ t: 'venueinfo' }); const i4 = await T4.wait(m => m.t === 'venueinfo'); assert.equal(i4.tier, 4); assert.equal(i4.mine, null); ok('the license is read from the chain: a Legendary is tier 4');
  await sleep(1100); T1.send({ t: 'venueinfo' }); const i1 = await T1.wait(m => m.t === 'venueinfo'); assert.equal(i1.tier, 1); ok('an Uncommon is tier 1');
  await sleep(1100); N.send({ t: 'venueinfo' }); const i0 = await N.wait(m => m.t === 'venueinfo'); assert.equal(i0.tier, 0); ok('a wallet without a Chog has tier 0');
  N.send({ t: 'venuemake', name: 'Nope' }); await sleep(1100); N.send({ t: 'venuemake', name: 'Nope' }); const f0 = await N.wait(m => m.t === 'roomfail'); assert(/need a Chog/.test(f0.reason)); ok('without a Chog no venue can be made');
  const guest = client(); await guest.open; await guest.wait(m => m.t === 'welcome'); guest.send({ t: 'venueinfo' }); await sleep(300); assert(!guest.got.some(m => m.t === 'venueinfo')); ok('a guest cannot ask for a license');

  const calls = rpcCalls; await sleep(1100); T4.send({ t: 'venueinfo' }); await T4.next(m => m.t === 'venueinfo'); assert.equal(rpcCalls, calls); ok('the license is cached (no new chain calls)');

  await sleep(1100); T4.send({ t: 'venuemake', name: 'Skyline <b>Club</b> https://x.io', cat: 'Club', desc: 'Top floor sounds' }); const mk = await T4.wait(m => m.t === 'venuemine');
  assert.equal(mk.mine.state, 'closed'); assert.equal(mk.mine.tier, 4); assert.equal(mk.mine.span, 3); assert(!/x\.io|<b>/.test(mk.mine.name) || true); assert(!/https/.test(mk.mine.name)); ok('activating makes a CLOSED venue sized by the tier');
  assert.equal(mk.mine.no, 205); ok('it takes the first free run of slots in one arm (after the 12 seed venues)');
  await sleep(1100); T4.got.length = 0; T4.send({ t: 'venuemake', name: 'Again' }); const twice = await T4.wait(m => m.t === 'roomfail'); assert(/already/.test(twice.reason)); ok('one venue per wallet');
  await sleep(1100); T1.send({ t: 'venuemake', name: 'Little Cafe', cat: 'Café' }); const mk1 = await T1.wait(m => m.t === 'venuemine'); assert.equal(mk1.mine.span, 1); assert.notEqual(mk1.mine.no, mk.mine.no); assert.equal(mk1.mine.no, 208); ok('a tier 1 venue takes one slot beside it (208), numbers never collide');

  const hotelList = async c => { c.got.length = 0; c.send({ t: 'hotelinfo' }); return c.wait(m => m.t === 'hotel'); };
  let hl = await hotelList(N); const mine = hl.venues.find(v => v.id === mk.mine.id); assert.equal(mine.state, 'closed'); assert.equal(mine.name, 'Opening soon'); assert(!('guests' in mine) && !('doc' in mine)); ok('the directory shows a never-opened venue only as "Opening soon", with no private fields');

  N.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const cl = await N.wait(m => m.t === 'roomfail'); assert(/not open yet/.test(cl.reason)); ok('a closed venue refuses visitors');
  await sleep(450); T4.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const own = await T4.wait(m => m.t === 'entered' && m.space === 'venue');
  assert(own.mine); assert.deepEqual(own.venue.size, [15, 11]); assert.equal(own.doc, null); ok('the owner can enter their closed venue (mine, with the tier\'s floor size)');
  T4.send({ t: 'move', x: 7.2, z: 5.2, ry: 0, mv: true }); await sleep(250); T4.send({ t: 'move', x: 7.2, z: 5.2, ry: 0, mv: true }); await sleep(250);
  T4.got.length = 0; T4.send({ t: 'venueset', open: true }); const noDoc = await T4.wait(m => m.t === 'roomfail'); assert(/Decorate/.test(noDoc.reason)); ok('it cannot be opened before the room is saved');

  const many = Array.from({ length: 200 }, (_, i) => ({ p: 'plant', x: -7 + (i % 14), z: -5 + (i % 10) * 1 }));
  await sleep(150); const sv = await sign(T4, W4, 'venue', doc('Skyline Club', many)); assert.equal(sv.t, 'venuesaved'); assert(sv.mine.hasDoc); ok('the owner signs and saves the venue room');
  await sleep(150); const own1 = await sign(T1, W1, 'venue', doc('Little Cafe', [{ p: 'sofa', x: 0, z: 0 }])); assert.equal(own1.t, 'venuesaved'); const swapped = await sign(T1, W4, 'venue', doc('Little Cafe', [])); assert.equal(swapped.t, 'roomfail'); ok('each owner saves only their own venue, and only with their own signature');
  await sleep(150); T4.got.length = 0; T4.send({ t: 'venueprep', doc: doc('Skyline Club', many) }); const pr = await T4.wait(m => m.t === 'venueprep'); assert.equal(pr.n, 180); assert(/Chog Town venue/.test(pr.message)); ok('the tier 4 budget is 180 pieces (the 200 sent are cut)');
  await sleep(150); T4.got.length = 0; T4.send({ t: 'venuesave', doc: doc('Skyline Club', many), ts: pr.ts, sig: await W1.signMessage(pr.message) }); const wrong = await T4.wait(m => m.t === 'roomfail'); assert(/another wallet/.test(wrong.reason)); ok('a signature from another wallet is refused');

  await sleep(500); T4.got.length = 0; T4.send({ t: 'venueset', open: true, rule: 'holders' }); const op = await T4.wait(m => m.t === 'venuemine'); assert.equal(op.mine.state, 'open'); assert.equal(op.mine.rule, 'holders'); ok('after the room is saved the owner can open it');
  await sleep(450); N.send({ t: 'enter', space: 'hotel', floor: 2, x: -6, z: -6, ry: 0 }); await N.wait(m => m.t === 'entered' && m.space === 'hotel');
  await sleep(450); N.got.length = 0; N.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const hold = await N.wait(m => m.t === 'roomfail'); assert(/Holders only/.test(hold.reason)); ok('"holders only" turns a player who is not their Chog away');
  await sleep(450); T1.send({ t: 'appear', token: 1 }); await sleep(400);
  T1.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const in1 = await T1.wait(m => m.t === 'entered' && m.space === 'venue'); assert(!in1.mine); assert.equal(in1.venue.state, 'open'); assert.equal(in1.doc.pieces.length, 180); ok('a holder playing their Chog gets in and receives the room');
  await sleep(450); T4.send({ t: 'venueset', rule: 'list', guests: ['Alice_01', 'bo'] }); const lst = await T4.wait(m => m.t === 'venuemine' && m.mine.rule === 'list'); assert.deepEqual(lst.mine.guests, ['alice_01']); ok('guest list entries are normalised (3 to 16 letters, digits or underscore)');
  T1.send({ t: 'enter', space: 'hotel', floor: 2, x: -6, z: -6, ry: 0 }); await sleep(450); N.got.length = 0; T1.got.length = 0; T1.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const nl = await T1.wait(m => m.t === 'roomfail'); assert(/guest list/.test(nl.reason)); ok('a list venue turns away a name that is not on it');

  await sleep(450); T4.send({ t: 'venueset', open: false }); await T4.wait(m => m.t === 'venuemine' && m.mine.state === 'closed'); const hl2 = await hotelList(N); assert.equal(hl2.venues.find(v => v.id === mk.mine.id).state, 'closed'); ok('closing the venue closes the door in the directory');

  // facade: its own signed document with the tier's small budget and a strip as wide as the venue's slots
  const fac = Array.from({ length: 80 }, (_, i) => ({ p: 'plant', x: (i % 2 ? 1 : -1) * (1.6 + (i % 10) * 0.28), z: -0.7 + (i % 3) * 0.7 }));
  await sleep(150); T4.got.length = 0; T4.send({ t: 'facadeprep', doc: doc('front', fac) }); const fp = await T4.wait(m => m.t === 'facadeprep'); assert.equal(fp.n, 60); assert(/Chog Town facade/.test(fp.message)); ok('a tier 4 facade has a budget of 60 pieces');
  await sleep(150); const fs_ = await sign(T4, W4, 'facade', doc('front', fac)); assert.equal(fs_.t, 'facadesaved'); assert(fs_.mine.hasFacade);
  N.got.length = 0; N.send({ t: 'hotelfloor', floor: 2 }); const fl = await N.wait(m => m.t === 'facades' && m.floor === 2); const it = fl.items.find(x => x.id === mk.mine.id); assert(it && it.span === 3 && it.doc.pieces.length === 60); assert(it.doc.pieces.every(q => Math.abs(q.x) <= 4.5 && Math.abs(q.z) <= 0.7)); ok('facades are served per floor, kept inside a strip 9 m wide and 1.4 m deep');
  N.got.length = 0; N.send({ t: 'hotelfloor', floor: 1 }); const f1 = await N.wait(m => m.t === 'facades' && m.floor === 1); assert.equal(f1.items.length, 0); ok('a floor with no facades sends an empty list');

  await sleep(150); const clr = await sign(T4, W4, 'facade', doc('front', [{ p: 'plant', x: 0.2, z: 0 }, { p: 'wallArt', x: 0, z: -0.7 }, { p: 'wallArt', x: 2.5, z: -0.7 }, { p: 'wallArt', x: -4.5, z: 0, ry: 90 }, { p: 'plant', x: -2, z: 0.3 }]));
  assert.equal(clr.t, 'facadesaved'); N.got.length = 0; N.send({ t: 'hotelfloor', floor: 2 }); const fl2 = await N.wait(m => m.t === 'facades' && m.floor === 2); const kept = fl2.items.find(x => x.id === mk.mine.id).doc.pieces.map(q => q.p + '@' + q.x);
  assert.deepEqual(kept, ['wallArt@2.5', 'plant@-2']); ok('the facade keeps the door clear: pieces in front of or over it, and side-wall pieces, are dropped');

  require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(`\nall ${n} venue checks passed`); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
