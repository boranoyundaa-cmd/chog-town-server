'use strict';
// Chog Hotel realtime server: presence (who is where) and chat. It holds no money and no ownership;
// the only thing it takes from the chain is "does this wallet own this Chog" (eth_call ownerOf), and it never signs anything.
//
// Protocol (JSON text frames). Client -> server:
//   auth {addr, sig} | auth {session}   prove a wallet (sig signs `challenge`), or resume a recent proof
//   appear {token|null}                 look like Chog #token (must be owned by the authed wallet) or the default Chog
//   logout {}                           drop the wallet, become a guest again
//   move {x, z, ry, mv}                 position report, ~10 per second
//   chat {text}  report {id, reason}
//   enter {space:'city'|'solo', x, z, ry}   change space: the town, or a private unsaved spot (a walletless guest's temporary room)
//   enter {space:'hotel', floor}        the Chog Hotel: floor 0 is the lobby, 1.. the halls, -1.. the basement (B1..), 'E' the Exhibition floor;  enter {space:'venue', id, level?}: a hotel room (a room document; level 2 = upstairs, tiers 3 and 4)
//   hotelinfo {} -> hotel {floors, basement, venues, counts}   the directory (above-ground rooms: holders first, free rooms below);  counts {c:{venueId:n}} is pushed to players in the hotel when people come and go
//   hotelfloor {floor} -> facades {floor, items, rooms?}      the facade documents on one floor (sent when a player steps onto it); for a basement floor also its rooms
//   usernameprep {name} -> usernameprep {message, ts} / usernamesave {name, ts, sig} -> username {name}   claim a unique username with the wallet (guest lists use it)
//   checkinprep {} -> checkinprep {message, ts, has} / checkin {ts, sig} -> checkin {ok, already?, no, floor, mine} | roomfail    every wallet gets one free room (14 x 10 m, 80 pieces) at the first free unit; the signature is like a username claim; a few per IP per day
//   venueinfo {} -> venueinfo {tier, points, templates, mine, offer}      the wallet's license and room (checked on chain, cached)
//   upgrade {} -> upgrade {ok, moved, no, floor, from:{no,floor}, tier, mine} | upgrade {ok:false, code, reason}    the room size of the license's tier (grows in place when the next units are free, else gets a new door)
//   reactivate {} -> reactivate {ok, no, floor, from, mine}      a free room from the basement moves back up (first free unit, else a new top floor)
//   roomlock {locked} -> lock {ok, locked, mine}      lock or unlock your room or venue: while locked only you get in, people inside stay
//   invget {} -> inventory {items:[{p, c?, txt?, locked?}], max}      the pieces stored for the wallet (they no longer fit a room); locked = 'tier' | 'venue' | 'shop' when the piece cannot be placed yet
//   venueset {open?, rule?, guests?, bans?, name?, cat?, desc?} -> venuemine {mine}   open or close a venue, the entry rule and lists, the listing text (a free room only has a name)
//   venueprep {doc, level?} / venuesave {doc, ts, sig, level?}     the room (a signed document with the room's budget; level 2 is the upper room);  facadeprep / facadesave the same for the hall facade (venues only)
//   venuemove {} -> venuemine {mine, moved}          move to the room of a lower tier (downsize), or upgrade (the same as upgrade, answered with venuemine);  venuemake {name, cat, desc} -> venuemine: upgrade with a listing text
//   ex_list {} -> ex_list {week, entries, winner, you, trophies};  ex_prep {} / ex_submit {ts, sig} (enter the weekly room contest with a snapshot of your saved room);  ex_voteprep {id} / ex_vote {id, ts, sig};  -> ex_prep / ex_voteprep {message, ts}, ex_done, ex_fail {reason}  (exhibition.js)
//   enter {space:'hotel', floor:'E'}    the Exhibition floor;  enter {space:'exhibit', id}: one contest entry (a read-only snapshot, entered.exhibit)
//   shopget {} / shopnotice {tx?} -> shopstate {mode, address, owned, equip, events, camera, budget}   what the wallet owns in the shop (balanceOfBatch, cached); the notice is sent after a purchase and forces a fresh read
//   shopbuy {id, qty} (SHOP_MOCK=1 only)   record a mock purchase;   equip {slot, id|null}   wear or take off a cosmetic in an extra slot (others see it: `cos` in every player record)
//   eventstart {title, mega?}           announce a 24 h event at your open venue (uses up an Event pass)  ->  events {list} to everybody;  camopen {} / camclose {} -> camera {init, size, pieces} then camera {players} every second (security camera item)
//   tip {venueId, amount, tx}           tell the venue you tipped its owner (the server checks the Tip event of the transaction)  ->  tipped {name, amount, venue} to everybody inside
//   invite / invlink / roomprep / roomsave / enter {space:'room'}   the old Home messages: answered with a note (rooms are public unless locked; a Home is a Hotel room now)
// Server -> client: welcome, authed, authfail, appear (full player), join, leave, state, snap, chat, sys, entered, roomfail, roomdoc, enterwait {after}, hotel, counts, kicked {floor},
//   hotelinfo {floors, basement, rooms, busiest:{door,name,inside}|null, events:[{door,name,title,until}], winner:{name}|null}   to the town on connect, on entering the town and when it changes (at most every 10 s).
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { verifyMessage } = require('ethers');
const { clean } = require('./filter');
const roomsLib = require('./rooms');
const inventoryLib = require('./inventory');
const hotelLib = require('./hotel');
const licenseLib = require('./license');
const usersLib = require('./users');
const gamesLib = require('./games');
const exhibitionLib = require('./exhibition');
const shopLib = require('./shop');

