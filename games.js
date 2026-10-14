'use strict';
// Mini-games: score book (daily and weekly boards, best scores, daily-capped trophies, badges) and the two-player match referee.
// No tokens, no money. The client computes record games (stack, rhythm, daily) and sends only the result, which is checked against
// per-game limits here; the two-player games (rock-paper-scissors, dance copy, connect four, long/short duel) are played on the server
// so choices are revealed together and moves are validated. Identity = wallet if signed in, else the guest id the page keeps in localStorage.
// Messages (all start with `g_`), client -> server:
//   g_hello {gid}  g_me {}  g_board {game, period:'day'|'week'}  g_score {game, ...result}  (npc: g_score {game, npc:true, won})
//   g_challenge {to, game}  g_accept {cid}  g_decline {cid}  g_cancel {cid}  g_move {mid, ...}  g_quit {mid}
// Server -> client: g_me, g_board, g_scored, g_invite, g_gone, g_start, g_round, g_state, g_reveal, g_end, g_reward, g_err.
// Docs: docs/engineering/server.md (Mini-games). The ENGINE block below is copied verbatim into prototype/js/games.js (it runs the NPC opponent);
// server/test/games.js fails when the two copies differ, so edit the server copy and paste it over.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ENGINE-BEGIN
// Pure match rules for the four two-player games. No I/O: `rng()` gives [0,1), `now` is a millisecond clock chosen by the caller.
// gmMatch(game, rng, now) -> { start(now), move(seat, msg, now), tick(now), quit(seat), take() -> [{to:'all'|0|1, msg}], over, winner, score }
const GM_TWO = ['rps', 'dance', 'c4', 'ls'];
const GM_RPS_BEATS = { r: 's', p: 'r', s: 'p' };
const GM_C4 = { cols: 7, rows: 6 };
function gmC4Win(grid, c, r) {                                 // grid[c][r], r = 0 is the bottom row; returns the four cells of a winning line through (c, r), or null
  const who = grid[c][r]; if (who == null) return null;
  for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const line = [[c, r]];
    for (const s of [1, -1]) for (let k = 1; k < 4; k++) { const cc = c + dc * k * s, rr = r + dr * k * s; if (cc < 0 || rr < 0 || cc >= GM_C4.cols || rr >= GM_C4.rows || grid[cc][rr] !== who) break; line.push([cc, rr]); }
    if (line.length >= 4) return line.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 4);
  }
  return null;
}
function gmCandles(rng, n, start) {                            // a fake price chart: a random walk with a drifting mood, candles as [open, high, low, close]
  const out = []; let p = start, mood = (rng() - 0.5) * 0.8;
  for (let i = 0; i < n; i++) {
    if (rng() < 0.18) mood = (rng() - 0.5) * 1.2;
    const o = p, c = Math.max(5, o * (1 + (mood * 0.35 + (rng() - 0.5) * 2.4) / 100)), hi = Math.max(o, c) * (1 + rng() * 0.012), lo = Math.min(o, c) * (1 - rng() * 0.012);
    out.push([+o.toFixed(2), +hi.toFixed(2), +lo.toFixed(2), +c.toFixed(2)]); p = c;
  }
  return out;
}
function gmMatch(game, rng, now0) {
  const m = { game, over: false, winner: -1, score: [0, 0], round: 0, ev: [], st: {} };
  const emit = (to, msg) => m.ev.push({ to, msg });
  const done = (winner, why, extra) => { if (m.over) return; m.over = true; m.winner = winner; emit('all', Object.assign({ t: 'g_end', winner, score: m.score.slice(), why: why || '' }, extra)); };
  const byScore = () => (m.score[0] > m.score[1] ? 0 : m.score[1] > m.score[0] ? 1 : -1);
  m.take = () => { const e = m.ev; m.ev = []; return e; };
  m.quit = seat => done(1 - seat, 'left');
  const st = m.st;
  if (game === 'rps') {
    const resolve = now => {
      for (let i = 0; i < 2; i++) if (!st.picks[i]) st.picks[i] = 'rps'[(rng() * 3) | 0];
      const [a, b] = st.picks, win = a === b ? -1 : GM_RPS_BEATS[a] === b ? 0 : 1;
      if (win >= 0) m.score[win]++;
      emit('all', { t: 'g_reveal', round: m.round, picks: st.picks.slice(), win, score: m.score.slice() });
      st.played++;
      if (m.score[0] >= 2 || m.score[1] >= 2 || st.played >= 5) return done(byScore(), 'rounds');
      m.round++; st.picks = [null, null]; st.start = now + 3200; st.dl = st.start + 15000;
      emit('all', { t: 'g_round', round: m.round, ms: 15000, delay: 3200 });
    };
    m.start = now => { st.picks = [null, null]; st.played = 0; m.round = 1; st.start = now; st.dl = now + 15000; emit('all', { t: 'g_round', round: 1, ms: 15000, delay: 0 }); };
    m.move = (seat, msg, now) => {
      if (m.over || now < st.start - 100 || st.picks[seat] || !(msg.pick in GM_RPS_BEATS)) return;
      st.picks[seat] = msg.pick; emit('all', { t: 'g_state', ready: [!!st.picks[0], !!st.picks[1]] });
      if (st.picks[0] && st.picks[1]) resolve(now);
    };
    m.tick = now => { if (!m.over && now >= st.dl) resolve(now); };
  } else if (game === 'dance') {
    const begin = (now, delay) => {
      const len = Math.min(6, 3 + m.round), leader = (m.round + 1) % 2, showMs = 900 + len * 650;
      st.seq = Array.from({ length: len }, () => (rng() * 4) | 0); st.follower = 1 - leader; st.start = now + delay; st.dl = st.start + showMs + 8000 + len * 800;
      emit('all', { t: 'g_round', round: m.round, leader, seq: st.seq, showMs, delay, ms: st.dl - st.start });
    };
    const resolve = (ok, now) => {
      if (ok) m.score[st.follower]++;
      emit('all', { t: 'g_reveal', round: m.round, ok, follower: st.follower, score: m.score.slice() });
      if (m.round >= 4) return done(byScore(), 'rounds');
      m.round++; begin(now, 3000);
    };
    m.start = now => { m.round = 1; begin(now, 0); };
    m.move = (seat, msg, now) => {
      if (m.over || seat !== st.follower || now < st.start || !Array.isArray(msg.seq) || msg.seq.length > 8) return;
      resolve(msg.seq.length === st.seq.length && msg.seq.every((v, i) => v === st.seq[i]), now);
    };
    m.tick = now => { if (!m.over && now >= st.dl) resolve(false, now); };
  } else if (game === 'c4') {
    st.grid = Array.from({ length: GM_C4.cols }, () => Array(GM_C4.rows).fill(null)); st.turn = 0; st.n = 0;
    m.start = now => { st.dl = now + 45000; emit('all', { t: 'g_round', turn: 0, ms: 45000 }); };
    m.move = (seat, msg, now) => {
      const c = msg.col;
      if (m.over || seat !== st.turn || !Number.isInteger(c) || c < 0 || c >= GM_C4.cols) return;
      const r = st.grid[c].indexOf(null); if (r < 0) return;
      st.grid[c][r] = seat; st.n++;
      const line = gmC4Win(st.grid, c, r); st.turn = 1 - seat; st.dl = now + 45000;
      emit('all', { t: 'g_state', col: c, row: r, seat, turn: st.turn, ms: 45000 });
      if (line) { m.score[seat] = 1; done(seat, 'four', { line }); } else if (st.n >= GM_C4.cols * GM_C4.rows) done(-1, 'full');
    };
    m.tick = now => { if (!m.over && now >= st.dl) done(1 - st.turn, 'timeout'); };
  } else if (game === 'ls') {
    const begin = (now, delay) => {
      for (let tries = 0; tries < 20; tries++) {
        const all = gmCandles(rng, 32, 80 + rng() * 120); st.hist = all.slice(0, 28); st.fut = all.slice(28);
        if (Math.abs(st.fut[3][3] / st.hist[27][3] - 1) > 0.004) break;
      }
      st.picks = [null, null]; st.start = now + delay; st.dl = st.start + 11000;
      emit('all', { t: 'g_round', round: m.round, hist: st.hist, ms: 11000, delay });
    };
    const resolve = now => {
      const base = st.hist[27][3], end = st.fut[3][3], mv = (end / base - 1) * 100, sg = { L: 1, S: -1 };
      const pnl = st.picks.map(s => +((sg[s] || 0) * mv).toFixed(2)), win = pnl[0] === pnl[1] ? -1 : pnl[0] > pnl[1] ? 0 : 1;
      if (win >= 0) m.score[win]++;
      emit('all', { t: 'g_reveal', round: m.round, picks: st.picks.slice(), fut: st.fut, pnl, win, score: m.score.slice() });
      st.played++;
      if (m.score[0] >= 2 || m.score[1] >= 2 || st.played >= 5) return done(byScore(), 'rounds');
      m.round++; begin(now, 5200);
    };
    m.start = now => { m.round = 1; st.played = 0; begin(now, 0); };
    m.move = (seat, msg, now) => {
      if (m.over || now < st.start - 100 || st.picks[seat] || (msg.side !== 'L' && msg.side !== 'S')) return;
      st.picks[seat] = msg.side; emit('all', { t: 'g_state', ready: [!!st.picks[0], !!st.picks[1]] });
      if (st.picks[0] && st.picks[1]) resolve(now);
    };
    m.tick = now => { if (!m.over && now >= st.dl) resolve(now); };
  }
  return m;
}
// ENGINE-END

