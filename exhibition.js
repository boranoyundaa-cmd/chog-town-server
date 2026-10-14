'use strict';
// The weekly Home contest (docs/project/build-plan.md, Exhibition floor). A week runs Monday 00:00 UTC to Sunday 24:00 and has a theme.
// Entering: a wallet with a saved Home signs "Enter <week>" and the server keeps a snapshot copy of that Home (one entry per wallet per week; it can be replaced until Sunday 12:00 UTC;
// replacing with a different Home clears the votes it had, so nobody collects votes and then swaps the entry).
// Voting: one signed vote per wallet per week, never for yourself, movable until Sunday 24:00. Only a wallet with a saved Home (at least one piece) may vote: an empty
// wallet costs nothing to create, a saved Home needs a signature and some effort. Vote counts are hidden from a player until they voted, and shown to everyone once the week is over.
// Winner: most votes, a tie goes to the EARLIER submission (the time of the last submit or replace); no winner without at least one vote.
// The winner gets a trophy (kept per wallet here: exposed as `trophies` in ex_list) and heads the next week's Exhibition floor.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifyMessage } = require('ethers');
const { hashOf } = require('./rooms');

const DAY = 86400e3, WEEK = 7 * DAY, SUBMIT_MS = 6.5 * DAY, MAX_AGE_MS = 2 * 60e3;       // entries close Sunday 12:00 UTC, votes Sunday 24:00 UTC
const THEMES = ['Bull run', 'Rekt', 'Cosy trading desk', 'Wen moon', 'Gm cafe', 'Degen penthouse', 'Diamond hands', 'Airdrop party', 'Bear market bunker', 'Mint day', 'Validator den', 'Number go up'];
const MONDAY0 = Date.UTC(1970, 0, 5);                                                         // a Monday

const weekStart = t => MONDAY0 + Math.floor((t - MONDAY0) / WEEK) * WEEK;
const themeOf = start => THEMES[(((Math.round((start - MONDAY0) / WEEK)) % THEMES.length) + THEMES.length) % THEMES.length];
function weekKey(start) {                                                                       // ISO week label "2026-W42" (the Thursday of the week decides the year)
  const th = new Date(start + 3 * DAY), y = th.getUTCFullYear(), jan1 = Date.UTC(y, 0, 1);
  return y + '-W' + String(Math.floor((th.getTime() - jan1) / WEEK) + 1).padStart(2, '0');
}
const idOf = (key, addr) => 'e' + crypto.createHash('sha256').update(key + ':' + addr).digest('hex').slice(0, 12);      // public handle of an entry: no wallet address on the wire
const short = a => a.slice(0, 6) + '…' + a.slice(-4);
const submitMessage = (key, theme, doc, ts) => `Chog Hotel exhibition\nEnter ${key} (theme "${theme}") with "${doc.name}" (${doc.pieces.length} pieces).\nThis costs nothing and sends no transaction.\nHash: ${hashOf(doc)}\nTime: ${ts}`;
const voteMessage = (key, e, ts) => `Chog Hotel exhibition\nVote ${key} for "${e.name}" (${e.id}).\nOne vote per week, you can move it until the week ends. This costs nothing and sends no transaction.\nTime: ${ts}`;

