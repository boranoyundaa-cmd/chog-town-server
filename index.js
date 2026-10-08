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
//   enter {space:'city'|'solo'|'room', who:'me'|addr, inv?, x, z, ry}   change space: the town, a private spot, or a saved Home (the owner's, or one you were invited to by a direct invitation or the link token `inv`)
//   enter {space:'hotel', floor}        the Chog Hotel: floor 0 is the lobby;  enter {space:'venue', id}: a hotel venue (a room document)
//   hotelinfo {} -> hotel {floors, venues, counts}   the directory;  counts {c:{venueId:n}} is pushed to players in the hotel when people come and go
//   hotelfloor {floor} -> facades {floor, items}      the facade documents on one floor (sent when a player steps onto it)
//   venueinfo {} -> venueinfo {tier, points, templates, mine}      the wallet's license and venue (checked on chain, cached)
//   venuemake {name, cat, desc} -> venuemine {mine}                activate a venue from the license: it starts CLOSED
//   venueprep {doc} / venuesave {doc, ts, sig}     the venue room (a signed document, like a Home, with the tier's budget);  facadeprep / facadesave the same for the corridor facade
//   venueset {open?, rule?, guests?, bans?, name?, cat?, desc?} -> venuemine {mine}   open or close it, the entry rule and lists, the listing text
//   invite {id}                         invite a player to your saved Home (30 minutes)  ->  they get invited {owner, from}
//   invlink {renew?} -> invlink {token, exp}     your Home's share link token (renew = revoke the old link)
//   roomprep {doc} -> roomprep {message, ts}     the cleaned room and the text the wallet must sign
//   roomsave {doc, ts, sig}                      store the room if the wallet signed exactly that text
// Server -> client: welcome, authed, authfail, appear (full player), join, leave, state, snap, chat, sys, entered, roomprep, roomsaved, roomfail, roomdoc, invited, invlink, hotel, counts.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { verifyMessage } = require('ethers');
const { clean } = require('./filter');
const roomsLib = require('./rooms');
const invitesLib = require('./invites');
const hotelLib = require('./hotel');
const licenseLib = require('./license');