const CFG = {
  port: +process.env.PORT || 8767,
  rpc: process.env.RPC_URL || 'https://rpc.monad.xyz',
  nft: (process.env.NFT_ADDR || '0xc96d31f8626c6d03fae5dcd3d61e3fb9f4a73763').toLowerCase(),
  origins: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),   // empty = any origin (dev)
  half: 32, limit: 32 - 0.45,                   // half size of the town slab and the walkable limit (HALF in prototype/js/world_city.js)
  spawn: [-6, -16],                              // where a new connection starts in the town (CITY.spawn in prototype/js/world_city.js; change both)
  speed: 3.4, tolerance: 1.6,                     // client walk speed and how much faster than that we still accept
  maxPlayers: +process.env.MAX_PLAYERS || 200, maxPerIp: +process.env.MAX_PER_IP || 6,
  tickMs: 100, pingMs: 20000, sessionMs: 12 * 3600e3,
  roomPrepMs: +process.env.ROOM_PREP_MS || 1000, roomSaveMs: +process.env.ROOM_SAVE_MS || 3000,        // min time between room signatures / saves per player
  venueMs: +process.env.VENUE_MS || 1000, infoMs: +process.env.HOTELINFO_MS || 10000,                      // min time between room requests (upgrade, move, card) per player; how often the town signs are refreshed
  chatMax: 140, chatBurst: 3, chatWindowMs: 6000, spamMuteMs: 30e3,
  reportMuteAt: 3, reportMuteMs: 10 * 60e3, reportWindowMs: 10 * 60e3,
};
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');          // on Fly this is a mounted volume (docs/engineering/server.md), otherwise rooms vanish on every deploy
fs.mkdirSync(DATA_DIR, { recursive: true });
const clock = { skew: 0 };                                                       // tests move time with clock.skew (venue freeze and expiry)
const shop = shopLib.open(DATA_DIR, { now: () => Date.now() + clock.skew, rpc: CFG.rpc });                  // the shop (shop.js): SHOP_ADDRESS / SHOP_MOCK from the environment
const users = usersLib.open(DATA_DIR);
const inventory = inventoryLib.open(DATA_DIR);                                   // pieces that no longer fit a room (inventory.js)
const hotel = hotelLib.open(DATA_DIR, { now: () => Date.now() + clock.skew, shop, nameOf: users.nameOf, inventory });          // also moves the old Homes into free rooms
const CHECKIN_IP_MAX = +process.env.CHECKIN_IP_MAX || 5;                          // check-ins per address and day
const TIER_NAME = ['', 'Ser', 'Fren', 'Whale', 'Legend'];
const [ROOM_W, ROOM_D] = roomsLib.LIMITS.size;
const ROOM_LIMIT = [ROOM_W / 2 - 0.2, ROOM_D / 2 - 0.2];                         // walking limit on the room floor (the client keeps 0.3 off the walls)
const HOTEL_LOBBY = [8.05, 5.8], HOTEL_FLOOR = [11.8, 11.8];                      // walking limits in the hotel lobby (16.5 x 12 m) and on a floor (a 24 x 24 m hall), 0.2 m inside the walls (HOTEL in prototype/js/hotel.js)
const venueSpace = (id, level) => 'venue:' + id + (level === 2 ? '#2' : ''), venueIdOf = space => space.slice(6).split('#')[0];      // a venue's upper level is a space of its own (presence and chat per level)
const limitsOf = space => {
  if (space.startsWith('city')) return [CFG.limit, CFG.limit];
  if (space === 'hotel:0') return HOTEL_LOBBY; if (space.startsWith('hotel:')) return HOTEL_FLOOR;
  if (space.startsWith('venue:')) { const v = hotel.get(venueIdOf(space)); if (v) { const [w, d] = hotel.sizeOf(v); return [w / 2 - 0.2, d / 2 - 0.2]; } }
  if (space.startsWith('exhibit:')) { const e = exhibition.view(space.slice(8)); if (e && e.sz) return [e.sz[0] / 2 - 0.2, e.sz[1] / 2 - 0.2]; }
  return ROOM_LIMIT;
};
const anyoneInside = id => { for (const q of players.values()) if (q.space.startsWith('venue:') && venueIdOf(q.space) === id) return true; return false; };
const venueCounts = () => { const c = {}; for (const q of players.values()) if (q.space.startsWith('venue:')) { const id = venueIdOf(q.space); c[id] = (c[id] || 0) + 1; } return c; };   // real players only, both levels together

// ---------- state
let nextId = 1;
const players = new Map();            // id -> player
const exhibition = exhibitionLib.open(DATA_DIR, { now: () => Date.now() + clock.skew, rooms: { get: addr => hotel.docs.get(addr) }, users });     // the weekly room contest (exhibition.js): entries are snapshots of the wallet's saved room
const games = gamesLib.open(DATA_DIR, { players });     // mini-games: score book and the two-player referee (games.js)
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
const pub = p => ({ id: p.id, name: p.name, token: p.token, x: r2(p.x), z: r2(p.z), ry: r2(p.ry), mv: p.mv ? 1 : 0, cos: p.cosm || undefined });      // cos: the cosmetics worn in the extra slots (shop.js)
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
const challengeText = nonce => `Chog Hotel sign-in\nThis proves you control this wallet. It costs nothing and sends no transaction.\nNonce: ${nonce}`;

