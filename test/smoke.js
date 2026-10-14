'use strict';
// Smoke test: starts the server on a spare port and drives it with real WebSocket clients.  Run: npm test
process.env.PORT = '18767'; process.env.ROOM_PREP_MS = '50'; process.env.ROOM_SAVE_MS = '50';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'chog-test-' + process.pid);       // rooms are written here, not into server/data
process.env.RPC_URL = 'http://127.0.0.1:18768';          // a stand-in for the chain: ownerOf(1700) is the test wallet, everything else is someone else
const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { Wallet } = require('ethers');
const { server } = require('../index');
const OWNER = Wallet.createRandom();
const chain = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    const q = JSON.parse(body), tok = parseInt(q.params[0].data.slice(10), 16), who = tok === 1700 ? OWNER.address : '0x' + '1'.repeat(40);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + who.slice(2).toLowerCase().padStart(64, '0') }));
  });
});

const URL = 'ws://127.0.0.1:' + process.env.PORT;
function client() {
  const ws = new WebSocket(URL), c = { ws, got: [], send: m => ws.send(JSON.stringify(m)) };
  ws.on('message', d => { const m = JSON.parse(d); c.got.push(m); (c.waiters || []).slice().forEach(w => w(m)); });
  c.waiters = [];
  c.wait = (pred, ms = 4000) => new Promise((res, rej) => {
    const hit = c.got.find(pred); if (hit) return res(hit);
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + pred)), ms);
    const w = m => { if (pred(m)) { clearTimeout(t); c.waiters.splice(c.waiters.indexOf(w), 1); res(m); } }; c.waiters.push(w);
  });
  c.open = new Promise(r => ws.on('open', r));
  return c;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0; const ok = name => console.log(`  ok ${++n} ${name}`);