const GAME_META = {                                           // id -> how the board counts (max = best score, sum = wins)
  stack: { name: 'Stack the luggage', agg: 'max' }, rhythm: { name: 'Rhythm', agg: 'max' }, daily: { name: 'Daily Chog', agg: 'max' },
  rps: { name: 'Rock paper scissors', agg: 'sum' }, dance: { name: 'Dance copy', agg: 'sum' }, c4: { name: 'Connect four', agg: 'sum' }, ls: { name: 'Long/Short duel', agg: 'sum' },
};
const LIMITS = {
  stackMax: 80, stackTrophy: 8, rhythmNotesMin: 20, rhythmNotesMax: 400, rhythmTrophyAcc: 0.6, rhythmPerfect: 1000, rhythmGood: 600, dailyGuesses: 6,
  submitGapMs: 15000, pairWinsPerDay: 5, inviteMs: 20000, boardTop: 10, keepDays: 14, keepWeeks: 8, trophiesKept: 400,
};
const SUPPLY = 1969;
const dayKey = t => new Date(t).toISOString().slice(0, 10);
const weekKey = t => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };      // the Monday of the week (UTC)
const randRng = () => crypto.randomInt(0, 2 ** 30) / 2 ** 30;

function open(dataDir, env = {}) {
  const clock = env.now || Date.now;
  const file = path.join(dataDir, 'games.json');
  let db = { v: 1, best: {}, names: {}, boards: {}, trophies: {}, badges: {}, played: {}, wins: {}, daily: {}, pairs: {} };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.v === 1) db = Object.assign(db, j); } catch (e) { /* first run */ }
  let dirty = false, timer = null;
  const save = () => { dirty = true; if (!timer) { timer = setTimeout(flush, 2000); if (timer.unref) timer.unref(); } };
  function flush() { if (timer) { clearTimeout(timer); timer = null; } if (!dirty) return; dirty = false; try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); } catch (e) { console.warn('games save failed', e.message); } }
  function prune() {
    const t = clock(), keepD = dayKey(t - LIMITS.keepDays * 864e5), keepW = weekKey(t - LIMITS.keepWeeks * 7 * 864e5);
    for (const k of Object.keys(db.boards)) if ((k[0] === 'd' && k.slice(2) < keepD) || (k[0] === 'w' && k.slice(2) < keepW)) delete db.boards[k];
    for (const k of Object.keys(db.pairs)) if (k.split('|')[2] < keepD) delete db.pairs[k];
  }
  prune();

  const sendTo = env.send || ((p, m) => { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(m)); });
  const players = env.players || new Map();
  const identOf = p => (p.addr ? 'w:' + p.addr : p.gid ? 'g:' + p.gid : 'c:' + p.id);
  const persists = ident => ident[0] !== 'c';                        // a guest without a page id is not remembered
  const err = (p, reason) => sendTo(p, { t: 'g_err', reason });

  // ---------- score book
  const board = (period, t) => { const k = (period === 'week' ? 'w:' + weekKey(t) : 'd:' + dayKey(t)); return db.boards[k] || (db.boards[k] = {}); };
  function entries(game, period, t) { const b = board(period, t)[game] || {}; return Object.entries(b).map(([id, e]) => ({ id, s: e.s, at: e.at })).sort((a, b2) => b2.s - a.s || a.at - b2.at); }
  function addScore(ident, name, game, score, t) {                  // records on both boards; returns the new rank on each
    db.names[ident] = String(name || 'Guest').slice(0, 24);
    const rank = {};
    for (const period of ['day', 'week']) {
      const b = board(period, t), g = b[game] || (b[game] = {}), e = g[ident];
      if (GAME_META[game].agg === 'sum') g[ident] = { s: (e ? e.s : 0) + score, at: t }; else if (!e || score > e.s) g[ident] = { s: score, at: t };
      rank[period] = entries(game, period, t).findIndex(x => x.id === ident) + 1;
    }
    return rank;
  }
  function leaderboard(game, period, ident, t = clock()) {
    if (!GAME_META[game]) return null;
    period = period === 'week' ? 'week' : 'day';
    const all = entries(game, period, t), you = all.findIndex(x => x.id === ident);
    return { game, period, key: period === 'week' ? weekKey(t) : dayKey(t), top: all.slice(0, LIMITS.boardTop).map((x, i) => ({ rank: i + 1, name: db.names[x.id] || 'Guest', score: x.s, you: x.id === ident })), you: you >= 0 ? { rank: you + 1, score: all[you].s } : null, total: all.length };
  }
  function awardTrophy(ident, game, t) {                           // at most one per game per day per identity
    const day = dayKey(t), list = db.trophies[ident] || (db.trophies[ident] = []);
    if (list.some(x => x.game === game && x.day === day)) return false;
    list.push({ game, day }); if (list.length > LIMITS.trophiesKept) list.shift(); return true;
  }
  const BADGES = {
    tower: 'Tower builder: 15 floors of luggage', metronome: 'Metronome: 90% perfect hits', sharp_eye: 'Sharp eye: Daily Chog in 2 guesses',
    all_rounder: 'All-rounder: played every game', duelist: 'Duelist: 10 wins against players',
  };
  function awardBadges(ident, facts) {
    const have = db.badges[ident] || (db.badges[ident] = []), got = [];
    const give = id => { if (!have.includes(id)) { have.push(id); got.push(id); } };
    if (facts.stack >= 15) give('tower');
    if (facts.perfectRate >= 0.9) give('metronome');
    if (facts.dailyGuesses && facts.dailyGuesses <= 2) give('sharp_eye');
    if (Object.keys(GAME_META).every(g => (db.played[ident] || {})[g])) give('all_rounder');
    if ((db.wins[ident] || 0) >= 10) give('duelist');
    return got;
  }
  const markPlayed = (ident, game) => { (db.played[ident] || (db.played[ident] = {}))[game] = true; };
  const profile = ident => ({ trophies: (db.trophies[ident] || []).slice(-80), badges: db.badges[ident] || [], best: db.best[ident] || {}, played: db.played[ident] || {} });

  const lastSubmit = new Map();                                    // ident|game -> time
  // A record game result from the client. Returns {ok, ...} or {ok:false, reason}.
  function submit(ident, name, game, m, t = clock()) {
    if (!GAME_META[game] || !m || typeof m !== 'object') return { ok: false, reason: 'unknown game' };
    if (!persists(ident)) return { ok: false, reason: 'no id' };
    const k = ident + '|' + game, gap = t - (lastSubmit.get(k) || 0);
    if (gap < LIMITS.submitGapMs) return { ok: false, reason: 'too fast' };
    let score = 0, trophy = false, facts = {}, npc = false;
    if (m.npc) {                                                   // a win against a resident (played in the browser): trophy only, no board
      if (!GM_TWO.includes(game) || m.won !== true) return { ok: false, reason: 'bad result' };
      npc = true; trophy = true;
    } else if (game === 'stack') {
      score = m.floors; if (!Number.isInteger(score) || score < 0 || score > LIMITS.stackMax) return { ok: false, reason: 'bad score' };
      trophy = score >= LIMITS.stackTrophy; facts.stack = score;
    } else if (game === 'rhythm') {
      const { perfect, good, miss } = m, n = perfect + good + miss;
      if (![perfect, good, miss].every(v => Number.isInteger(v) && v >= 0) || n < LIMITS.rhythmNotesMin || n > LIMITS.rhythmNotesMax) return { ok: false, reason: 'bad score' };
      score = perfect * LIMITS.rhythmPerfect + good * LIMITS.rhythmGood; trophy = (perfect + good * 0.6) / n >= LIMITS.rhythmTrophyAcc; facts.perfectRate = perfect / n;
    } else if (game === 'daily') {
      if (m.day !== dayKey(t)) return { ok: false, reason: 'wrong day' };
      const g = m.guesses; if (!Number.isInteger(g) || g < 1 || g > LIMITS.dailyGuesses || typeof m.solved !== 'boolean') return { ok: false, reason: 'bad score' };
      const d = db.daily[ident]; if (d && d.day === m.day) return { ok: false, reason: 'already played today' };
      db.daily[ident] = { day: m.day, solved: m.solved, guesses: g };
      score = m.solved ? 7 - g : 0; trophy = m.solved; if (m.solved) facts.dailyGuesses = g;
    } else return { ok: false, reason: 'not a record game' };
    lastSubmit.set(k, t); markPlayed(ident, game);
    let rank = null;
    if (!npc && (score > 0 || game === 'stack')) {
      rank = addScore(ident, name, game, score, t);
      const best = db.best[ident] || (db.best[ident] = {}); if (!(best[game] >= score)) best[game] = score;
    }
    const gotTrophy = trophy ? awardTrophy(ident, game, t) : false;
    const badges = awardBadges(ident, facts);
    save();
    return { ok: true, game, score, best: (db.best[ident] || {})[game] || 0, trophy: gotTrophy, badges, rank };
  }
  // a finished two-player match between two real identities (the referee calls this)
  function matchWon(winner, loser, name, game, t = clock()) {
    if (!winner || !persists(winner)) return null;
    const pk = [winner, loser].sort().join('|') + '|' + dayKey(t); db.pairs[pk] = (db.pairs[pk] || 0) + 1;
    markPlayed(winner, game); if (loser && persists(loser)) markPlayed(loser, game);
    if (db.pairs[pk] > LIMITS.pairWinsPerDay) { save(); return null; }          // the same two players trading wins all day do not climb the board
    const rank = addScore(winner, name, game, 1, t); db.wins[winner] = (db.wins[winner] || 0) + 1;
    const trophy = awardTrophy(winner, game, t), badges = awardBadges(winner, {});
    save(); return { game, trophy, badges, rank };
  }

  // ---------- matches
  let nextMid = 1, nextCid = 1;
  const invites = new Map(), matches = new Map();
  const timeNow = () => (env.mono ? env.mono() : Date.now());
  function startMatch(a, b, game) {
    const mid = nextMid++, m = { mid, game, seats: [a, b], eng: gmMatch(game, env.rng || randRng, timeNow()), rewarded: false };
    a.match = m; b.match = m; matches.set(mid, m);
    const info = p => ({ id: p.id, name: p.name, token: p.token });
    sendTo(a, { t: 'g_start', mid, game, you: 0, opp: info(b) }); sendTo(b, { t: 'g_start', mid, game, you: 1, opp: info(a) });
    m.eng.start(timeNow()); pump(m); return m;
  }
  function pump(m) {
    for (const { to, msg } of m.eng.take()) for (let i = 0; i < 2; i++) if (to === 'all' || to === i) sendTo(m.seats[i], Object.assign({ mid: m.mid }, msg));
    if (m.eng.over && !m.ended) endMatch(m);
  }
  function endMatch(m) {
    m.ended = true; matches.delete(m.mid);
    for (const p of m.seats) if (p.match === m) p.match = null;
    const w = m.eng.winner;
    if (w >= 0 && !m.rewarded) {
      m.rewarded = true; const win = m.seats[w], lose = m.seats[1 - w];
      const r = matchWon(identOf(win), identOf(lose), win.name, m.game);
      if (r) sendTo(win, Object.assign({ t: 'g_reward' }, r));
    }
  }
  const busy = p => !!p.match;
  function challenge(p, m) {
    const t = timeNow(), q = players.get(+m.to);
    if (!GM_TWO.includes(m.game)) return err(p, 'Unknown game.');
    if (!q || q === p || q.space !== p.space) return err(p, 'That player is not here.');
    if (identOf(q) === identOf(p)) return err(p, 'That is you in another window.');
    if (busy(p)) return err(p, 'You are already in a game.');
    if (busy(q)) return err(p, q.name + ' is in a game right now.');
    if (p.gLast && t - p.gLast < 1500) return err(p, 'Slow down a little.'); p.gLast = t;
    for (const iv of invites.values()) if (iv.from === p.id && iv.to === q.id) return err(p, 'You already asked ' + q.name + '.');
    const mine = [...invites.values()].filter(iv => iv.from === p.id).length; if (mine >= 3) return err(p, 'Too many open challenges.');
    const cid = nextCid++; invites.set(cid, { cid, from: p.id, to: q.id, game: m.game, exp: t + LIMITS.inviteMs });
    sendTo(q, { t: 'g_invite', cid, game: m.game, from: { id: p.id, name: p.name, token: p.token }, ms: LIMITS.inviteMs });
    sendTo(p, { t: 'g_sent', cid, to: q.id, game: m.game, ms: LIMITS.inviteMs });
  }
  function drop(cid, why, notify = true) {
    const iv = invites.get(cid); if (!iv) return null; invites.delete(cid);
    if (notify) for (const id of [iv.from, iv.to]) { const x = players.get(id); if (x) sendTo(x, { t: 'g_gone', cid, why }); }
    return iv;
  }
  function accept(p, m) {
    const iv = invites.get(+m.cid); if (!iv || iv.to !== p.id) return err(p, 'That challenge is gone.');
    const a = players.get(iv.from); drop(iv.cid, 'accepted', false);
    if (!a || a.space !== p.space) return err(p, 'They left.');
    if (busy(a) || busy(p)) return err(p, 'Somebody is already in a game.');
    for (const [cid, x] of [...invites]) if (x.from === a.id || x.from === p.id || x.to === a.id || x.to === p.id) drop(cid, 'busy');
    startMatch(a, p, iv.game);
  }
  function leave(p) {                                              // disconnected: forfeit any match, withdraw challenges
    for (const [cid, iv] of [...invites]) if (iv.from === p.id || iv.to === p.id) drop(cid, 'left');
    const m = p.match; if (m && !m.ended) { m.eng.quit(m.seats.indexOf(p)); pump(m); }
  }
  function tick() {
    const t = timeNow();
    for (const [cid, iv] of [...invites]) if (iv.exp <= t) drop(cid, 'expired');
    for (const m of [...matches.values()]) { m.eng.tick(t); pump(m); }
  }
  const sweeper = env.noTimers ? null : setInterval(tick, 500); if (sweeper && sweeper.unref) sweeper.unref();

  // ---------- messages from a connection; returns true when the frame was a games frame
  function onMessage(p, m) {
    if (typeof m.t !== 'string' || m.t.slice(0, 2) !== 'g_') return false;
    switch (m.t) {
      case 'g_hello': if (typeof m.gid === 'string' && /^[a-z0-9]{8,32}$/.test(m.gid)) p.gid = m.gid; sendTo(p, Object.assign({ t: 'g_me', day: dayKey(clock()) }, profile(identOf(p)))); break;
      case 'g_me': sendTo(p, Object.assign({ t: 'g_me', day: dayKey(clock()) }, profile(identOf(p)))); break;
      case 'g_board': { const b = leaderboard(String(m.game), m.period, identOf(p)); if (b) sendTo(p, Object.assign({ t: 'g_board' }, b)); break; }
      case 'g_score': {
        const r = submit(identOf(p), p.name, String(m.game), m);
        sendTo(p, Object.assign({ t: 'g_scored', game: String(m.game) }, r)); break;
      }
      case 'g_challenge': challenge(p, m); break;
      case 'g_accept': accept(p, m); break;
      case 'g_decline': drop(+m.cid, 'declined'); break;
      case 'g_cancel': { const iv = invites.get(+m.cid); if (iv && iv.from === p.id) drop(iv.cid, 'cancelled'); break; }
      case 'g_move': { const mt = p.match; if (mt && mt.mid === +m.mid && !mt.ended) { mt.eng.move(mt.seats.indexOf(p), m, timeNow()); pump(mt); } break; }
      case 'g_quit': { const mt = p.match; if (mt && mt.mid === +m.mid && !mt.ended) { mt.eng.quit(mt.seats.indexOf(p)); pump(mt); } break; }
    }
    return true;
  }
  return { onMessage, leave, tick, submit, leaderboard, matchWon, profile, flush, identOf, startMatch, invites, matches, db, BADGES };
}

module.exports = { open, gmMatch, gmC4Win, gmCandles, GAME_META, LIMITS, GM_TWO, dayKey, weekKey, SUPPLY };