const CFG = {
  port: +process.env.PORT || 8767,
  rpc: process.env.RPC_URL || 'https://rpc.monad.xyz',
  nft: (process.env.NFT_ADDR || '0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763').toLowerCase(),
  origins: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),   // empty = any origin (dev)
  half: 10.4, limit: 10.4 - 0.45,                 // half size of the town slab and the walkable limit (HALF in prototype/js/world_city.js)
  speed: 2.7, tolerance: 1.6,                     // client walk speed and how much faster than that we still accept
  maxPlayers: +process.env.MAX_PLAYERS || 200, maxPerIp: +process.env.MAX_PER_IP || 6,
  tickMs: 100, pingMs: 20000, sessionMs: 12 * 3600e3,
  roomPrepMs: +process.env.ROOM_PREP_MS || 1000, roomSaveMs: +process.env.ROOM_SAVE_MS || 3000,        // min time between room signatures / saves per player
  chatMax: 140, chatBurst: 3, chatWindowMs: 6000, spamMuteMs: 30e3,
  reportMuteAt: 3, reportMuteMs: 10 * 60e3, reportWindowMs: 10 * 60e3,
};
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');          // on Fly this is a mounted volume (docs/engineering/server.md), otherwise rooms vanish on every deploy
fs.mkdirSync(DATA_DIR, { recursive: true });
const rooms = roomsLib.open(DATA_DIR);
const invites = invitesLib.open(DATA_DIR);
const hotel = hotelLib.open(DATA_DIR);
const [ROOM_W, ROOM_D] = roomsLib.LIMITS.size;
const ROOM_LIMIT = [ROOM_W / 2 - 0.2, ROOM_D / 2 - 0.2];                         // walking limit on the room floor (the client keeps 0.3 off the walls)
const HOTEL_LOBBY = [5.3, 3.8], HOTEL_FLOOR = [7.4, 7.4];                         // walking limits in the hotel lobby and on a floor (HOTEL in prototype/js/hotel.js)
const limitsOf = space => {
  if (space.startsWith('city')) return [CFG.limit, CFG.limit];
  if (space === 'hotel:0') return HOTEL_LOBBY; if (space.startsWith('hotel:')) return HOTEL_FLOOR;
  if (space.startsWith('venue:')) { const v = hotel.get(space.slice(6)); if (v) { const [w, d] = hotel.sizeOf(v); return [w / 2 - 0.2, d / 2 - 0.2]; } }
  return ROOM_LIMIT;
};
const venueCounts = () => { const c = {}; for (const q of players.values()) if (q.space.startsWith('venue:')) c[q.space.slice(6)] = (c[q.space.slice(6)] || 0) + 1; return c; };   // real players only

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
const bcast = (space, m, except) => { const s = JSON.stringify(m); for (const p of players.values()) if (p !== except && p.space === space && p.ws.readyState === 1) p.ws.send(s); };   // chat, movement and joins stay inside one space
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
async function rpcCall(body) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  try { const r = await fetch(CFG.rpc, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return await r.json(); } finally { clearTimeout(timer); }
}
const addrOf = hex => '0x' + hex.slice(-40).toLowerCase();
const chain = {                                    // what the license needs from the chain
  async balanceOf(addr) { const j = await rpcCall({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: CFG.nft, data: '0x70a08231' + addr.slice(2).padStart(64, '0') }, 'latest'] }); if (!j.result) throw new Error('no result'); return parseInt(j.result, 16); },
  async ownersOf(ids) {                            // one batched request per 100 tokens; a token the chain cannot answer counts as nobody's
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100), j = await rpcCall(part.map((id, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: CFG.nft, data: '0x6352211e' + id.toString(16).padStart(64, '0') }, 'latest'] })));
      const rows = Array.isArray(j) ? j : [j]; const by = new Map(rows.map(r => [r.id, r])); part.forEach((_, k) => { const r = by.get(k); out.push(r && r.result ? addrOf(r.result) : null); });
    }
    return out;
  },
};
const license = licenseLib.open(chain);
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
  bcast(p.space, { t: 'appear', p: pub(p) });
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
  bcast(p.space, line);
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
  const [lx, lz] = limitsOf(p.space);
  let nx = Math.max(-lx, Math.min(lx, x)), nz = Math.max(-lz, Math.min(lz, z));
  const maxD = CFG.speed * CFG.tolerance * dt + 0.35, d = Math.hypot(nx - p.x, nz - p.z);
  if (d > maxD) {                                                  // too fast: move as far as allowed and pull the client back
    const k = maxD / d; nx = p.x + (nx - p.x) * k; nz = p.z + (nz - p.z) * k;
    if (++p.strikes >= 3) { stats.snaps++; send(p, { t: 'snap', x: r2(nx), z: r2(nz) }); p.strikes = 0; }
  } else p.strikes = Math.max(0, p.strikes - 1);
  p.x = nx; p.z = nz; p.ry = Number.isFinite(ry) ? ry : p.ry; p.mv = !!m.mv; p.dirty = true;
}