function open(dataDir, opts = {}) {
  const now = opts.now || Date.now, rooms = opts.rooms, users = opts.users || { nameOf: () => null };
  const file = path.join(dataDir, 'exhibition.json');
  let db = { weeks: {}, results: {}, trophies: {} };                                            // weeks[start] = { key, theme, entries: {addr: entry}, votes: {voter: {id, at}} }
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* first run */ }
  const save = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, file); };
  const weekOf = start => db.weeks[start] || (db.weeks[start] = { key: weekKey(start), theme: themeOf(start), entries: {}, votes: {} });
  const homeOf = addr => { const r = addr && rooms.get(addr); return r && r.doc && r.doc.pieces && r.doc.pieces.length ? r : null; };
  const eligible = addr => !!homeOf(addr);                                                       // who may vote
  const label = addr => users.nameOf(addr) || short(addr);
  const info = (t = now()) => { const s = weekStart(t); return { key: weekKey(s), theme: themeOf(s), start: s, submitUntil: s + SUBMIT_MS, endsAt: s + WEEK, submitOpen: t < s + SUBMIT_MS, voteOpen: t < s + WEEK }; };

  // the ranking of one week: most votes (only voters that are still eligible), then the earlier submission
  function ranking(w) {
    const n = {}; for (const [voter, v] of Object.entries(w.votes)) if (eligible(voter) && w.entries[v.addr] && v.addr !== voter) n[v.addr] = (n[v.addr] || 0) + 1;
    return Object.values(w.entries).map(e => ({ e, votes: n[e.addr] || 0 })).sort((a, b) => b.votes - a.votes || a.e.at - b.e.at);
  }
  // weeks that are over get their result once (and the winner's trophy); called before every answer, so no timer is needed
  function tick() {
    const t = now(), cur = weekStart(t); let changed = false;
    for (const [s, w] of Object.entries(db.weeks)) {
      const start = +s; if (start >= cur) continue;
      if (!db.results[w.key]) {
        const top = ranking(w)[0], win = top && top.votes > 0 ? top : null;
        db.results[w.key] = { theme: w.theme, start, entries: Object.keys(w.entries).length, winner: win ? win.e.addr : null, votes: win ? win.votes : 0, name: win ? win.e.name : null };
        if (win) (db.trophies[win.e.addr] || (db.trophies[win.e.addr] = [])).push({ week: w.key, theme: w.theme, name: win.e.name, votes: win.votes });
        changed = true;
      }
      if (start < cur - 2 * WEEK) { delete db.weeks[s]; changed = true; }                         // the snapshots of old weeks go; the result and the trophy stay
    }
    if (changed) save();
  }
  const winnerEntry = () => {                                                                     // last week's winner: shown first on this week's floor
    const prev = weekStart(now()) - WEEK, w = db.weeks[prev], r = w && db.results[w.key];
    return r && r.winner && w.entries[r.winner] ? { e: w.entries[r.winner], votes: r.votes, week: w } : null;
  };

  const api = {
    THEMES, info, eligible, weekKey, weekStart, themeOf,
    trophies: addr => (db.trophies[addr] || []).slice(-40),
    // everything the Exhibition floor needs for one player. Counts only after you voted (a finished week shows them to all: that is the winner door).
    list(addr) {
      tick(); const I = info(), w = weekOf(I.start), mine = addr && w.entries[addr], my = addr && w.votes[addr], voted = !!my;
      const n = {}; for (const r of ranking(w)) n[r.e.addr] = r.votes;
      const entries = Object.values(w.entries).sort((a, b) => a.at - b.at).map(e => ({ id: e.id, name: e.name, by: e.by, theme: w.theme, votes: voted ? n[e.addr] || 0 : null, mine: e.addr === addr, yours: voted && my.addr === e.addr, at: e.at }));
      const win = winnerEntry();
      return { week: I, entries, winner: win ? { id: win.e.id, name: win.e.name, by: win.e.by, theme: win.week.theme, week: win.week.key, votes: win.votes, winner: true } : null,
        you: { signedIn: !!addr, entered: !!mine, voted: voted ? my.id : null, eligible: !!addr && eligible(addr), hasHome: !!(addr && homeOf(addr)), canEnter: !!addr && I.submitOpen && !!homeOf(addr) }, trophies: addr ? api.trophies(addr) : [] };
    },
    // one entry to look at (this week's, or last week's winner); the doc is the snapshot
    view(id) {
      tick(); const cur = weekStart(now());
      for (const s of [cur, cur - WEEK]) { const w = db.weeks[s]; if (!w) continue; for (const e of Object.values(w.entries)) if (e.id === id) return { id, doc: e.doc, name: e.name, by: e.by, theme: w.theme, week: w.key, at: e.at, current: s === cur, owner: e.addr }; }
      return null;
    },
    prepareSubmit(addr) {
      tick(); const I = info(); if (!addr) throw new Error('Connect and sign in with your wallet to enter the contest.');
      if (!I.submitOpen) throw new Error('Entries for this week closed on Sunday noon (UTC). The next week starts on Monday.');
      const h = homeOf(addr); if (!h) throw new Error('Save your Home first (with at least one piece), then you can enter the contest.');
      const ts = now(); return { ts, message: submitMessage(I.key, I.theme, h.doc, ts), n: h.doc.pieces.length };
    },
    submit(addr, ts, sig) {
      tick(); const I = info(), t = now(); if (!addr) throw new Error('Connect and sign in with your wallet to enter the contest.');
      if (!I.submitOpen) throw new Error('Entries for this week closed on Sunday noon (UTC). The next week starts on Monday.');
      const h = homeOf(addr); if (!h) throw new Error('Save your Home first (with at least one piece), then you can enter the contest.');
      ts = +ts; if (!Number.isFinite(ts) || Math.abs(t - ts) > MAX_AGE_MS) throw new Error('The signature is too old. Press the button again.');
      let who; try { who = verifyMessage(submitMessage(I.key, I.theme, h.doc, ts), String(sig)).toLowerCase(); } catch (e) { throw new Error('That signature is not valid.'); }
      if (who !== addr) throw new Error('That signature is from another wallet.');
      const w = weekOf(I.start), old = w.entries[addr], hash = hashOf(h.doc);
      if (old && old.hash !== hash) for (const [voter, v] of Object.entries(w.votes)) if (v.addr === addr) delete w.votes[voter];     // a different Home is a different entry: its votes start again
      w.entries[addr] = { id: idOf(I.key, addr), addr, name: h.doc.name, by: label(addr), doc: JSON.parse(JSON.stringify(h.doc)), hash, sig: String(sig), ts, at: t, replaced: !!old };
      save(); return { replaced: !!old, id: w.entries[addr].id };
    },
    prepareVote(addr, id) {
      tick(); const I = info(), w = weekOf(I.start); const e = Object.values(w.entries).find(x => x.id === id);
      if (!addr) throw new Error('Connect and sign in with your wallet to vote.');
      if (!e) throw new Error('That entry is not in this week\'s contest.');
      if (e.addr === addr) throw new Error('You cannot vote for your own entry.');
      if (!eligible(addr)) throw new Error('Save a Home of your own first (with at least one piece), then you can vote.');
      const ts = now(); return { ts, id, message: voteMessage(I.key, e, ts) };
    },
    vote(addr, id, ts, sig) {
      tick(); const I = info(), t = now(), w = weekOf(I.start); const e = Object.values(w.entries).find(x => x.id === id);
      if (!addr) throw new Error('Connect and sign in with your wallet to vote.');
      if (!e) throw new Error('That entry is not in this week\'s contest.');
      if (e.addr === addr) throw new Error('You cannot vote for your own entry.');
      if (!eligible(addr)) throw new Error('Save a Home of your own first (with at least one piece), then you can vote.');
      ts = +ts; if (!Number.isFinite(ts) || Math.abs(t - ts) > MAX_AGE_MS) throw new Error('The signature is too old. Press Vote again.');
      let who; try { who = verifyMessage(voteMessage(I.key, e, ts), String(sig)).toLowerCase(); } catch (x) { throw new Error('That signature is not valid.'); }
      if (who !== addr) throw new Error('That signature is from another wallet.');
      const moved = !!w.votes[addr] && w.votes[addr].id !== id;
      w.votes[addr] = { id, addr: e.addr, at: t, sig: String(sig), ts }; save(); return { moved };
    },
    // the player-facing protocol (index.js hands every message that starts with "ex_" to this)
    onMessage(p, m, send) {
      const t = now(); if (p.lastEx && t - p.lastEx < 400) return send(p, { t: 'ex_fail', reason: 'Slow down a little.' }) || true; p.lastEx = t;
      try {
        if (m.t === 'ex_list') send(p, Object.assign({ t: 'ex_list' }, api.list(p.addr)));
        else if (m.t === 'ex_prep') { const r = api.prepareSubmit(p.addr); send(p, { t: 'ex_prep', message: r.message, ts: r.ts }); }
        else if (m.t === 'ex_submit') { const r = api.submit(p.addr, m.ts, m.sig); send(p, Object.assign({ t: 'ex_done', kind: 'submit', replaced: r.replaced }, api.list(p.addr))); }
        else if (m.t === 'ex_voteprep') { const r = api.prepareVote(p.addr, String(m.id)); send(p, { t: 'ex_voteprep', message: r.message, ts: r.ts, id: r.id }); }
        else if (m.t === 'ex_vote') { const r = api.vote(p.addr, String(m.id), m.ts, m.sig); send(p, Object.assign({ t: 'ex_done', kind: 'vote', moved: r.moved }, api.list(p.addr))); }
        else return false;
      } catch (e) { send(p, { t: 'ex_fail', reason: e.message }); }
      return true;
    },
  };
  return api;
}
module.exports = { open, THEMES, weekStart, weekKey, themeOf, WEEK, DAY, SUBMIT_MS };