(async () => {
  await new Promise(r => chain.listen(18768, r)); await new Promise(r => server.listen(+process.env.PORT, r));
  const a = client(), b = client(); await a.open; await b.open;
  const wa = await a.wait(m => m.t === 'welcome'); await b.wait(m => m.t === 'welcome');
  assert(wa.challenge.includes('Nonce:')); ok('welcome carries a sign-in challenge');
  const joinB = await a.wait(m => m.t === 'join'); assert(joinB.p.name.startsWith('Guest-')); ok('A sees B join as a guest');

  b.send({ t: 'move', x: 1, z: 2, ry: 0.5, mv: true }); await sleep(60);
  let st = await a.wait(m => m.t === 'state' && m.p.some(r => r[0] === joinB.p.id)); const row = st.p.find(r => r[0] === joinB.p.id);
  assert(row[1] > 0.5 && row[1] <= 1.01); ok('a plausible move is relayed (clamped to what speed allows)');

  b.send({ t: 'move', x: 99, z: -99, ry: 0, mv: true }); await sleep(250);
  const last = a.got.filter(m => m.t === 'state').pop().p.find(r => r[0] === joinB.p.id);
  assert(Math.abs(last[1]) <= 9.96 && Math.abs(last[2]) <= 9.96); ok('positions stay inside the town');
  a.send({ t: 'move', x: 0.5, z: 1.9, ry: 0, mv: false }); await sleep(120);
  for (let i = 0; i < 4; i++) { a.send({ t: 'move', x: -5, z: -5, ry: 0, mv: true }); await sleep(30); }
  await a.wait(m => m.t === 'snap'); ok('teleporting gets the client snapped back');

  a.send({ t: 'chat', text: 'hello town' }); const c1 = await b.wait(m => m.t === 'chat' && m.text === 'hello town'); assert.equal(c1.name, wa.name); ok('chat reaches others with the sender name');
  await sleep(50); a.send({ t: 'chat', text: 'check https://evil.xyz/claim now' });
  const c2 = await b.wait(m => m.t === 'chat' && /check/.test(m.text)); assert(!/evil/.test(c2.text) && /link removed/.test(c2.text)); ok('links are stripped');
  a.send({ t: 'chat', text: 'send to 0x' + 'a'.repeat(40) + ' please' });
  const c3 = await b.wait(m => m.t === 'chat' && /please/.test(m.text)); assert(!/0xa/.test(c3.text)); ok('wallet addresses are stripped');
  b.send({ t: 'chat', text: 'what the f*** is this sh1t' });
  const c4 = await a.wait(m => m.t === 'chat' && /this/.test(m.text)); assert.equal(c4.text, 'what the f*** is this sh1t'); ok('words are not filtered (no profanity filter by design)');
  for (let i = 0; i < 6; i++) { b.send({ t: 'chat', text: 'spam ' + i }); await sleep(20); }
  await b.wait(m => m.t === 'sys' && /Slow down/.test(m.text)); ok('chat is rate limited');

  const wallet = Wallet.createRandom();
  a.send({ t: 'auth', addr: wallet.address, sig: await wallet.signMessage(wa.challenge) });
  const au = await a.wait(m => m.t === 'authed'); assert.equal(au.addr, wallet.address.toLowerCase()); ok('a valid wallet signature is accepted');
  const bad = client(); await bad.open; const wb = await bad.wait(m => m.t === 'welcome');
  bad.send({ t: 'auth', sig: await wallet.signMessage('some other message') });
  const au2 = await bad.wait(m => m.t === 'authed' || m.t === 'authfail'); assert(au2.t === 'authed' && au2.addr !== wallet.address.toLowerCase()); ok('a signature over another message does not prove this wallet');
  bad.send({ t: 'appear', token: 1700 }); await bad.wait(m => m.t === 'sys'); ok('claiming a Chog you do not own is refused');
  const a2 = client(); await a2.open; await a2.wait(m => m.t === 'welcome');
  a2.send({ t: 'auth', session: au.session }); const au3 = await a2.wait(m => m.t === 'authed'); assert.equal(au3.addr, au.addr); ok('a session token resumes the proof without signing again');
  a2.send({ t: 'appear', token: 5 }); await a2.wait(m => m.t === 'sys' && /not in your wallet|Could not check/.test(m.text)); ok('appear checks ownership on chain');

  const h1 = client(); await h1.open; const wh = await h1.wait(m => m.t === 'welcome');
  h1.send({ t: 'auth', sig: await OWNER.signMessage(wh.challenge) }); await h1.wait(m => m.t === 'authed');
  h1.send({ t: 'appear', token: 1700 }); const ap = await a.wait(m => m.t === 'appear' && m.p.token === 1700); assert.equal(ap.p.name, 'Chog #1700'); ok('the real owner appears as Chog #1700 to everyone');
  h1.send({ t: 'chat', text: 'holder here' }); const hc = await a.wait(m => m.t === 'chat' && m.text === 'holder here'); assert.equal(hc.token, 1700); ok('holder chat carries the Chog name');
  const h2 = client(); await h2.open; const wh2 = await h2.wait(m => m.t === 'welcome');
  h2.send({ t: 'auth', sig: await OWNER.signMessage(wh2.challenge) }); await h2.wait(m => m.t === 'authed'); h2.send({ t: 'appear', token: 1700 });
  await h1.wait(m => m.t === 'sys' && /another window/.test(m.text)); ok('the same Chog in a second window replaces the first');
  h2.send({ t: 'logout' }); const lo = await a.wait(m => m.t === 'appear' && m.p.id === wh2.id && m.p.token === null); assert(lo.p.name.startsWith('Guest-')); ok('logout turns the player back into a guest');

  for (const r of [b, a2, bad]) { r.send({ t: 'report', id: wa.id, reason: 'test' }); await sleep(30); }
  await a.wait(m => m.t === 'sys' && /muted/.test(m.text)); ok('three reports mute the reported player');
  a.send({ t: 'chat', text: 'am I muted' }); await a.wait(m => m.t === 'sys' && /muted for/.test(m.text)); ok('a muted player cannot chat');

  b.ws.close(); await a.wait(m => m.t === 'leave' && m.id === joinB.p.id); ok('leave is broadcast');

  // ---------- spaces and rooms
  for (const c of [a, a2, bad, h1, h2]) c.ws.close(); await sleep(300);                // the per-IP connection limit is 6
  const login = async (w) => { const c = client(); await c.open; const wc = await c.wait(m => m.t === 'welcome'); c.id = wc.id; c.send({ t: 'auth', sig: await w.signMessage(wc.challenge) }); await c.wait(m => m.t === 'authed'); return c; };
  const ow = Wallet.createRandom(), friend = Wallet.createRandom();
  const R1 = await login(ow), F1 = await login(friend), town = client(); await town.open; const wt = await town.wait(m => m.t === 'welcome');
  const spawn = { x: 2.9, z: -2.3, ry: 0 };
  R1.send({ t: 'enter', space: 'room', who: 'me', ...spawn }); const e1 = await R1.wait(m => m.t === 'entered'); assert.equal(e1.space, 'room'); assert.equal(e1.doc, null); assert(e1.mine); ok('entering your own room before saving gives an empty room (the client brings its starter)');
  await town.wait(m => m.t === 'leave' && m.id === R1.id); ok('the town sees the player leave when they enter a room');
  R1.send({ t: 'move', x: 2.9, z: -2.0, ry: 0, mv: true }); await sleep(250);
  assert(!town.got.some(m => m.t === 'state' && m.p.some(r => r[0] === R1.id))); ok('movement inside a room does not reach the town');
  R1.send({ t: 'chat', text: 'secret room talk' }); await sleep(200); assert(!town.got.some(m => m.t === 'chat' && m.text === 'secret room talk')); ok('room chat stays in the room');
  R1.send({ t: 'move', x: 40, z: 40, ry: 0, mv: true }); await sleep(200); R1.send({ t: 'move', x: 40, z: 40, ry: 0, mv: true }); await sleep(150);

  const doc = { name: 'Neon <b>lounge</b> https://evil.xyz', theme: 'cyberpunk', view: 'neon', ambience: 'night', wall: { c: '#112233', pat: 'brick' }, floor: { c: 'red', pat: 'nope' }, windows: false, custom: { x: { parts: [] } },
    pieces: [{ p: 'sofa', x: 0.123, z: 1.5, ry: 180 }, { p: 'wallText', x: -4.5, z: 0.5, ry: 90, txt: 'HELLO https://bad.io 0x' + 'a'.repeat(40) + ' world', c: '#ff00ff' }, { p: 'doesNotExist', x: 0, z: 0 }, { p: 'nftFrame', x: 0, z: -3.5, img: 'http://x/y.png' }, { p: 'bed', x: 99, z: -99, ry: 45, k: 3, y: 2 }] };
  R1.send({ t: 'roomprep', doc }); const prep = await R1.wait(m => m.t === 'roomprep'); assert(prep.message.includes('Hash:') && prep.n === 3); ok('roomprep returns the cleaned room (3 valid pieces) and a message to sign');
  await sleep(150);
  const sig = await ow.signMessage(prep.message);
  F1.send({ t: 'roomsave', doc, ts: prep.ts, sig }); const ff = await F1.wait(m => m.t === 'roomfail'); assert(/another wallet|not valid/.test(ff.reason)); ok('a signature from another wallet is refused');
  await sleep(150); R1.send({ t: 'roomsave', doc: Object.assign({}, doc, { name: 'Changed after signing' }), ts: prep.ts, sig }); const f2 = await R1.wait(m => m.t === 'roomfail'); assert(/another wallet|not valid/.test(f2.reason)); ok('a signature over a different document is refused');
  await sleep(150); R1.send({ t: 'roomsave', doc, ts: prep.ts - 5 * 60e3, sig }); const f3 = await R1.wait(m => m.t === 'roomfail' && /old/.test(m.reason)); ok('an old signature is refused');
  await sleep(150); R1.send({ t: 'roomsave', doc, ts: prep.ts, sig }); const sv = await R1.wait(m => m.t === 'roomsaved'); assert(sv.hash && sv.at); ok('the owner\'s signature stores the room');

  F1.got.length = 0; F1.send({ t: 'enter', space: 'room', who: ow.address.toLowerCase(), ...spawn }); const priv = await F1.wait(m => m.t === 'roomfail'); assert(/private/.test(priv.reason)); ok('a Home is private: entering without an invitation is refused');
  await sleep(800); F1.got.length = 0; F1.send({ t: 'enter', space: 'room', who: ow.address.toLowerCase(), inv: 'f'.repeat(24), ...spawn }); const priv2 = await F1.wait(m => m.t === 'roomfail'); assert(/private/.test(priv2.reason)); ok('a made-up link token is refused');
  R1.send({ t: 'enter', space: 'city', ...spawn }); await sleep(800); R1.send({ t: 'enter', space: 'room', who: 'me', ...spawn }); await R1.wait(m => m.t === 'entered' && m.space === 'room' && m.doc);
  F1.send({ t: 'invite', id: R1.id }); await sleep(100); assert(!R1.got.some(m => m.t === 'invited')); ok('a player without a saved Home cannot invite (and cannot invite the owner either)');
  R1.send({ t: 'invite', id: F1.id }); const inv1 = await F1.wait(m => m.t === 'invited'); assert.equal(inv1.owner, ow.address.toLowerCase()); assert.equal(inv1.fromId, R1.id); ok('the invitation carries the stable id of the sender (the client no longer matches by name)'); ok('the owner invites a player and they get the invitation');
  await sleep(800); F1.got.length = 0; F1.send({ t: 'enter', space: 'city', ...spawn }); F1.send({ t: 'enter', space: 'city', ...spawn }); const tw = await F1.wait(m => m.t === 'enterwait'); assert(tw.after > 0 && tw.after <= 400); ok('an enter that comes too soon is answered with an explicit enterwait (retry-after)');
  await sleep(800); F1.send({ t: 'enter', space: 'room', who: inv1.owner, ...spawn }); const e2 = await F1.wait(m => m.t === 'entered' && m.space === 'room'); assert(!e2.mine); assert.equal(e2.owner, ow.address.toLowerCase());
  assert(e2.players.some(q => q.id === R1.id)); ok('an invited friend can enter the Home and sees the owner there');
  const d = e2.doc; assert.equal(d.theme, 'cyberpunk'); assert.equal(d.view, 'neon'); assert(!('ambience' in d)); assert.equal(d.windows, false); assert.deepEqual(d.wall, { c: '#112233', pat: 'brick' }); assert(!d.floor); assert(!('custom' in d)); ok('the stored room keeps the valid settings and drops everything else');
  assert.equal(d.pieces.length, 3); assert(d.pieces.every(q => !('img' in q) && !('k' in q) && !('y' in q))); const bed = d.pieces.find(q => q.p === 'bed'); assert.deepEqual(bed, { p: 'bed', x: 6.5, z: -5, ry: 90 }); ok('unknown pieces, images, scale and height are stripped; positions are clamped to the 13 x 10 floor');
  const wt0 = d.pieces.find(q => q.p === 'wallText'); assert.equal(wt0.x, -6.5); assert.equal(wt0.ry, 90); ok('a wall piece is put on its wall (x = -6.5), so a room that changed size leaves nothing floating');
  const wt2 = d.pieces.find(q => q.p === 'wallText'); assert(!/bad\.io|0xaaaa/.test(wt2.txt) && /HELLO/.test(wt2.txt) && wt2.c === '#ff00ff'); assert(!/evil|https/.test(d.name)); ok('links and wallet addresses are removed from room text');
  const sawF = await R1.wait(m => m.t === 'join' && m.p.id === F1.id); ok('the owner sees the visitor arrive');
  F1.send({ t: 'chat', text: 'nice place' }); await R1.wait(m => m.t === 'chat' && m.text === 'nice place'); ok('visitors and the owner chat inside the room');
  await sleep(150); const p2 = await (async () => { R1.got.length = 0; R1.send({ t: 'roomprep', doc: Object.assign({}, doc, { name: 'Second look', pieces: doc.pieces.slice(0, 1) }) }); return R1.wait(m => m.t === 'roomprep'); })();
  await sleep(150); R1.send({ t: 'roomsave', doc: Object.assign({}, doc, { name: 'Second look', pieces: doc.pieces.slice(0, 1) }), ts: p2.ts, sig: await ow.signMessage(p2.message) }); await R1.wait(m => m.t === 'roomsaved');
  const live = await F1.wait(m => m.t === 'roomdoc'); assert.equal(live.doc.name, 'Second look'); ok('visitors receive the new look when the owner saves');

  town.send({ t: 'enter', space: 'room', who: Wallet.createRandom().address, ...spawn }); const nf = await town.wait(m => m.t === 'roomfail'); assert(/private/.test(nf.reason)); ok('entering a Home nobody invited you to is refused');
  town.got.length = 0; town.send({ t: 'invlink' }); const nl = await town.wait(m => m.t === 'roomfail'); assert(/Save your Home/.test(nl.reason)); ok('a guest cannot make an invite link');
  R1.send({ t: 'invlink' }); const lk = await R1.wait(m => m.t === 'invlink'); assert(/^[0-9a-f]{24}$/.test(lk.token)); R1.got.length = 0; R1.send({ t: 'invlink' }); const lk2 = await R1.wait(m => m.t === 'invlink'); assert.equal(lk2.token, lk.token); ok('the owner gets a share link, and asking again returns the same one');
  await sleep(800); town.got.length = 0; town.send({ t: 'enter', space: 'room', who: ow.address.toLowerCase(), inv: lk.token, ...spawn }); const viaLink = await town.wait(m => m.t === 'entered' && m.space === 'room'); assert.equal(viaLink.owner, ow.address.toLowerCase()); ok('anyone with the link token can enter');
  R1.got.length = 0; R1.send({ t: 'invlink', renew: true }); const lk3 = await R1.wait(m => m.t === 'invlink'); assert.notEqual(lk3.token, lk.token);
  await sleep(800); town.send({ t: 'enter', space: 'city', ...spawn }); await sleep(800); town.got.length = 0; town.send({ t: 'enter', space: 'room', who: ow.address.toLowerCase(), inv: lk.token, ...spawn }); const old = await town.wait(m => m.t === 'roomfail'); assert(/private/.test(old.reason)); ok('renewing the link revokes the old one');
  town.got.length = 0; town.send({ t: 'roomprep', doc }); const gp = await town.wait(m => m.t === 'roomfail'); assert(/wallet/.test(gp.reason)); ok('a guest cannot save a room');
  await sleep(800); F1.send({ t: 'enter', space: 'city', x: -4.8, z: -2.35, ry: 0 }); const back = await F1.wait(m => m.t === 'entered' && m.space === 'city'); assert(back.players.some(q => q.id === wt.id)); ok('leaving a room returns to the town and its players');
  await R1.wait(m => m.t === 'leave' && m.id === F1.id); ok('the room sees the visitor leave');
  // ---------- hotel
  F1.got.length = 0; F1.send({ t: 'hotelinfo' }); const hi = await F1.wait(m => m.t === 'hotel'); assert(hi.floors >= 2 && hi.venues.length >= 10 && hi.venues.every(v => v.id && v.no && v.name && !('doc' in v))); ok('the hotel directory lists the venues (without their room documents)');
  assert(hi.venues.some(v => v.no === 101 && v.floor === 1)); assert(new Set(hi.venues.map(v => v.no)).size === hi.venues.length); ok('venue numbers are unique and carry their floor');
  await sleep(450); F1.send({ t: 'enter', space: 'hotel', floor: 0, x: 3.6, z: -2.2, ry: 0 }); const hl = await F1.wait(m => m.t === 'entered' && m.space === 'hotel'); assert.equal(hl.floor, 0); assert(hl.counts && typeof hl.counts === 'object'); ok('a player can enter the hotel lobby (floor 0)');
  await sleep(450); F1.got.length = 0; F1.send({ t: 'enter', space: 'hotel', floor: 99 }); const nofl = await F1.wait(m => m.t === 'roomfail'); assert(/no such floor/.test(nofl.reason)); ok('a floor that does not exist is refused');
  await sleep(450); F1.send({ t: 'enter', space: 'hotel', floor: 1, x: -6, z: -6, ry: 0 }); await F1.wait(m => m.t === 'entered' && m.floor === 1);
  F1.send({ t: 'move', x: 40, z: 40, ry: 0, mv: true }); await sleep(200); F1.send({ t: 'move', x: 40, z: 40, ry: 0, mv: true }); await sleep(150);
  town.send({ t: 'enter', space: 'hotel', floor: 1, x: -6, z: -6, ry: 0 }); const tf = await town.wait(m => m.t === 'entered' && m.space === 'hotel' && m.floor === 1); assert(tf.players.some(q => q.id === F1.id)); ok('players on the same floor see each other');
  assert(!tf.players.some(q => q.id === R1.id)); ok('the hotel floors are separate from the town and the rooms');
  await sleep(450); R1.send({ t: 'enter', space: 'venue', id: 'v101', x: 2.9, z: -2.3, ry: 0 }); const vn = await R1.wait(m => m.t === 'entered' && m.space === 'venue'); assert.equal(vn.venue.name, 'Moka Corner'); assert(vn.doc && vn.doc.pieces.length > 10 && vn.doc.theme === 'studio'); ok('entering a venue gives its room document and its info');
  const cn = await F1.wait(m => m.t === 'counts' && m.c.v101 === 1); assert(cn); ok('players in the hotel are told how many people are inside each venue');
  await sleep(450); R1.got.length = 0; R1.send({ t: 'enter', space: 'venue', id: 'nope' }); const nv = await R1.wait(m => m.t === 'roomfail'); assert(/does not exist/.test(nv.reason)); ok('an unknown venue is refused');
  R1.send({ t: 'chat', text: 'venue talk' }); await sleep(200); assert(!F1.got.some(m => m.t === 'chat' && m.text === 'venue talk')); ok('venue chat stays inside the venue');
  const lastF = F1.got.filter(m => m.t === 'state').pop(); assert(!lastF || lastF.p.every(r => Math.abs(r[1]) <= 7.81 && Math.abs(r[2]) <= 7.81)); ok('walking limits apply on a hotel floor');
  const big = client(); await big.open; await big.wait(m => m.t === 'welcome'); big.send({ t: 'chat', text: 'x'.repeat(5000) }); await sleep(150); assert(big.ws.readyState === 1); ok('oversized chat frames are ignored');

  require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  console.log(`\nall ${n} checks passed`); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