// ---------- spaces: the town, a private spot, or a saved room (presence, chat and movement never cross a space)
const roomFail = (p, reason) => send(p, { t: 'roomfail', reason });
const invited = (p, owner, token) => (p.invitedTo.get(owner) || 0) > now() || invites.check(token, owner, now());
function onEnter(p, m) {
  const t = now(); if (t - p.lastEnter < 400) return; p.lastEnter = t;
  let target, owner = null, rec = null, venue = null;
  if (m.space === 'city') target = 'city';
  else if (m.space === 'solo') target = 'solo:' + p.id;
  else if (m.space === 'room') {
    if (m.who === 'me') { if (!p.addr) return roomFail(p, 'Sign in with your wallet to open your saved Home.'); owner = p.addr; }
    else if (typeof m.who === 'string' && /^0x[0-9a-fA-F]{40}$/.test(m.who)) {
      owner = m.who.toLowerCase();
      if (owner !== p.addr && !invited(p, owner, m.inv)) return roomFail(p, 'That Home is private. Ask its owner to invite you.');       // a Home opens only for its owner and invited players
    } else return;
    rec = rooms.get(owner);
    if (!rec && owner !== p.addr) return roomFail(p, 'That Home is not ready yet.');
    target = 'room:' + owner;
  } else if (m.space === 'hotel') {
    const f = Math.floor(+m.floor); if (!(f >= 0 && f <= hotel.floors())) return roomFail(p, 'There is no such floor.');
    target = 'hotel:' + f;
  } else if (m.space === 'venue') {
    venue = hotel.get(String(m.id)); if (!venue) return roomFail(p, 'That room does not exist.');
    const why = hotel.entry(venue, p); if (why) return roomFail(p, why);
    owner = venue.addr || null; target = 'venue:' + venue.id; rec = { doc: venue.doc, savedAt: null };
  } else return;
  const [lx, lz] = limitsOf(target), x = +m.x, z = +m.z, ry = +m.ry;
  bcast(p.space, { t: 'leave', id: p.id }, p);
  p.space = target; p.x = Number.isFinite(x) ? Math.max(-lx, Math.min(lx, x)) : 0; p.z = Number.isFinite(z) ? Math.max(-lz, Math.min(lz, z)) : 0; p.ry = Number.isFinite(ry) ? ry : 0; p.mv = false; p.moveAt = t; p.strikes = 0;
  const host = owner && [...players.values()].find(q => q.addr === owner && q.token);
  send(p, { t: 'entered', space: target.split(':')[0], x: r2(p.x), z: r2(p.z), ry: r2(p.ry), owner, mine: !!owner && owner === p.addr, ownerName: host ? host.name : null,
    doc: rec ? rec.doc : null, savedAt: rec ? rec.savedAt : null, floor: target.startsWith('hotel:') ? +target.slice(6) : undefined, venue: venue ? { id: venue.id, no: venue.no, floor: venue.floor, span: venue.span || 1, name: venue.name, cat: venue.cat, desc: venue.desc, by: venue.by, state: venue.state, size: hotel.sizeOf(venue), limit: venue.addr ? hotelLib.TEMPLATES[venue.tier].pieces : 60 } : undefined, counts: target.startsWith('hotel:') ? venueCounts() : undefined, players: [...players.values()].filter(q => q !== p && q.space === target).map(pub) });
  bcast(target, { t: 'join', p: pub(p) }, p);
  log('enter', p.name, target);
}
function onInvite(p, m) {
  if (!p.addr || !rooms.get(p.addr)) return sys(p, 'Connect your wallet and save your Home first, then you can invite people.');
  const t = now(); if (t - p.lastInvite < 2000) return sys(p, 'Slow down a little.'); p.lastInvite = t;
  const q = players.get(+m.id); if (!q || q === p) return;
  for (const [k, e] of q.invitedTo) if (e <= t) q.invitedTo.delete(k);
  if (q.invitedTo.size >= 20 && !q.invitedTo.has(p.addr)) return sys(p, 'That player has too many invitations right now.');
  q.invitedTo.set(p.addr, t + invitesLib.DIRECT_MS);
  send(q, { t: 'invited', owner: p.addr, from: p.name, token: p.token, exp: t + invitesLib.DIRECT_MS });
  sys(p, `Invitation sent to ${q.name}.`);
}
function onInvLink(p, m) {
  if (!p.addr || !rooms.get(p.addr)) return roomFail(p, 'Save your Home first, then you can share a link.');
  const l = invites.link(p.addr, !!m.renew); send(p, { t: 'invlink', token: l.token, exp: l.exp });
}
function onRoomPrep(p, m) {
  if (!p.addr) return roomFail(p, 'Connect and sign in with your wallet to save your room.');
  const t = now(); if (t - p.lastPrep < CFG.roomPrepMs) return roomFail(p, 'Slow down a little.'); p.lastPrep = t;
  try { const r = rooms.prepare(m.doc); send(p, { t: 'roomprep', message: r.message, ts: r.ts, n: r.doc.pieces.length }); } catch (e) { roomFail(p, 'That room could not be read.'); }
}
function onRoomSave(p, m) {
  if (!p.addr) return roomFail(p, 'Connect and sign in with your wallet to save your room.');
  const t = now(); if (t - p.lastSave < CFG.roomSaveMs) return roomFail(p, 'Slow down a little.'); p.lastSave = t;
  try {
    const rec = rooms.save(p.addr, m.doc, m.ts, m.sig);
    send(p, { t: 'roomsaved', at: rec.savedAt, hash: rec.hash });
    bcast('room:' + p.addr, { t: 'roomdoc', doc: rec.doc, savedAt: rec.savedAt }, p);       // visitors standing in the room see the new look
    log('room saved', p.addr, rec.doc.pieces.length + ' pieces');
  } catch (e) { roomFail(p, e.message); }
}

