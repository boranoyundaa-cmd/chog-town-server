'use strict';
// The phone companion: a pairing code from the signed-in PC, the key the phone keeps, its room, live numbers, the lock, that a phone is invisible and can do nothing else, and Lev's notifications.  Run: node test/phone.js (part of npm test)
process.env.PORT = '18787'; process.env.ROOM_PREP_MS = '50'; process.env.ROOM_SAVE_MS = '50'; process.env.VENUE_MS = '60'; process.env.MAX_PER_IP = '40';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'chog-phone-' + process.pid);
process.env.RPC_URL = 'http://127.0.0.1:1'; process.env.PUSH_FAKE = '1';                // no chain: a free room needs none
const assert = require('assert');
const WebSocket = require('ws');
const { Wallet } = require('ethers');
const { server, clock, push, pushSent } = require('../index');
const URL = 'ws://127.0.0.1:' + process.env.PORT;
function client(phone) {
  const ws = new WebSocket(URL + (phone ? '/?phone=1' : '')), c = { ws, got: [], send: m => ws.send(JSON.stringify(m)), waiters: [] };
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

(async () => {
  await new Promise(r => server.listen(+process.env.PORT, r));
  const W = Wallet.createRandom(), addr = W.address.toLowerCase();
  const pc = await login(W);
  pc.send({ t: 'checkinprep' }); const prep = await pc.wait(m => m.t === 'checkinprep'); await sleep(80);
  pc.send({ t: 'checkin', ts: prep.ts, sig: await W.signMessage(prep.message) }); const ci = await pc.wait(m => m.t === 'checkin'); assert(ci.ok);
  const town = client(); await town.open; await town.wait(m => m.t === 'welcome');

  const guestPc = client(); await guestPc.open; await guestPc.wait(m => m.t === 'welcome'); guestPc.send({ t: 'phonekey' });
  assert(/wallet/.test((await guestPc.wait(m => m.t === 'roomfail')).reason)); ok('a guest gets no phone key');
  pc.send({ t: 'phonekey' }); const k1 = await pc.wait(m => m.t === 'phonekey'); assert(/^[A-Z2-9]{8}$/.test(k1.code) && k1.exp > Date.now()); ok('the signed-in PC gets an 8-letter one-time code');

  const ph = client(true); await ph.open; const pw = await ph.wait(m => m.t === 'welcome'); assert(pw.phone && !pw.players); ok('a phone connection gets a bare welcome (nobody in it)');
  await sleep(150); assert(!town.got.some(m => m.t === 'join' && m.p.id === pw.id)); ok('the town never sees the phone join');
  ph.send({ t: 'chat', text: 'hello' }); ph.send({ t: 'move', x: 1, z: 1, ry: 0, mv: 1 }); ph.send({ t: 'm_room' });
  assert(/not paired/.test((await ph.wait(m => m.t === 'phonefail')).reason)); await sleep(150); assert(!town.got.some(m => m.t === 'chat')); ok('an unpaired phone can do nothing (no chat, no room)');
  ph.send({ t: 'phonepair', code: 'AAAAAAAA' }); assert(/expired|used/.test((await ph.wait(m => m.t === 'phonefail' && /expired|used/.test(m.reason))).reason)); ok('a wrong code is refused');
  ph.got.length = 0; ph.send({ t: 'phonepair', code: k1.code.toLowerCase() }); const po = await ph.wait(m => m.t === 'phoneok'); assert(po.addr === addr && po.key.length === 48); ok('the code pairs the phone (case does not matter) and gives it a key');
  const ph2 = client(true); await ph2.open; await ph2.wait(m => m.t === 'welcome'); ph2.send({ t: 'phonepair', code: k1.code }); await ph2.wait(m => m.t === 'phonefail'); ok('a code works once');

  ph.got.length = 0; ph.send({ t: 'm_room' }); const mr = await ph.wait(m => m.t === 'm_room');
  assert(mr.room && mr.room.no === ci.no && Array.isArray(mr.room.size) && mr.camera === false && mr.inside === 0 && mr.today.visitors === 0 && Array.isArray(mr.events)); ok('the phone reads its room: number, size, no camera, nobody inside');

  const V = Wallet.createRandom(), vis = await login(V); vis.send({ t: 'enter', space: 'venue', id: mr.room.id, x: 0, z: 0, ry: 0 }); await vis.wait(m => m.t === 'entered');
  const cnt = await ph.wait(m => m.t === 'm_count' && m.inside === 1); assert.equal(cnt.today.visitors, 1); ok('a visitor walks in: the phone hears the head count and today\'s visitors');
  pc.send({ t: 'enter', space: 'venue', id: mr.room.id, x: 0, z: 0, ry: 0 }); await pc.wait(m => m.t === 'entered'); await ph.wait(m => m.t === 'm_count' && m.inside === 2);
  assert.equal(ph.got.filter(m => m.t === 'm_count').pop().today.visitors, 1); ok('the owner walking in is not a visitor');

  await sleep(100); ph.send({ t: 'roomlock', locked: true }); const lk = await ph.wait(m => m.t === 'lock'); assert(lk.ok && lk.locked); ok('the phone locks the room');
  const late = await login(Wallet.createRandom()); late.send({ t: 'enter', space: 'venue', id: mr.room.id, x: 0, z: 0, ry: 0 }); await late.wait(m => m.t === 'roomfail'); ok('then a new visitor cannot get in');

  const ph3 = client(true); await ph3.open; await ph3.wait(m => m.t === 'welcome'); ph3.send({ t: 'phoneauth', key: po.key }); const pa = await ph3.wait(m => m.t === 'phoneauth'); assert(pa.ok && pa.addr === addr); ok('the kept key signs the phone in on the next visit');
  ph3.got.length = 0; ph3.send({ t: 'phoneauth', key: 'nope' }); assert.equal((await ph3.wait(m => m.t === 'phoneauth')).ok, false); ok('a made-up key is refused');

  const keys = []; for (let i = 0; i < 3; i++) { pc.got.length = 0; pc.send({ t: 'phonekey' }); const k = await pc.wait(m => m.t === 'phonekey'); const q = client(true); await q.open; await q.wait(m => m.t === 'welcome'); q.send({ t: 'phonepair', code: k.code }); keys.push((await q.wait(m => m.t === 'phoneok')).key); q.ws.close(); }
  const ph4 = client(true); await ph4.open; await ph4.wait(m => m.t === 'welcome'); ph4.send({ t: 'phoneauth', key: po.key }); assert.equal((await ph4.wait(m => m.t === 'phoneauth')).ok, false); ok('a wallet keeps 3 phone keys: a fourth pairing retires the oldest');

  // Lev's notifications (push.js, PUSH_FAKE collects them)
  ph3.got.length = 0; ph3.send({ t: 'push_key' }); assert.equal(typeof (await ph3.wait(m => m.t === 'push_key')).key, 'string'); ok('the phone gets the push key of the server');
  const SUB = { endpoint: 'https://push.test/a', keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } };
  ph3.send({ t: 'push_sub', sub: { endpoint: 'http://evil/x', keys: SUB.keys } }); await ph3.wait(m => m.t === 'phonefail' && /subscription/.test(m.reason)); ok('a subscription that is not https is refused');
  ph3.got.length = 0; ph3.send({ t: 'push_sub', sub: SUB }); const ps = await ph3.wait(m => m.t === 'push'); assert(ps.on && ps.prefs.visit && ps.prefs.tip); ok('the phone subscribes: visits and tips on');
  await sleep(100); ph3.got.length = 0; ph3.send({ t: 'roomlock', locked: false }); await ph3.wait(m => m.t === 'lock');
  const walkIn = async () => { const c = await login(Wallet.createRandom()); c.send({ t: 'enter', space: 'venue', id: mr.room.id, x: 0, z: 0, ry: 0 }); await c.wait(m => m.t === 'entered'); await sleep(120); c.ws.close(); };
  await walkIn(); assert.equal(pushSent.length, 0); ok('no visit notice while the owner is at the PC');
  pc.ws.close(); await sleep(150); await walkIn(); assert.equal(pushSent.length, 1); assert(pushSent[0].kind === 'visit' && pushSent[0].body.includes(String(mr.room.no)) && !pushSent[0].body.includes('*stamp*')); ok('the owner away: Lev rings the phone about the visitor (room number, no stamp marker)');
  await walkIn(); assert.equal(pushSent.length, 1); ok('a second visitor within 30 minutes rings nothing');
  clock.skew += 31 * 60e3; await walkIn(); assert.equal(pushSent.length, 2); ok('after 30 minutes the next visitor rings again');
  ph3.got.length = 0; ph3.send({ t: 'push_prefs', endpoint: SUB.endpoint, prefs: { visit: false, tip: true } }); assert.equal((await ph3.wait(m => m.t === 'push')).prefs.visit, false);
  clock.skew += 31 * 60e3; await walkIn(); assert.equal(pushSent.length, 2); ok('visit notices off: nothing');
  ph3.got.length = 0; ph3.send({ t: 'push_remind', endpoint: SUB.endpoint, at: Date.now() + clock.skew + 60e3 }); assert((await ph3.wait(m => m.t === 'push')).remind > 0);
  assert.equal(await push.tick(), 0); clock.skew += 61e3; assert.equal(await push.tick(), 1); assert.equal(pushSent[2].kind, 'remind'); assert.equal(await push.tick(), 0); ok('a reminder rings once, when it is due');
  ph3.got.length = 0; ph3.send({ t: 'push_remind', endpoint: SUB.endpoint, at: Date.now() + clock.skew + 5 * 86400e3 }); assert.equal((await ph3.wait(m => m.t === 'push')).remind, null); ok('a reminder more than 2 days ahead is refused');
  const GONE = { endpoint: 'https://push.test/gone', keys: SUB.keys }; ph3.got.length = 0; ph3.send({ t: 'push_sub', sub: GONE }); await ph3.wait(m => m.t === 'push');
  ph3.got.length = 0; ph3.send({ t: 'push_remind', endpoint: GONE.endpoint, at: Date.now() + clock.skew + 1000 }); await ph3.wait(m => m.t === 'push'); clock.skew += 2000; await push.tick();
  ph3.got.length = 0; ph3.send({ t: 'push_state', endpoint: GONE.endpoint }); assert.equal((await ph3.wait(m => m.t === 'push')).on, false); ok('a subscription the push service calls gone is dropped');
  ph3.got.length = 0; ph3.send({ t: 'push_unsub', endpoint: SUB.endpoint }); assert.equal((await ph3.wait(m => m.t === 'push')).on, false); ok('the phone turns notifications off');

  for (const c of [pc, town, guestPc, ph, ph2, ph3, ph4, vis, late]) c.ws.close();
  console.log(`\nall ${n} phone checks passed`); server.close(); require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true }); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
