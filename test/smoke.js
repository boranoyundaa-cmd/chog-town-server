'use strict';
// Smoke test: starts the server on a spare port and drives it with real WebSocket clients.  Run: npm test
process.env.PORT = '18767';
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
  assert(Math.abs(last[1]) <= 5.56 && Math.abs(last[2]) <= 5.56); ok('positions stay inside the island');
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
  console.log(`\nall ${n} checks passed`); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
