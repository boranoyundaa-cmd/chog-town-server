'use strict';
// Chog Town realtime server: presence (who is where) and chat. It holds no money and no ownership;
// the only thing it takes from the chain is "does this wallet own this Chog" (eth_call ownerOf), and it never signs anything.
//
// Protocol (JSON text frames). Client -> server:
//   auth {addr, sig} | auth {session}   prove a wallet (sig signs `challenge`), or resume a recent proof
//   appear {token|null}                 look like Chog #token (must be owned by the authed wallet) or the default Chog
//   logout {}                           drop the wallet, become a guest again
//   move {x, z, ry, mv}                 position report, ~10 per second
//   chat {text}  report {id, reason}
// Server -> client: welcome, authed, authfail, appear (full player), join, leave, state, snap, chat, sys.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { verifyMessage } = require('ethers');
const { clean } = require('./filter');

const CFG = {
  port: +process.env.PORT || 8767,
  rpc: process.env.RPC_URL || 'https://rpc.monad.xyz',
  nft: (process.env.NFT_ADDR || '0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763').toLowerCase(),
  origins: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),   // empty = any origin (dev)
  half: 8.2, limit: 8.2 - 0.45,                   // half size of the town slab and the walkable limit (HALF in prototype/js/world_city.js)
  speed: 2.7, tolerance: 1.6,                     // client walk speed and how much faster than that we still accept
  maxPlayers: +process.env.MAX_PLAYERS || 200, maxPerIp: +process.env.MAX_PER_IP || 6,
  tickMs: 100, pingMs: 20000, sessionMs: 12 * 3600e3,
  chatMax: 140, chatBurst: 3, chatWindowMs: 6000, spamMuteMs: 30e3,
  reportMuteAt: 3, reportMuteMs: 10 * 60e3, reportWindowMs: 10 * 60e3,
};
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- state
let nextId = 1;
const players = new Map();            // id -> player
const byToken = new Map();            // verified token id -> player (one session per Chog)
const sessions = new Map();           // session secret -> { addr, exp }
const ipCount = new Map();
const recent = [];                    // last chat lines, kept for report context
const stats = { connected: 0, chat: 0, filtered: 0, reports: 0, snaps: 0 };

const now = () => Date.now();
const r2 = v => Math.round(v * 100) / 100;
const send = (p, m) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(m)); };
const broadcast = (m, except) => { const s = JSON.stringify(m); for (const p of players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s); };
const sys = (p, text) => send(p, { t: 'sys', text });
const pub = p => ({ id: p.id, name: p.name, token: p.token, x: r2(p.x), z: r2(p.z), ry: r2(p.ry), mv: p.mv ? 1 : 0 });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- chain: owner of a token (raw JSON-RPC, no library)
async function ownerOf(token) {
  const data = '0x6352211e' + token.toString(16).padStart(64, '0');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(CFG.rpc, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: CFG.nft, data }, 'latest'] }) });
    const j = await r.json();
    if (!j.result) throw new Error(j.error ? j.error.message : 'no result');
    return '0x' + j.result.slice(-40).toLowerCase();
  } finally { clearTimeout(timer); }
}
const challengeText = nonce => `Chog Town sign-in\nThis proves you control this wallet. It costs nothing and sends no transaction.\nNonce: ${nonce}`;

function setLook(p, token) {                       // token is already verified (or null for the default Chog)
  if (p.token && byToken.get(p.token) === p) byToken.delete(p.token);
  if (token) {
    const old = byToken.get(token);
    if (old && old !== p) { send(old, { t: 'sys', text: 'This Chog joined from another window.' }); old.ws.close(4001, 'replaced'); }
    byToken.set(token, p);
  }
  p.token = token || null;
  p.name = token ? `Chog #${token}` : p.guest;
  broadcast({ t: 'appear', p: pub(p) });
}

