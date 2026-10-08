'use strict';
// Rooms: every wallet owns one room, saved as a small JSON document signed by that wallet (docs/game/spaces.md).
// The same machinery stores a holder's venue room and its corridor facade: a store is opened per kind ('room', 'venue', 'facade') and per call the
// caller may pass the budget (piece limit, floor size) that the owner's tier allows.
// The server never trusts a document: it rebuilds it from a whitelist (known pieces, themes, patterns), clamps every number, cleans every text,
// and only stores it when the wallet's signature over the cleaned document's hash checks out. A document is data, never code.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifyMessage } = require('ethers');
const { clean } = require('./filter');
const CAT = require('./room_catalog.json');

const LIMITS = { pieces: 40, name: 32, text: 24, size: [9, 7], maxAgeMs: 2 * 60e3 };      // free room: 40 pieces on a 9 x 7 floor
const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, a, b) => Math.max(a, Math.min(b, Math.round((+v || 0) * 100) / 100));
const text = (raw, max) => clean(String(raw == null ? '' : raw).slice(0, 120)).text.replace(/\[(link|address) removed\]/g, '').trim().slice(0, max);

// the cleaned document: fixed key order, so the same room always hashes the same
function sanitize(doc, limit = LIMITS.pieces, size = LIMITS.size, fallbackName = 'My Home') {
  if (!doc || typeof doc !== 'object') throw new Error('no room');
  const [W, D] = size, out = {};
  out.name = text(doc.name, LIMITS.name) || fallbackName;
  out.theme = CAT.themes.includes(doc.theme) ? doc.theme : 'studio';
  if (CAT.views.includes(doc.view)) out.view = doc.view;                            // a pinned window view; absent = the real clock (never a light level: interiors are lit by their pieces only)
  for (const [key, pats] of [['wall', CAT.walls], ['floor', CAT.floors]]) {
    const v = doc[key]; if (!v || typeof v !== 'object') continue;
    const o = {}; if (typeof v.c === 'string' && HEX.test(v.c)) o.c = v.c.toLowerCase(); if (pats.includes(v.pat)) o.pat = v.pat;
    if (Object.keys(o).length) out[key] = o;
  }
  if (doc.windows === false) out.windows = false;
  out.pieces = [];
  for (const it of (Array.isArray(doc.pieces) ? doc.pieces : []).slice(0, limit)) {
    const def = it && CAT.pieces[it.p]; if (!def) continue;
    const o = { p: it.p, x: num(it.x, -W / 2, W / 2), z: num(it.z, -D / 2, D / 2) };
    const ry = ((Math.round((+it.ry || 0) / 90) * 90) % 360 + 360) % 360; if (ry) o.ry = ry;
    if (typeof it.c === 'string' && HEX.test(it.c)) o.c = it.c.toLowerCase();
    if (def.edit) { const t = text(it.txt, LIMITS.text); if (t) o.txt = t; }
    out.pieces.push(o);
  }
  return out;
}

const hashOf = doc => crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex');
// what the wallet shows when asked to sign: readable, tied to the exact document, valid for two minutes
const messageFor = (doc, ts, kind = 'room') => `Chog Town ${kind}\nSave "${doc.name}" (${doc.pieces.length} pieces).\nThis costs nothing and sends no transaction.\nHash: ${hashOf(doc)}\nTime: ${ts}`;

// ---- storage: one file per wallet (DATA_DIR/<sub>/<address>.json), a small cache in memory per store
// kind = 'room' | 'venue' | 'facade' (what the wallet is told it signs); lim = { limit, size, name } overrides the free-room budget
function open(dataDir, sub = 'rooms', kind = 'room') {
  const dir = path.join(dataDir, sub); fs.mkdirSync(dir, { recursive: true });
  const cache = new Map(), file = addr => path.join(dir, addr + '.json');
  const ok = addr => /^0x[0-9a-f]{40}$/.test(addr);
  const clean_ = (raw, lim = {}) => { const d = sanitize(raw, lim.limit ?? LIMITS.pieces, lim.size ?? LIMITS.size, lim.name ?? 'My Home'); return lim.post ? lim.post(d) : d; };       // post: a last rule on the cleaned document (the facade keeps its door clear)
  return {
    get(addr) {
      if (!ok(addr)) return null;
      if (cache.has(addr)) return cache.get(addr);
      let r = null; try { r = JSON.parse(fs.readFileSync(file(addr), 'utf8')); } catch (e) { /* none yet */ }
      if (r) { cache.set(addr, r); if (cache.size > 500) cache.delete(cache.keys().next().value); }
      return r;
    },
    // prepare: the cleaned document and the message the wallet must sign
    prepare(raw, lim, now = Date.now()) { const doc = clean_(raw, lim); return { doc, ts: now, message: messageFor(doc, now, kind), hash: hashOf(doc) }; },
    // save: verify that `addr` signed exactly this cleaned document just now
    save(addr, raw, ts, sig, lim, now = Date.now()) {
      if (!ok(addr)) throw new Error('no wallet');
      ts = +ts; if (!Number.isFinite(ts) || Math.abs(now - ts) > LIMITS.maxAgeMs) throw new Error('The signature is too old. Press Save again.');
      const doc = clean_(raw, lim);
      let who; try { who = verifyMessage(messageFor(doc, ts, kind), String(sig)).toLowerCase(); } catch (e) { throw new Error('That signature is not valid.'); }
      if (who !== addr) throw new Error('That signature is from another wallet.');
      const rec = { addr, doc, hash: hashOf(doc), sig: String(sig), ts, savedAt: now };
      const tmp = file(addr) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(rec)); fs.renameSync(tmp, file(addr));
      cache.set(addr, rec); return rec;
    },
  };
}

module.exports = { open, sanitize, hashOf, messageFor, LIMITS, CAT };