// what everyone sees: the claimed username, else the Chog they play as, else the automatic guest name
const shownName = p => p.username || (p.token ? `Chog #${p.token}` : p.guest);
function setLook(p, token) {                       // token is already verified (or null for the default Chog)
  if (p.token && byToken.get(p.token) === p) byToken.delete(p.token);
  if (token) {
    const old = byToken.get(token);
    if (old && old !== p) { send(old, { t: 'sys', text: 'This Chog joined from another window.' }); old.ws.close(4001, 'replaced'); }
    byToken.set(token, p);
  }
  p.token = token || null;
  p.name = shownName(p);
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

// ---------- spaces: the town, a private spot, or a hotel room (presence, chat and movement never cross a space)
const roomFail = (p, reason) => send(p, { t: 'roomfail', reason });
const HOME_MOVED = 'Homes are Hotel rooms now. Ask the receptionist for yours.';
function onEnter(p, m) {
  const t = now(); if (t - p.lastEnter < 400) return send(p, { t: 'enterwait', after: 400 - (t - p.lastEnter) }); p.lastEnter = t;       // throttled: tell the client when to retry
  let target, owner = null, rec = null, venue = null, level = 1, exhibit = null;
  if (m.space === 'city') target = 'city';
  else if (m.space === 'solo') target = 'solo:' + p.id;
  else if (m.space === 'room') return roomFail(p, HOME_MOVED);
  else if (m.space === 'hotel') {
    const f = m.floor === 'E' ? 'E' : Math.floor(+m.floor); if (f !== 'E' && !(f >= -hotel.basement() && f <= hotel.floors())) return roomFail(p, 'There is no such floor.');      // 'E' = the Exhibition floor, negative = the basement
    target = 'hotel:' + f;
  } else if (m.space === 'exhibit') {                                            // a contest entry: the snapshot of a room, read only
    exhibit = exhibition.view(String(m.id)); if (!exhibit) return roomFail(p, 'That entry is not in the contest any more.');
    target = 'exhibit:' + exhibit.id; rec = { doc: exhibit.doc, savedAt: exhibit.at };
  } else if (m.space === 'venue') {
    venue = hotel.get(String(m.id)); if (!venue) return roomFail(p, 'That room does not exist.');
    level = +m.level === 2 ? 2 : 1; if (level === 2 && (venue.levels || 1) < 2) return roomFail(p, 'There is no upper level here.');
    const why = hotel.entry(venue, p, { level }); if (why) return roomFail(p, why);
    owner = venue.addr || null; target = venueSpace(venue.id, level); rec = { doc: level === 2 ? venue.doc2 : venue.doc, savedAt: null };
    hotel.visited(venue.id);
  } else return;
  const [lx, lz] = limitsOf(target), x = +m.x, z = +m.z, ry = +m.ry;
  bcast(p.space, { t: 'leave', id: p.id }, p);
  p.space = target; p.x = Number.isFinite(x) ? Math.max(-lx, Math.min(lx, x)) : 0; p.z = Number.isFinite(z) ? Math.max(-lz, Math.min(lz, z)) : 0; p.ry = Number.isFinite(ry) ? ry : 0; p.mv = false; p.moveAt = t; p.strikes = 0;
  const host = owner && [...players.values()].find(q => q.addr === owner && q.token);
  send(p, { t: 'entered', space: target.split(':')[0], x: r2(p.x), z: r2(p.z), ry: r2(p.ry), owner, mine: !!owner && owner === p.addr, ownerName: host ? host.name : null,
    doc: rec ? rec.doc : null, savedAt: rec ? rec.savedAt : null, floor: target.startsWith('hotel:') ? (target === 'hotel:E' ? 'E' : +target.slice(6)) : undefined, exhibit: exhibit ? { id: exhibit.id, name: exhibit.name, by: exhibit.by, theme: exhibit.theme, week: exhibit.week, current: exhibit.current, size: exhibit.sz } : undefined, level: venue ? level : undefined,
    venue: venue ? { id: venue.id, no: venue.no, tag: venue.floor < 0 ? 'B' + (-venue.floor) + String(venue.unit).padStart(2, '0') : undefined, floor: venue.floor, unit: venue.unit, units: venue.units || 1, levels: venue.levels || 1, free: hotel.isFree(venue), locked: !!venue.locked, name: hotel.nameFor(venue) || venue.name, cat: venue.cat, desc: venue.desc, by: venue.by, state: venue.state, tier: venue.tier || 0, music: venue.music || '', vip: venue.vipRule && venue.vipRule !== 'public' ? venue.vipRule : null, size: hotel.sizeOf(venue), limit: hotel.piecesOf(venue), lights: hotel.lightsOf(venue) } : undefined,
    counts: target.startsWith('hotel:') ? venueCounts() : undefined, players: [...players.values()].filter(q => q !== p && q.space === target).map(pub) });
  bcast(target, { t: 'join', p: pub(p) }, p);
  if (target === 'city') send(p, hotelInfo());
  log('enter', p.name, target);
}
const noMoreInvites = p => sys(p, 'Rooms are public unless the owner locks them, so there is nothing to invite anyone to.');
const SHOP_DOWN = 'Could not check the shop just now. Try again in a moment.';

// ---------- rooms: the license, check-in, upgrades, the signed room and facade, open and close, lock, inventory (docs/game/world.md)
const hotelList = () => hotel.list().map(v => { const e = shop.eventFor(v.id); return e ? { ...v, event: e.title, eventMega: !!e.mega, eventUntil: e.until } : v; });      // the directory carries the running event of a venue
const hotelPush = () => { const m = { t: 'hotel', floors: hotel.floors(), basement: hotel.basement(), venues: hotelList(), counts: venueCounts() }; for (const q of players.values()) if (q.space.startsWith('hotel:')) send(q, m); };
async function ownLicense(p, fresh) {
  if (!p.addr) throw new Error('Connect and sign in with your wallet first.');
  try { return await license.get(p.addr, fresh); } catch (e) { throw new Error('Could not check the chain just now. Try again in a moment.'); }
}
const tellOwner = (addr, m) => { for (const q of players.values()) if (q.addr === addr) send(q, m); };
const mineMsg = addr => ({ t: 'venuemine', mine: hotel.mine(addr), archived: false });
// the hotel numbers for the signs in the town: how tall it is, how many rooms, the busiest room right now, tonight's events and the Exhibition winner (the town's billboards read this)
function hotelInfo() {
  let busiest = null; for (const [id, n] of Object.entries(venueCounts())) { const v = hotel.get(id); if (v && (!busiest || n > busiest.inside || (n === busiest.inside && v.no < busiest.door))) busiest = { door: v.no, name: hotel.nameFor(v) || v.name, inside: n }; }
  const events = shop.activeEvents().map(e => { const v = hotel.get(e.id); return { door: v ? v.no : e.no, name: v ? hotel.nameFor(v) || v.name : e.name, title: e.title, until: e.until }; });
  let win = null; try { win = exhibition.list(null).winner; } catch (e) { /* no Exhibition data yet */ }
  return { t: 'hotelinfo', floors: hotel.floors(), basement: hotel.basement(), rooms: hotel.count(), busiest, events, winner: win ? { name: win.name, by: win.by } : null };
}
let lastInfo = '';
function hotelInfoPush(force) {                         // to the town, when something changed (the loop below asks every 10 seconds)
  const m = hotelInfo(), j = JSON.stringify(m); if (j === lastInfo && !force) return; lastInfo = j;
  for (const q of players.values()) if (q.space === 'city') send(q, m);
}
// the stored pieces of a wallet, with what keeps each from being placed right now
function invItems(addr) {
  const v = hotel.byOwner(addr), tier = v ? v.tier : 0;
  return inventory.get(addr).map(it => { const d = roomsLib.CAT.pieces[it.p]; const lock = (d.minTier || 0) > tier ? 'tier' : d.venue && !tier ? 'venue' : d.shop && !(shop.may(addr, d.shop, tier)) ? 'shop' : null; return lock ? { ...it, locked: lock } : it; });
}
const pushInventory = addr => { const m = { t: 'inventory', items: invItems(addr), max: inventoryLib.MAX }; tellOwner(addr, m); };

// holdings against the venue (docs/game/world.md): below its tier the venue is frozen (closed, decor kept); back within 7 days it reopens; after 7 days it shrinks to the room of the license (a free room when no Chog is left)
function afterReconcile(addr, what, floor) {
  const v = hotel.byOwner(addr); log('venue', what, addr);
  if (what === 'frozen' || what === 'expired') kickFrom(v ? v.id : 'h' + addr.slice(2, 10), addr, what === 'expired' ? 'The room changed size: its owner holds fewer Chogs than it needed.' : 'The venue was frozen: its owner holds fewer Chogs than it needs.', floor);
  hotelPush();
  tellOwner(addr, { ...mineMsg(addr), offer: null, expired: what === 'expired' || undefined }); if (what === 'expired') pushInventory(addr);
}
function kickFrom(id, exceptAddr, text, floor) {             // everybody inside goes back to the hall of the room's floor (the owner may stay)
  const v = hotel.get(id), fl = floor != null ? floor : v ? v.floor : 1;
  for (const q of players.values()) if (q.space.startsWith('venue:') && venueIdOf(q.space) === id && q.addr !== exceptAddr) { bcast(q.space, { t: 'leave', id: q.id }, q); q.space = 'hotel:' + fl; send(q, { t: 'sys', text }); send(q, { t: 'kicked', floor: fl }); }
}
async function reconcileOwner(addr, fresh) {          // never freezes on a chain error
  const v0 = hotel.byOwner(addr); if (!v0 || !v0.tier) return null;
  let L; try { L = await license.get(addr, fresh); } catch (e) { return null; }
  const floor = v0.floor, what = hotel.reconcile(addr, L.tier); if (what) afterReconcile(addr, what, floor); return what;
}
async function sweepVenues() {                        // every few hours: re-read every holder's Chogs (also shrinks the rooms whose 7 days passed)
  const done = []; for (const addr of hotel.owners()) { const what = await reconcileOwner(addr, true); if (what) done.push([addr, what]); } return done;
}
function sweepBasement() {                            // at the start and every day: a free room nobody entered for 30 days moves to the basement
  const moved = hotel.sweepBasement(v => anyoneInside(v.id));
  for (const r of moved) { log('basement', r.addr, '#' + r.from.no, '->', r.no); tellOwner(r.addr, mineMsg(r.addr)); }
  if (moved.length) hotelPush(); return moved;
}
async function onVenueInfo(p) {
  const t = now(); if (t - p.lastVenue < CFG.venueMs) return; p.lastVenue = t;
  await shop.owned(p.addr).catch(() => { });                                       // the venue card shows the extras budget
  const L = await ownLicense(p, false);
  const floor = (hotel.byOwner(p.addr) || {}).floor, what = hotel.reconcile(p.addr, L.tier); if (what) afterReconcile(p.addr, what, floor);
  send(p, { t: 'venueinfo', tier: L.tier, points: L.points, tokens: L.tokens.length, templates: hotelLib.TEMPLATES, music: hotelLib.MUSIC, mine: hotel.mine(p.addr), archived: false, offer: hotel.offerFor(p.addr, L.tier) });
}

// check-in: the first free room of a wallet. The wallet signs a short message (like a username claim); a few check-ins per address and day.
const checkins = new Map();                           // ip -> times of today's check-ins
const checkinsLeft = ip => { const t = now(), l = (checkins.get(ip) || []).filter(x => t - x < 24 * 3600e3); checkins.set(ip, l); return CHECKIN_IP_MAX - l.length; };
const checkinMessage = ts => `Chog Hotel check-in\nThe hotel sets you up with a free room.\nThis costs nothing and sends no transaction.\nTime: ${ts}`;
function onCheckinPrep(p) {
  if (!p.addr) return roomFail(p, 'Connect and sign in with your wallet to check in.');
  const t = now(); if (t - p.lastPrep < CFG.roomPrepMs) return roomFail(p, 'Slow down a little.'); p.lastPrep = t;
  send(p, { t: 'checkinprep', message: checkinMessage(t), ts: t, has: !!hotel.byOwner(p.addr) });
}
function onCheckin(p, m) {
  if (!p.addr) return roomFail(p, 'Connect and sign in with your wallet to check in.');
  const t = now(); if (t - p.lastCheckin < CFG.roomSaveMs) return roomFail(p, 'Slow down a little.'); p.lastCheckin = t;
  const have = hotel.byOwner(p.addr);
  if (have) return send(p, { t: 'checkin', ok: true, already: true, no: have.no, floor: have.floor, mine: hotel.mine(p.addr) });
  const ts = +m.ts; if (!Number.isFinite(ts) || Math.abs(t - ts) > 2 * 60e3) return roomFail(p, 'The signature is too old. Try again.');
  let who; try { who = verifyMessage(checkinMessage(ts), String(m.sig)).toLowerCase(); } catch (e) { return roomFail(p, 'That signature is not valid.'); }
  if (who !== p.addr) return roomFail(p, 'That signature is from another wallet.');
  if (checkinsLeft(p.ip) <= 0) return roomFail(p, 'Too many check-ins from this connection today. Try again tomorrow.');
  const v = hotel.create(p.addr, 0, { by: p.username || '' }); checkins.get(p.ip).push(t);
  log('check-in', p.addr, '#' + v.no);
  send(p, { t: 'checkin', ok: true, already: false, no: v.no, floor: v.floor, mine: hotel.mine(p.addr) }); hotelPush();
}
// upgrade: the room size of the license's tier. -> { ok:true, moved, ... } or { ok:false, code, reason }; the caller sends the answer
async function doUpgrade(p) {
  if (!p.addr) return { ok: false, code: 'no-wallet', reason: 'Connect and sign in with your wallet first.' };
  let L; try { L = await ownLicense(p, true); } catch (e) { return { ok: false, code: 'chain', reason: e.message }; }
  await shop.owned(p.addr).catch(() => { });                                       // a moved room keeps the shop pieces the owner has
  const v = hotel.byOwner(p.addr);
  if (!v) return { ok: false, code: 'no-room', tier: L.tier, reason: 'You have no room yet. Check in at the reception first.' };
  if (!L.tier) return { ok: false, code: 'tier-low', tier: 0, roomTier: v.tier, reason: 'You need a Chog to upgrade your room.' };
  if (L.tier === v.tier) return { ok: false, code: 'max', tier: L.tier, roomTier: v.tier, reason: v.tier >= 4 ? 'Your room is already the biggest there is.' : `Your room already is a ${TIER_NAME[v.tier]} room. Hold more Chogs to reach the next tier.` };
  if (L.tier < v.tier) return { ok: false, code: 'smaller', tier: L.tier, roomTier: v.tier, reason: 'Your room is bigger than your Chogs allow now. Move to a smaller room first.' };
  const oldId = v.id, floor = v.floor, r = hotel.upgrade(p.addr, L.tier);
  log('upgrade', p.addr, 'tier', L.tier, '#' + r.from.no, '->', '#' + r.venue.no, r.moved ? '(moved)' : '(in place)');
  kickFrom(oldId, null, 'The room changed size.', floor);                          // the room is a different size now: everybody inside, the owner too, goes back to the hall
  hotelPush(); pushInventory(p.addr);
  return { ok: true, moved: r.moved, no: r.venue.no, floor: r.venue.floor, unit: r.venue.unit, units: r.venue.units, from: { no: r.from.no, floor: r.from.floor }, tier: L.tier, mine: hotel.mine(p.addr) };
}
async function onUpgrade(p) {
  const t = now(); if (t - p.lastVenue < CFG.venueMs) return send(p, { t: 'upgrade', ok: false, code: 'busy', reason: 'Slow down a little.' }); p.lastVenue = t;
  send(p, { t: 'upgrade', ...await doUpgrade(p) });
}
function onReactivate(p) {
  const fail = (code, reason) => send(p, { t: 'reactivate', ok: false, code, reason });
  if (!p.addr) return fail('no-wallet', 'Connect and sign in with your wallet first.');
  const t = now(); if (t - p.lastVenue < CFG.venueMs) return fail('busy', 'Slow down a little.'); p.lastVenue = t;
  let r; try { r = hotel.reactivate(p.addr); } catch (e) { return fail(hotel.byOwner(p.addr) ? 'above' : 'no-room', e.message); }
  log('reactivate', p.addr, '#' + r.from.no, '->', '#' + r.venue.no);
  send(p, { t: 'reactivate', ok: true, moved: true, no: r.venue.no, floor: r.venue.floor, from: { no: r.from.no, floor: r.from.floor }, mine: hotel.mine(p.addr) }); hotelPush();
}
function onLock(p, m) {
  const fail = reason => send(p, { t: 'lock', ok: false, reason });
  if (!p.addr || !hotel.byOwner(p.addr)) return fail('You have no room yet. Check in at the reception first.');
  const t = now(); if (t - p.lastVenue < CFG.venueMs * 0.4) return fail('Slow down a little.'); p.lastVenue = t;
  const v = hotel.setLocked(p.addr, !!m.locked); log(v.locked ? 'lock' : 'unlock', p.addr, '#' + v.no);
  send(p, { t: 'lock', ok: true, locked: !!v.locked, mine: hotel.mine(p.addr) }); hotelPush();
}
async function onVenueMove(p) {                       // a lower tier: shrink to its room in place; a higher one: the same as upgrade
  const t = now(); if (t - p.lastVenue < CFG.venueMs) return roomFail(p, 'Slow down a little.'); p.lastVenue = t;
  const L = await ownLicense(p, true);
  await shop.owned(p.addr).catch(() => { });
  const before = hotel.byOwner(p.addr); if (!before) return roomFail(p, 'You have no room yet. Check in at the reception first.');
  const off = hotel.offerFor(p.addr, L.tier); if (!off) return roomFail(p, L.tier ? 'Your venue already fits your tier.' : 'You need a Chog to open a venue.');
  if (off.kind === 'upgrade') { const r = await doUpgrade(p); if (!r.ok) return roomFail(p, r.reason); return send(p, { ...mineMsg(p.addr), offer: null, moved: 'upgrade' }); }
  const oldId = before.id, floor = before.floor, r = hotel.downsize(p.addr, L.tier);
  log('venue downsize', p.addr, 'tier', L.tier, '#' + r.venue.no);
  kickFrom(oldId, null, 'The venue moved to a smaller room.', floor);
  send(p, { ...mineMsg(p.addr), offer: null, moved: 'downsize' }); hotelPush(); pushInventory(p.addr);
}
async function onVenueMake(p, m) {                    // the old "activate a venue": now an upgrade with a listing text
  const t = now(); if (t - p.lastVenue < CFG.venueMs) return roomFail(p, 'Slow down a little.'); p.lastVenue = t;
  const r = await doUpgrade(p); if (!r.ok) return roomFail(p, r.reason);
  hotel.update(p.addr, { name: m.name, cat: m.cat, desc: m.desc, by: p.username || p.name });
  send(p, mineMsg(p.addr)); hotelPush();
}
function onVenueSet(p, m) {
  if (!p.addr || !hotel.byOwner(p.addr)) return roomFail(p, 'You have no room yet. Check in at the reception first.');
  const t = now(); if (t - p.lastVenue < CFG.venueMs * 0.4) return roomFail(p, 'Slow down a little.'); p.lastVenue = t;
  const before = JSON.stringify(hotel.list().find(v => v.id === hotel.byOwner(p.addr).id));
  const oldMusic = hotel.byOwner(p.addr).music || '';
  hotel.update(p.addr, { open: m.open === undefined ? undefined : !!m.open, rule: m.rule, guests: m.guests, bans: m.bans, name: m.name, cat: m.cat, desc: m.desc, music: m.music, vipRule: m.vipRule, vipGuests: m.vipGuests });
  const v = hotel.byOwner(p.addr);
  send(p, { t: 'venuemine', mine: hotel.mine(p.addr) });
  if ((v.music || '') !== oldMusic) for (const lv of [1, 2]) bcast(venueSpace(v.id, lv), { t: 'venuemusic', id: v.id, music: v.music || '' });
  if (JSON.stringify(hotel.list().find(x => x.id === v.id)) !== before) hotelPush();
  if (v.state !== 'open') for (const q of players.values()) if (q.space.startsWith('venue:') && venueIdOf(q.space) === v.id && q.addr !== p.addr) { bcast(q.space, { t: 'leave', id: q.id }, q); q.space = 'hotel:' + v.floor; send(q, { t: 'sys', text: 'The venue was closed by its owner.' }); send(q, { t: 'kicked', floor: v.floor }); }
}
const levelOf = (v, m) => (+m.level === 2 && (v.levels || 1) > 1 ? 2 : 1);
const venueStore = (kind, v, m) => (kind === 'facade' ? hotel.facades : hotel.store(v, levelOf(v, m))), venueLim = (kind, v) => (kind === 'facade' ? hotel.facadeLimits(v) : hotel.limitsOf(v));
const FROZEN_MSG = 'Your venue is frozen until you hold enough Chogs again.';
const NO_FACADE = 'The hall wall is for Chog venues. Ask at the reception about an upgrade.';
async function onVenuePrep(p, m, kind) {
  const v = p.addr && hotel.byOwner(p.addr); if (!v) return roomFail(p, 'You have no room yet. Check in at the reception first.'); if (v.state === 'frozen') return roomFail(p, FROZEN_MSG);
  if (kind === 'facade' && !v.tier) return roomFail(p, NO_FACADE);
  const t = now(); if (t - p.lastPrep < CFG.roomPrepMs) return roomFail(p, 'Slow down a little.'); p.lastPrep = t;
  try { await shop.owned(p.addr); } catch (e) { return roomFail(p, SHOP_DOWN); }
  try { const r = venueStore(kind, v, m).prepare(m.doc, venueLim(kind, v)); send(p, { t: kind + 'prep', message: r.message, ts: r.ts, n: r.doc.pieces.length }); } catch (e) { roomFail(p, 'That could not be read.'); }
}
async function onVenueSave(p, m, kind) {
  const v = p.addr && hotel.byOwner(p.addr); if (!v) return roomFail(p, 'You have no room yet. Check in at the reception first.'); if (v.state === 'frozen') return roomFail(p, FROZEN_MSG);
  if (kind === 'facade' && !v.tier) return roomFail(p, NO_FACADE);
  const t = now(); if (t - p.lastSave < CFG.roomSaveMs) return roomFail(p, 'Slow down a little.'); p.lastSave = t;
  try { await shop.owned(p.addr); } catch (e) { return roomFail(p, SHOP_DOWN); }
  try {
    const store = venueStore(kind, v, m), prev = store.get(p.addr), rec = store.save(p.addr, m.doc, m.ts, m.sig, venueLim(kind, v)), level = levelOf(v, m);
    send(p, { t: kind + 'saved', at: rec.savedAt, hash: rec.hash, level, mine: hotel.mine(p.addr) });
    if (kind === 'venue') {
      bcast(venueSpace(v.id, level), { t: 'roomdoc', doc: rec.doc, savedAt: rec.savedAt }, p);
      if (inventory.consume(p.addr, prev && prev.doc ? prev.doc.pieces : [], rec.doc.pieces)) pushInventory(p.addr);        // a stored piece that was placed again leaves the inventory
      if (level === 1 && hotel.renamed(p.addr, rec.doc.name)) { hotelPush(); send(p, { t: 'venuemine', mine: hotel.mine(p.addr) }); }          // a free room is named after its saved document
    } else for (const q of players.values()) if (q.space === 'hotel:' + v.floor) send(q, { t: 'facades', floor: v.floor, items: hotel.facadesOn(v.floor) });
    log(kind + ' saved', p.addr, rec.doc.pieces.length + ' pieces');
  } catch (e) { roomFail(p, e.message); }
}

// ---------- shop: what a wallet owns (shop.js), worn cosmetics, events, the security camera, tips
const evPush = () => { const m = { t: 'events', list: shop.activeEvents() }; for (const q of players.values()) send(q, m); };
async function shopTier(p, owned) {                     // the license tier, read only when something owned is tier-locked
  if (!Object.keys(owned).some(id => (shop.byId.get(+id) || {}).minTier)) return 0;
  try { return (await ownLicense(p, false)).tier; } catch (e) { return 0; }
}
const NO_SHOP = { owned: {}, equip: {}, events: { event: 0, mega: 0 }, camera: false, budget: { pieces: 0, lights: 0 } };
async function shopSync(p, fresh) {                     // read the wallet's items, refresh what it wears, tell it (and its venue card)
  if (!p.addr) return;
  const owned = await shop.owned(p.addr, fresh), tier = await shopTier(p, owned); p.shopTier = tier;
  const cos = shop.worn(p.addr, tier), same = JSON.stringify(cos) === JSON.stringify(p.cosm || {});
  if (!same) { p.cosm = Object.keys(cos).length ? cos : null; bcast(p.space, { t: 'appear', p: pub(p) }); }
  send(p, { t: 'shopstate', ...shop.snapshot(p.addr, tier) });
  if (hotel.byOwner(p.addr)) send(p, { t: 'venuemine', mine: hotel.mine(p.addr) });
}
async function onShop(p, m) {
  if (m.t === 'shopget') {
    if (!p.addr) return send(p, { t: 'shopstate', ...shop.info(), ...NO_SHOP });
    const t0 = now(); if (t0 - p.lastShop < 800) return; p.lastShop = t0;
    try { return await shopSync(p, false); } catch (e) { return roomFail(p, SHOP_DOWN); }
  }
  if (!p.addr) return roomFail(p, 'Connect and sign in with your wallet first.');
  const t = now(); if (t - p.lastShop < 300) return roomFail(p, 'Slow down a little.'); p.lastShop = t;
  try {
    if (m.t === 'shopnotice') {                                              // the client saw a purchase confirm: read the balances again (a second time a moment later, in case the node lags)
      if (t - (p.lastNotice || 0) < 2000) return; p.lastNotice = t; shop.invalidate(p.addr); await shopSync(p, true);
      setTimeout(() => { if (players.get(p.id) === p) shopSync(p, true).catch(() => { }); }, 2500).unref(); return;
    }
    if (m.t === 'shopbuy') { shop.mockBuy(p.addr, m.id, m.qty); return await shopSync(p, true); }       // refused unless the server runs with SHOP_MOCK=1
    if (m.t === 'equip') {
      await shop.owned(p.addr); const it = shop.byId.get(+m.id), tier = it && it.minTier ? await shopTier(p, { [it.id]: 1 }) : 0;
      shop.equip(p.addr, String(m.slot), m.id == null ? null : +m.id, tier); return await shopSync(p, false);
    }
    if (m.t === 'eventstart') {
      const v = hotel.byOwner(p.addr); await shop.owned(p.addr);
      const e = shop.startEvent(p.addr, v && { ...v, name: hotel.nameFor(v) || v.name }, m.title, !!m.mega, v ? v.tier : 0);
      log('event', e.name, e.title); evPush(); hotelPush(); sys(p, `Event announced for 24 hours: ${e.title}`); return await shopSync(p, false);
    }
    if (m.t === 'camopen') {
      const v = hotel.byOwner(p.addr); if (!v) return roomFail(p, 'You have no venue yet.');
      await shop.owned(p.addr); if (!shop.cameraAllowed(p.addr, v.tier)) return roomFail(p, 'You need the security camera from the shop.');
      p.cam = v.id; return send(p, cameraInit(v));
    }
    if (m.t === 'camclose') { p.cam = null; return; }
    if (m.t === 'tip') return await onTip(p, m);
  } catch (e) { roomFail(p, e && e.message ? e.message : 'That did not work.'); }
}
function cameraInit(v) {                                  // the room as flat boxes (footprints from the catalog): the camera window draws these and the people on top, live
  const flat = doc => ((doc && doc.pieces) || []).map(it => { const d = roomsLib.CAT.pieces[it.p]; return d ? { p: it.p, x: it.x, z: it.z, ry: it.ry || 0, w: d.fp[0], d: d.fp[1], cat: d.cat } : null; }).filter(Boolean);
  const full = hotel.get(v.id);
  return { t: 'camera', init: 1, id: v.id, name: v.name, size: hotel.sizeOf(v), levels: v.levels || 1, pieces: flat(full && full.doc), pieces2: flat(full && full.doc2) };
}
function cameraFrame(v) {
  const list = []; for (const q of players.values()) if (q.space.startsWith('venue:') && venueIdOf(q.space) === v.id) list.push({ id: q.id, name: q.name, x: r2(q.x), z: r2(q.z), l: q.space.endsWith('#2') ? 2 : 1, mv: q.mv ? 1 : 0, owner: q.addr === v.addr ? 1 : 0 });
  return { t: 'camera', players: list, at: now() };
}
async function onTip(p, m) {
  const v = hotel.get(String(m.venueId)); if (!v || !v.addr) throw new Error('Only holder venues can be tipped.');
  if (v.addr === p.addr) throw new Error('You cannot tip yourself.');
  if (!p.space.startsWith('venue:') || venueIdOf(p.space) !== v.id) throw new Error('You tip from inside the venue.');
  const whole = Math.floor(+m.amount); if (!(whole >= 1 && whole <= 10000000)) throw new Error('That is not a valid tip.');
  const wei = await shop.verifyTip(m.tx, { from: p.addr, to: v.addr, venueId: v.no, amount: BigInt(whole) * 10n ** 18n });
  const amount = Number(BigInt(wei) / 10n ** 18n);
  const msg = { t: 'tipped', name: p.name, amount, venue: v.id }; for (const lv of [1, 2]) bcast(venueSpace(v.id, lv), msg);
  for (const q of players.values()) if (q.addr === v.addr && !q.space.startsWith('venue:' + v.id)) send(q, msg);
  log('tip', p.name, '->', v.name, amount);
}

// ---------- usernames
function onUsernamePrep(p, m) {
  if (!p.addr) return roomFail(p, 'Connect and sign in with your wallet to choose a username.');
  const t = now(); if (t - p.lastPrep < CFG.roomPrepMs) return roomFail(p, 'Slow down a little.'); p.lastPrep = t;
  try { const r = users.prepare(p.addr, String(m.name)); send(p, { t: 'usernameprep', name: String(m.name), message: r.message, ts: r.ts }); } catch (e) { roomFail(p, e.message); }
}
function onUsernameSave(p, m) {
  if (!p.addr) return roomFail(p, 'Connect and sign in with your wallet to choose a username.');
  const t = now(); if (t - p.lastSave < CFG.roomSaveMs) return roomFail(p, 'Slow down a little.'); p.lastSave = t;
  try {
    const name = users.claim(p.addr, String(m.name), m.ts, m.sig);
    p.username = name; p.name = shownName(p); bcast(p.space, { t: 'appear', p: pub(p) }); send(p, { t: 'username', name });
    log('username', p.addr, name);
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
    id, ws, ip, nonce, addr: null, token: null, space: 'city', lastEnter: 0, lastPrep: 0, lastSave: 0, lastCheckin: 0, lastVenue: 0, lastShop: 0, cosm: null, cam: null, username: null, guest: 'Guest-' + String(1000 + (id * 7919) % 9000), name: '',
    x: CFG.spawn[0] + (Math.random() - 0.5) * 0.8, z: CFG.spawn[1] + (Math.random() - 0.5) * 0.8, ry: 0.6, mv: false, dirty: false, moveAt: now(), strikes: 0,
    chatTimes: [], lastText: '', lastAt: 0, mutedUntil: 0, reports: [], lastReport: 0, alive: true, authBusy: false,
  };
  p.name = p.guest; players.set(id, p); stats.connected++;
  send(p, { t: 'welcome', id, name: p.name, challenge: challengeText(nonce), players: [...players.values()].filter(q => q !== p && q.space === 'city').map(pub), you: pub(p), maxChat: CFG.chatMax, rooms: 1, hotel: 1, shop: shop.info() });
  send(p, { t: 'events', list: shop.activeEvents() });
  send(p, hotelInfo());
  bcast('city', { t: 'join', p: pub(p) }, p);
  log('join', p.name, `(${players.size} online)`);

  ws.on('pong', () => { p.alive = true; });
  ws.on('message', async data => {
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (data.length > 2048 && !['roomprep', 'roomsave', 'venueprep', 'venuesave', 'facadeprep', 'facadesave'].includes(m.t)) return;
    try {
      if (m.t === 'move') return onMove(p, m);
      if (m.t.startsWith('g_') && games.onMessage(p, m)) return;
      if (m.t.startsWith('ex_') && exhibition.onMessage(p, m, send)) return;
      if (m.t === 'chat') return onChat(p, m.text);
      if (m.t === 'report') return onReport(p, m);
      if (m.t === 'enter') { if (m.space === 'venue') { const ve = hotel.get(String(m.id)); if (ve && ve.addr) await shop.owned(ve.addr).catch(() => { }); }          // the venue's budget extras and shop pieces come from its owner's items
        if (m.space === 'venue' && p.addr) { const v = hotel.byOwner(p.addr); if (v && v.id === String(m.id)) await reconcileOwner(p.addr, false); } return onEnter(p, m); }          // the owner walking in: their holdings are checked first
      if (m.t === 'hotelinfo') return send(p, { t: 'hotel', floors: hotel.floors(), basement: hotel.basement(), venues: hotelList(), counts: venueCounts() });
      if (m.t === 'hotelfloor') { const f = Math.floor(+m.floor); return send(p, { t: 'facades', floor: f, items: hotel.facadesOn(f), rooms: f < 0 ? hotel.onFloor(f) : undefined }); }
      if (m.t === 'checkinprep') return onCheckinPrep(p);
      if (m.t === 'checkin') return onCheckin(p, m);
      if (m.t === 'upgrade') return await onUpgrade(p);
      if (m.t === 'reactivate') return onReactivate(p);
      if (m.t === 'roomlock') return onLock(p, m);
      if (m.t === 'invget') { if (!p.addr) return roomFail(p, 'Connect and sign in with your wallet first.'); await shop.owned(p.addr).catch(() => { }); return send(p, { t: 'inventory', items: invItems(p.addr), max: inventoryLib.MAX }); }
      if (m.t === 'usernameprep') return onUsernamePrep(p, m);
      if (m.t === 'usernamesave') return onUsernameSave(p, m);
      if (m.t === 'venueinfo') return await onVenueInfo(p);
      if (m.t === 'venuemake') return await onVenueMake(p, m);
      if (m.t === 'venueset') return onVenueSet(p, m);
      if (m.t === 'venuemove') return await onVenueMove(p);
      if (m.t === 'venueprep') return await onVenuePrep(p, m, 'venue');
      if (m.t === 'venuesave') return await onVenueSave(p, m, 'venue');
      if (m.t === 'facadeprep') return await onVenuePrep(p, m, 'facade');
      if (m.t === 'facadesave') return await onVenueSave(p, m, 'facade');
      if (m.t === 'shopget' || m.t === 'shopnotice' || m.t === 'shopbuy' || m.t === 'equip' || m.t === 'eventstart' || m.t === 'camopen' || m.t === 'camclose' || m.t === 'tip') return await onShop(p, m);
      if (m.t === 'invite' || m.t === 'invlink') return noMoreInvites(p);
      if (m.t === 'roomprep' || m.t === 'roomsave') return roomFail(p, HOME_MOVED);
      if (m.t === 'logout') { p.addr = null; p.username = null; p.cosm = null; p.cam = null; return setLook(p, null); }
      if (m.t === 'auth') {
        if (p.authBusy) return; p.authBusy = true;
        try {
          let addr = null;
          if (typeof m.session === 'string' && sessions.has(m.session) && sessions.get(m.session).exp > now()) addr = sessions.get(m.session).addr;
          else if (typeof m.sig === 'string') addr = verifyMessage(challengeText(p.nonce), m.sig).toLowerCase();
          if (!addr) return send(p, { t: 'authfail', reason: 'bad proof' });
          p.addr = addr; p.username = users.nameOf(addr); if (p.username) { p.name = shownName(p); bcast(p.space, { t: 'appear', p: pub(p) }); }
          let session = typeof m.session === 'string' && sessions.has(m.session) ? m.session : null;
          if (!session) { session = crypto.randomBytes(24).toString('hex'); sessions.set(session, { addr, exp: now() + CFG.sessionMs }); }
          send(p, { t: 'authed', addr, session, username: p.username });
          if (hotel.byOwner(addr)) send(p, mineMsg(addr));                            // signing in: the client learns about the room at once (a basement room says so)
          reconcileOwner(addr, false).catch(() => { });                              // signing in: the holdings are checked against the venue
          shopSync(p, false).catch(() => { send(p, { t: 'shopstate', ...shop.info(), ...NO_SHOP, down: true }); });          // signing in: what the wallet owns in the shop, and what it wears
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
    } catch (e) { log('handler error', e.message); if (/^(You |Your |Connect |Decorate |Could not check|That track)/.test(e.message)) roomFail(p, e.message); }
  });
  ws.on('close', () => {
    games.leave(p);     players.delete(id); if (p.token && byToken.get(p.token) === p) byToken.delete(p.token);
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
setInterval(() => { if (shop.sweepEvents()) { evPush(); hotelPush(); } }, 20000).unref();     // an event that ended leaves the banner and the directory
setInterval(() => { for (const p of players.values()) if (p.cam) { const v = hotel.byOwner(p.addr); if (!v || v.id !== p.cam) { p.cam = null; continue; } send(p, cameraFrame(v)); } }, 1000).unref();      // security camera: who is where in the venue, once a second
setInterval(() => hotelInfoPush(false), CFG.infoMs).unref();                       // the town signs: pushed when the numbers changed, at most every 10 s
sweepBasement(); setInterval(sweepBasement, 24 * 3600e3).unref();              // free rooms nobody entered for 30 days go to the basement: at the start and every day
const SWEEP_MS = +process.env.VENUE_SWEEP_MS || 6 * 3600e3;
setInterval(() => { sweepVenues().catch(e => log('venue sweep failed', e.message)); }, SWEEP_MS).unref();     // every 6 hours
setInterval(() => {                                    // drop dead sockets, expire sessions
  for (const p of players.values()) { if (!p.alive) { p.ws.terminate(); continue; } p.alive = false; try { p.ws.ping(); } catch (e) { /* closing */ } }
  const t = now(); for (const [k, s] of sessions) if (s.exp < t) sessions.delete(k);
}, CFG.pingMs);

if (require.main === module) server.listen(CFG.port, () => log(`Chog Hotel server on :${CFG.port}  (rpc ${CFG.rpc})`));
module.exports = { server, wss, CFG, challengeText, clock, hotel, sweepVenues, sweepBasement, hotelInfo, shop, inventory, exhibition, checkins };