// ---------- chat: filter, rate limit, report
function onChat(p, raw) {
  if (typeof raw !== 'string') return;
  const t = now();
  if (p.mutedUntil > t) return sys(p, `You are muted for ${Math.ceil((p.mutedUntil - t) / 1000)}s.`);
  p.chatTimes = p.chatTimes.filter(x => t - x < CFG.chatWindowMs);
  if (p.chatTimes.length >= CFG.chatBurst) { p.mutedUntil = t + 4000; return sys(p, 'Slow down a little.'); }
  const { text, changed } = clean(raw.slice(0, 400));
  if (!text || !/[\p{L}\p{N}]/u.test(text.replace(/\[(link|address) removed\]/g, ''))) { if (changed) sys(p, 'Links and wallet addresses are not allowed in chat.'); return; }
  const msg = text.slice(0, CFG.chatMax);
  if (p.lastText === msg.toLowerCase() && t - p.lastAt < 15000) return sys(p, 'You already said that.');
  p.lastText = msg.toLowerCase(); p.lastAt = t; p.chatTimes.push(t);
  if (changed) stats.filtered++;
  stats.chat++;
  const line = { t: 'chat', id: p.id, name: p.name, token: p.token, text: msg, at: t };
  recent.push({ id: p.id, name: p.name, addr: p.addr, text: msg, at: t }); if (recent.length > 200) recent.shift();
  broadcast(line);
}
function onReport(p, m) {
  const t = now(), target = players.get(+m.id);
  if (!target || target === p) return;
  if (t - p.lastReport < 10000) return sys(p, 'Please wait a moment before sending another report.');
  p.lastReport = t; stats.reports++;
  target.reports = target.reports.filter(r => t - r.at < CFG.reportWindowMs);
  if (!target.reports.some(r => r.by === p.id)) target.reports.push({ by: p.id, at: t });
  const entry = { at: new Date(t).toISOString(), reporter: { id: p.id, name: p.name, addr: p.addr }, target: { id: target.id, name: target.name, addr: target.addr }, reason: String(m.reason || '').slice(0, 200), context: recent.filter(r => r.id === target.id).slice(-5) };
  fs.appendFile(path.join(DATA_DIR, 'reports.jsonl'), JSON.stringify(entry) + '\n', () => { });
  log('report', JSON.stringify(entry));                                      // also in the platform logs: the container disk is not persistent
  sys(p, 'Thanks. Your report was sent to the moderators.');
  if (target.reports.length >= CFG.reportMuteAt && target.mutedUntil < t + CFG.reportMuteMs) { target.mutedUntil = t + CFG.reportMuteMs; sys(target, 'Several players reported you. You are muted for 10 minutes.'); }
}

// ---------- movement: the client reports, the server clamps (island bounds, speed) and relays
function onMove(p, m) {
  const x = +m.x, z = +m.z, ry = +m.ry;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  const t = now(), dt = Math.min(1, Math.max(0.05, (t - p.moveAt) / 1000)); p.moveAt = t;
  let nx = Math.max(-CFG.limit, Math.min(CFG.limit, x)), nz = Math.max(-CFG.limit, Math.min(CFG.limit, z));
  const maxD = CFG.speed * CFG.tolerance * dt + 0.35, d = Math.hypot(nx - p.x, nz - p.z);
  if (d > maxD) {                                                  // too fast: move as far as allowed and pull the client back
    const k = maxD / d; nx = p.x + (nx - p.x) * k; nz = p.z + (nz - p.z) * k;
    if (++p.strikes >= 3) { stats.snaps++; send(p, { t: 'snap', x: r2(nx), z: r2(nz) }); p.strikes = 0; }
  } else p.strikes = Math.max(0, p.strikes - 1);
  p.x = nx; p.z = nz; p.ry = Number.isFinite(ry) ? ry : p.ry; p.mv = !!m.mv; p.dirty = true;
}