// ---------- venues: the license, activation, the signed room and facade, open and close (docs/game/world.md)
const hotelPush = () => { const m = { t: 'hotel', floors: hotel.floors(), venues: hotel.list(), counts: venueCounts() }; for (const q of players.values()) if (q.space.startsWith('hotel:')) send(q, m); };
async function ownLicense(p, fresh) {
  if (!p.addr) throw new Error('Connect and sign in with your wallet first.');
  try { return await license.get(p.addr, fresh); } catch (e) { throw new Error('Could not check the chain just now. Try again in a moment.'); }
}
async function onVenueInfo(p) {
  const t = now(); if (t - p.lastVenue < 1000) return; p.lastVenue = t;
  const L = await ownLicense(p, false);
  send(p, { t: 'venueinfo', tier: L.tier, points: L.points, tokens: L.tokens.length, templates: hotelLib.TEMPLATES, mine: hotel.mine(p.addr) });
}
async function onVenueMake(p, m) {
  const t = now(); if (t - p.lastVenue < 1000) return; p.lastVenue = t;
  const L = await ownLicense(p, true);
  if (!L.tier) return roomFail(p, 'You need a Chog to open a venue.');
  const v = hotel.activate(p.addr, L.tier, { name: m.name, cat: m.cat, desc: m.desc, by: p.username || p.name });
  log('venue activated', p.addr, 'tier', L.tier, '#' + v.no);
  send(p, { t: 'venuemine', mine: hotel.mine(p.addr) }); hotelPush();
}
function onVenueSet(p, m) {
  if (!p.addr || !hotel.byOwner(p.addr)) return roomFail(p, 'You have no venue yet.');
  const t = now(); if (t - p.lastVenue < 400) return; p.lastVenue = t;
  const before = JSON.stringify(hotel.list().find(v => v.id === hotel.byOwner(p.addr).id));
  hotel.update(p.addr, { open: m.open === undefined ? undefined : !!m.open, rule: m.rule, guests: m.guests, bans: m.bans, name: m.name, cat: m.cat, desc: m.desc });
  const v = hotel.byOwner(p.addr);
  send(p, { t: 'venuemine', mine: hotel.mine(p.addr) });
  if (JSON.stringify(hotel.list().find(x => x.id === v.id)) !== before) hotelPush();
  if (v.state !== 'open') for (const q of players.values()) if (q.space === 'venue:' + v.id && q.addr !== p.addr) { q.space = 'hotel:' + v.floor; send(q, { t: 'sys', text: 'The venue was closed by its owner.' }); }
}
const venueStore = kind => (kind === 'facade' ? hotel.facades : hotel.docs), venueLim = (kind, v) => (kind === 'facade' ? hotel.facadeLimits(v) : hotel.limitsOf(v));
function onVenuePrep(p, m, kind) {
  const v = p.addr && hotel.byOwner(p.addr); if (!v) return roomFail(p, 'You have no venue yet.');
  const t = now(); if (t - p.lastPrep < CFG.roomPrepMs) return roomFail(p, 'Slow down a little.'); p.lastPrep = t;
  try { const r = venueStore(kind).prepare(m.doc, venueLim(kind, v)); send(p, { t: kind + 'prep', message: r.message, ts: r.ts, n: r.doc.pieces.length }); } catch (e) { roomFail(p, 'That could not be read.'); }
}
function onVenueSave(p, m, kind) {
  const v = p.addr && hotel.byOwner(p.addr); if (!v) return roomFail(p, 'You have no venue yet.');
  const t = now(); if (t - p.lastSave < CFG.roomSaveMs) return roomFail(p, 'Slow down a little.'); p.lastSave = t;
  try {
    const rec = venueStore(kind).save(p.addr, m.doc, m.ts, m.sig, venueLim(kind, v));
    send(p, { t: kind + 'saved', at: rec.savedAt, hash: rec.hash, mine: hotel.mine(p.addr) });
    if (kind === 'venue') bcast('venue:' + v.id, { t: 'roomdoc', doc: rec.doc, savedAt: rec.savedAt }, p);
    else for (const q of players.values()) if (q.space === 'hotel:' + v.floor) send(q, { t: 'facades', floor: v.floor, items: hotel.facadesOn(v.floor) });
    log(kind + ' saved', p.addr, rec.doc.pieces.length + ' pieces');
  } catch (e) { roomFail(p, e.message); }
}

// ---------- connection
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify({ ok: true, online: players.size, ...stats })); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, maxPayload: 16384, perMessageDeflate: false });   // 2 KB for everything except a room document (checked per message)

