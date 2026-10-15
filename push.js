'use strict';
// Phone notifications from Lev (Web Push, docs/engineering/server.md "Phone companion"). Only paired phones subscribe (server/phone.js); the server signs with its own VAPID keys.
//   publicKey            the VAPID public key the phone subscribes with
//   subscribe(addr, sub, prefs) / unsubscribe(addr, endpoint) / prefs(addr, endpoint, prefs)   a wallet keeps at most 3 subscriptions (one per phone)
//   remind(addr, endpoint, at)   one reminder at a time per phone ("Ring me at 21:00"), at most 2 days ahead
//   visit(addr, roomNo) / tip(addr, amount, name)   what happened in the owner's room: a visit notice at most every 30 minutes per wallet
//   tick()               sends the reminders that are due (the server calls it every 30 s)
// Keys: VAPID_PUBLIC / VAPID_PRIVATE from the environment, else generated once into DATA_DIR/vapid.json (on Fly that is the volume, so they survive deploys).
// Subscriptions in DATA_DIR/push_subs.json. A subscription the push service reports gone (404 / 410) is dropped. Lev's push lines live here (the server writes them).
const fs = require('fs');
const path = require('path');

const MAX_PER_WALLET = 3, VISIT_GAP_MS = 30 * 60e3, REMIND_MAX_MS = 2 * 24 * 3600e3;
const LINES = {
  visit: ['Room {no}: a guest just walked in. Logged. *stamp*', 'Room {no} has company. I am keeping an eye on it. Professionally.', 'A visitor at room {no}. Behaving, so far. *stamp*'],
  tip: ['{name} tipped you {amount} CHOG. Logged, as always. *stamp*', 'A tip: {amount} CHOG from {name}. Do not spend it on leverage. *stamp*'],
  remind: ['You asked me to ring. I am ringing. The hotel is open. *stamp*', 'This is your call from the front desk. As requested. Nobody else requests anything. *stamp*'],
};
const fill = (t, d) => t.replace(/\{(\w+)\}/g, (m, k) => (d[k] !== undefined ? d[k] : '')).replace(/\s*\*stamp\*/g, '');
const pickLine = (k, d) => fill(LINES[k][Math.floor(Math.random() * LINES[k].length)], d || {});

function open(dir, o = {}) {
  const now = o.now || Date.now, log = o.log || (() => { });
  let webpush = o.sender || null, publicKey = null;
  if (!webpush) {
    const wp = require('web-push');
    let keys = process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE ? { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE } : null;
    const kf = path.join(dir, 'vapid.json');
    if (!keys) { try { keys = JSON.parse(fs.readFileSync(kf, 'utf8')); } catch (e) { keys = wp.generateVAPIDKeys(); try { fs.writeFileSync(kf, JSON.stringify(keys)); } catch (e2) { log('vapid keys not saved', e2.message); } } }
    wp.setVapidDetails(process.env.VAPID_SUBJECT || 'https://chog-hotel.pages.dev', keys.publicKey, keys.privateKey);
    publicKey = keys.publicKey; webpush = (sub, body) => wp.sendNotification(sub, body, { TTL: 3600 });
  } else publicKey = o.publicKey || 'test-key';
  const file = path.join(dir, 'push_subs.json');
  let subs = {}; try { subs = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { /* none yet */ }          // addr -> [{ sub, prefs, remind }]
  const save = () => { try { fs.writeFileSync(file + '.tmp', JSON.stringify(subs)); fs.renameSync(file + '.tmp', file); } catch (e) { log('push subs not saved', e.message); } };
  const lastVisit = new Map();                              // addr -> time of the last visit notice
  const cleanPrefs = p => ({ visit: !p || p.visit !== false, tip: !p || p.tip !== false });
  const validSub = s => s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000 && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
  async function deliver(addr, entry, kind, body) {
    try { await webpush(entry.sub, JSON.stringify({ title: 'Lev, front desk', body, kind, url: 'm.html' })); return true; }
    catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) { subs[addr] = (subs[addr] || []).filter(x => x !== entry); if (!subs[addr].length) delete subs[addr]; save(); log('push gone', addr); }
      else log('push failed', addr, e && (e.statusCode || e.message));
      return false;
    }
  }
  const to = (addr, kind, body) => Promise.all((subs[addr] || []).filter(x => kind === 'remind' || x.prefs[kind]).map(x => deliver(addr, x, kind, body)));
  return {
    publicKey,
    subscribe(addr, sub, prefs) {
      if (!validSub(sub)) return false;
      const list = (subs[addr] || []).filter(x => x.sub.endpoint !== sub.endpoint);
      for (const other of Object.keys(subs)) if (other !== addr) { subs[other] = subs[other].filter(x => x.sub.endpoint !== sub.endpoint); if (!subs[other].length) delete subs[other]; }      // a phone that pairs with another wallet moves over
      list.push({ sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, prefs: cleanPrefs(prefs), remind: null });
      while (list.length > MAX_PER_WALLET) list.shift();
      subs[addr] = list; save(); return true;
    },
    unsubscribe(addr, endpoint) { const before = (subs[addr] || []).length; subs[addr] = (subs[addr] || []).filter(x => x.sub.endpoint !== endpoint); if (!subs[addr].length) delete subs[addr]; save(); return before !== (subs[addr] || []).length; },
    prefs(addr, endpoint, prefs) { const e = (subs[addr] || []).find(x => x.sub.endpoint === endpoint); if (!e) return null; e.prefs = cleanPrefs(prefs); save(); return e.prefs; },
    remind(addr, endpoint, at) {
      const e = (subs[addr] || []).find(x => x.sub.endpoint === endpoint); if (!e) return null;
      at = Math.floor(+at); e.remind = Number.isFinite(at) && at > now() && at - now() <= REMIND_MAX_MS ? at : null; save(); return e.remind;
    },
    state(addr, endpoint) { const e = (subs[addr] || []).find(x => x.sub.endpoint === endpoint); return e ? { on: true, prefs: e.prefs, remind: e.remind } : { on: false }; },
    visit(addr, no) { const t = now(); if (!subs[addr] || t - (lastVisit.get(addr) || 0) < VISIT_GAP_MS) return null; lastVisit.set(addr, t); return to(addr, 'visit', pickLine('visit', { no })); },
    tip(addr, amount, name) { if (!subs[addr]) return null; return to(addr, 'tip', pickLine('tip', { amount, name })); },
    async tick() {
      const t = now(), due = [];
      for (const [addr, list] of Object.entries(subs)) for (const e of list) if (e.remind && e.remind <= t) { e.remind = null; due.push([addr, e]); }
      if (due.length) { save(); await Promise.all(due.map(([addr, e]) => deliver(addr, e, 'remind', pickLine('remind')))); }
      return due.length;
    },
    count: () => Object.values(subs).reduce((n, l) => n + l.length, 0),
  };
}
module.exports = { open, LINES, MAX_PER_WALLET, VISIT_GAP_MS };