// ---------- connection
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify({ ok: true, online: players.size, ...stats })); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, maxPayload: 2048, perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  const ip = (req.headers['fly-client-ip'] || req.socket.remoteAddress || '?').toString().trim();      // fly-client-ip is set by Fly's proxy; x-forwarded-for is client-controlled, so it is not used
  const origin = req.headers.origin;
  if (CFG.origins.length && !CFG.origins.includes(origin)) return ws.close(4003, 'origin');
  if (players.size >= CFG.maxPlayers) return ws.close(4002, 'full');
  if ((ipCount.get(ip) || 0) >= CFG.maxPerIp) return ws.close(4002, 'too many connections');
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);

  const id = nextId++, nonce = crypto.randomBytes(12).toString('hex');
  const p = {
    id, ws, ip, nonce, addr: null, token: null, guest: 'Guest-' + String(1000 + (id * 7919) % 9000), name: '',
    x: 0.5 + (Math.random() - 0.5) * 0.8, z: 2.0 + (Math.random() - 0.5) * 0.8, ry: 0.6, mv: false, dirty: false, moveAt: now(), strikes: 0,
    chatTimes: [], lastText: '', lastAt: 0, mutedUntil: 0, reports: [], lastReport: 0, alive: true, authBusy: false,
  };
  p.name = p.guest; players.set(id, p); stats.connected++;
  send(p, { t: 'welcome', id, name: p.name, challenge: challengeText(nonce), players: [...players.values()].filter(q => q !== p).map(pub), you: pub(p), maxChat: CFG.chatMax });
  broadcast({ t: 'join', p: pub(p) }, p);
  log('join', p.name, `(${players.size} online)`);

  ws.on('pong', () => { p.alive = true; });
  ws.on('message', async data => {
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try {
      if (m.t === 'move') return onMove(p, m);
      if (m.t === 'chat') return onChat(p, m.text);
      if (m.t === 'report') return onReport(p, m);
      if (m.t === 'logout') { p.addr = null; return setLook(p, null); }
      if (m.t === 'auth') {
        if (p.authBusy) return; p.authBusy = true;
        try {
          let addr = null;
          if (typeof m.session === 'string' && sessions.has(m.session) && sessions.get(m.session).exp > now()) addr = sessions.get(m.session).addr;
          else if (typeof m.sig === 'string') addr = verifyMessage(challengeText(p.nonce), m.sig).toLowerCase();
          if (!addr) return send(p, { t: 'authfail', reason: 'bad proof' });
          p.addr = addr;
          let session = typeof m.session === 'string' && sessions.has(m.session) ? m.session : null;
          if (!session) { session = crypto.randomBytes(24).toString('hex'); sessions.set(session, { addr, exp: now() + CFG.sessionMs }); }
          send(p, { t: 'authed', addr, session });
        } catch (e) { send(p, { t: 'authfail', reason: 'bad proof' }); } finally { p.authBusy = false; }
        return;
      }
      if (m.t === 'appear') {
        const token = m.token == null ? null : Math.floor(+m.token);
        if (token === null) return setLook(p, null);
        if (!p.addr || !(token >= 1 && token <= 1969)) return send(p, { t: 'sys', text: 'Sign in with your wallet to play as your Chog.' });
        let owner; try { owner = await ownerOf(token); } catch (e) { return send(p, { t: 'sys', text: 'Could not check the chain just now. You stay a guest for the moment.' }); }
        if (owner !== p.addr) return send(p, { t: 'sys', text: `Chog #${token} is not in your wallet.` });
        return setLook(p, token);
      }
    } catch (e) { log('handler error', e.message); }
  });
  ws.on('close', () => {
    players.delete(id); if (p.token && byToken.get(p.token) === p) byToken.delete(p.token);
    const n = (ipCount.get(ip) || 1) - 1; if (n > 0) ipCount.set(ip, n); else ipCount.delete(ip);
    broadcast({ t: 'leave', id }); log('leave', p.name, `(${players.size} online)`);
  });
  ws.on('error', () => { });
});

// ---------- loops
setInterval(() => {                                    // 10 Hz: send only the players that moved since the last tick
  const moved = []; for (const p of players.values()) if (p.dirty) { moved.push([p.id, r2(p.x), r2(p.z), r2(p.ry), p.mv ? 1 : 0]); p.dirty = false; }
  if (moved.length) broadcast({ t: 'state', p: moved });
}, CFG.tickMs);
setInterval(() => {                                    // drop dead sockets, expire sessions
  for (const p of players.values()) { if (!p.alive) { p.ws.terminate(); continue; } p.alive = false; try { p.ws.ping(); } catch (e) { /* closing */ } }
  const t = now(); for (const [k, s] of sessions) if (s.exp < t) sessions.delete(k);
}, CFG.pingMs);

if (require.main === module) server.listen(CFG.port, () => log(`Chog Town server on :${CFG.port}  (rpc ${CFG.rpc})`));
module.exports = { server, wss, CFG, challengeText };