wss.on('connection', (ws, req) => {
  const ip = (req.headers['fly-client-ip'] || req.socket.remoteAddress || '?').toString().trim();      // fly-client-ip is set by Fly's proxy; x-forwarded-for is client-controlled, so it is not used
  const origin = req.headers.origin;
  if (CFG.origins.length && !CFG.origins.includes(origin)) return ws.close(4003, 'origin');
  if (players.size >= CFG.maxPlayers) return ws.close(4002, 'full');
  if ((ipCount.get(ip) || 0) >= CFG.maxPerIp) return ws.close(4002, 'too many connections');
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);

  const id = nextId++, nonce = crypto.randomBytes(12).toString('hex');
  const p = {
    id, ws, ip, nonce, addr: null, token: null, space: 'city', lastEnter: 0, lastPrep: 0, lastSave: 0, lastInvite: 0, lastVenue: 0, username: null, invitedTo: new Map(), guest: 'Guest-' + String(1000 + (id * 7919) % 9000), name: '',
    x: 0.5 + (Math.random() - 0.5) * 0.8, z: 2.0 + (Math.random() - 0.5) * 0.8, ry: 0.6, mv: false, dirty: false, moveAt: now(), strikes: 0,
    chatTimes: [], lastText: '', lastAt: 0, mutedUntil: 0, reports: [], lastReport: 0, alive: true, authBusy: false,
  };
  p.name = p.guest; players.set(id, p); stats.connected++;
  send(p, { t: 'welcome', id, name: p.name, challenge: challengeText(nonce), players: [...players.values()].filter(q => q !== p && q.space === 'city').map(pub), you: pub(p), maxChat: CFG.chatMax, rooms: 1, hotel: 1 });
  bcast('city', { t: 'join', p: pub(p) }, p);
  log('join', p.name, `(${players.size} online)`);

  ws.on('pong', () => { p.alive = true; });
  ws.on('message', async data => {
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (data.length > 2048 && !['roomprep', 'roomsave', 'venueprep', 'venuesave', 'facadeprep', 'facadesave'].includes(m.t)) return;
    try {
      if (m.t === 'move') return onMove(p, m);
      if (m.t === 'chat') return onChat(p, m.text);
      if (m.t === 'report') return onReport(p, m);
      if (m.t === 'enter') return onEnter(p, m);
      if (m.t === 'hotelinfo') return send(p, { t: 'hotel', floors: hotel.floors(), venues: hotel.list(), counts: venueCounts() });
      if (m.t === 'hotelfloor') { const f = Math.floor(+m.floor); return send(p, { t: 'facades', floor: f, items: hotel.facadesOn(f) }); }
      if (m.t === 'venueinfo') return await onVenueInfo(p);
      if (m.t === 'venuemake') return await onVenueMake(p, m);
      if (m.t === 'venueset') return onVenueSet(p, m);
      if (m.t === 'venueprep') return onVenuePrep(p, m, 'venue');
      if (m.t === 'venuesave') return onVenueSave(p, m, 'venue');
      if (m.t === 'facadeprep') return onVenuePrep(p, m, 'facade');
      if (m.t === 'facadesave') return onVenueSave(p, m, 'facade');
      if (m.t === 'invite') return onInvite(p, m);
      if (m.t === 'invlink') return onInvLink(p, m);
      if (m.t === 'roomprep') return onRoomPrep(p, m);
      if (m.t === 'roomsave') return onRoomSave(p, m);
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
    } catch (e) { log('handler error', e.message); if (/^(You |Connect |Decorate |Could not check)/.test(e.message)) roomFail(p, e.message); }
  });
  ws.on('close', () => {
    players.delete(id); if (p.token && byToken.get(p.token) === p) byToken.delete(p.token);
    const n = (ipCount.get(ip) || 1) - 1; if (n > 0) ipCount.set(ip, n); else ipCount.delete(ip);
    bcast(p.space, { t: 'leave', id }); log('leave', p.name, `(${players.size} online)`);
  });
  ws.on('error', () => { });
});

// ---------- loops
setInterval(() => {                                    // 10 Hz: send only the players that moved since the last tick
  const moved = new Map(); for (const p of players.values()) if (p.dirty) { if (!moved.has(p.space)) moved.set(p.space, []); moved.get(p.space).push([p.id, r2(p.x), r2(p.z), r2(p.ry), p.mv ? 1 : 0]); p.dirty = false; }
  for (const [space, list] of moved) bcast(space, { t: 'state', p: list });
}, CFG.tickMs);
let lastCounts = '{}';
setInterval(() => {                                    // who is inside which hotel venue: pushed to the players in the hotel only when it changed
  const c = venueCounts(), j = JSON.stringify(c); if (j === lastCounts) return; lastCounts = j;
  for (const p of players.values()) if (p.space.startsWith('hotel:')) send(p, { t: 'counts', c });
}, 2000);
setInterval(() => {                                    // drop dead sockets, expire sessions
  for (const p of players.values()) { if (!p.alive) { p.ws.terminate(); continue; } p.alive = false; try { p.ws.ping(); } catch (e) { /* closing */ } }
  const t = now(); for (const [k, s] of sessions) if (s.exp < t) sessions.delete(k);
}, CFG.pingMs);

if (require.main === module) server.listen(CFG.port, () => log(`Chog Town server on :${CFG.port}  (rpc ${CFG.rpc})`));
module.exports = { server, wss, CFG, challengeText };
