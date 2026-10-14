'use strict';
// Mini-games: score limits, daily trophy cap, boards, rock-paper-scissors reveal, connect four, long/short, challenge flow.  Run: node test/games.js (part of npm test)
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const G = require('../games');
let n = 0; const ok = name => console.log(`  ok ${++n} ${name}`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chog-games-'));
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);                         // a Thursday, UTC noon
let wall = T0, mono = 1000;
const mk = id => ({ id, name: 'P' + id, token: null, addr: '0x' + String(id).repeat(40), space: 'city', out: [], match: null });
const A = mk(1), B = mk(2), C = mk(3);
const players = new Map([A, B, C].map(p => [p.id, p]));
let seed = 7; const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const games = G.open(dir, { now: () => wall, mono: () => mono, send: (p, m) => p.out.push(m), players, rng, noTimers: true });
const last = (p, t) => [...p.out].reverse().find(m => m.t === t);

// ---- the shared engine is the same text on both sides
const strip = s => { const a = s.indexOf('// ENGINE-BEGIN'), b = s.indexOf('// ENGINE-END'); assert(a >= 0 && b > a); return s.slice(a, b).replace(/\r/g, ''); };
assert.equal(strip(fs.readFileSync(path.join(__dirname, '../games.js'), 'utf8')), strip(fs.readFileSync(path.join(__dirname, '../../prototype/js/games.js'), 'utf8'))); ok('the engine in prototype/js/games.js is identical to the server copy');

// ---- record games: limits
const W = '0x' + 'a'.repeat(40);
const sub = (g, m, ident = 'w:' + W) => games.submit(ident, 'Ann', g, m, wall);
assert.equal(sub('stack', { floors: 81 }).ok, false); assert.equal(sub('stack', { floors: -1 }).ok, false); assert.equal(sub('stack', { floors: 3.5 }).ok, false); ok('stack: floors above the limit, negative or fractional are refused');
wall += 20000; const s1 = sub('stack', { floors: 5 }); assert(s1.ok); assert.equal(s1.trophy, false); assert.equal(s1.rank.day, 1); ok('stack: a normal score is recorded, no trophy under the threshold');
assert.equal(sub('stack', { floors: 9 }).reason, 'too fast'); ok('stack: submissions closer than 15 s are refused');
wall += 20000; const s2 = sub('stack', { floors: 9 }); assert(s2.ok && s2.trophy && s2.best === 9); ok('stack: 9 floors earns the trophy');
wall += 20000; const s3 = sub('stack', { floors: 12 }); assert(s3.ok); assert.equal(s3.trophy, false); assert.equal(s3.best, 12); ok('daily trophy cap: a second good run the same day gives no second trophy');
assert.equal(games.profile('w:' + W).trophies.length, 1); ok('the profile lists exactly one trophy');
wall += 864e5; const s4 = sub('stack', { floors: 10 }); assert(s4.trophy); ok('the next UTC day the trophy is available again');
wall = T0 + 864e5 + 3e4;
assert.equal(sub('rhythm', { perfect: 5, good: 5, miss: 5 }).ok, false); assert.equal(sub('rhythm', { perfect: 500, good: 0, miss: 0 }).ok, false); ok('rhythm: too few or too many notes are refused');
const r1 = sub('rhythm', { perfect: 80, good: 10, miss: 10 }); assert(r1.ok); assert.equal(r1.score, 80 * 1000 + 10 * 600); assert(r1.trophy); ok('rhythm: the score is computed on the server from the counts');
wall += 20000; assert.equal(sub('rhythm', { perfect: 95, good: 3, miss: 2 }).badges[0], 'metronome'); ok('rhythm: 90% perfect earns the Metronome badge');
const dayNow = G.dayKey(wall);
assert.equal(sub('daily', { day: '2020-01-01', guesses: 2, solved: true }).reason, 'wrong day'); ok('daily: only today\'s puzzle can be submitted');
const d1 = sub('daily', { day: dayNow, guesses: 2, solved: true }); assert(d1.ok); assert.equal(d1.score, 5); assert(d1.badges.includes('sharp_eye')); ok('daily: score is 7 minus guesses, and 2 guesses gives Sharp eye');
wall += 20000; assert.equal(sub('daily', { day: dayNow, guesses: 1, solved: true }).reason, 'already played today'); ok('daily: one result per day per identity');
assert.equal(sub('rps', { npc: false }).ok, false); assert.equal(sub('nothing', {}).ok, false); ok('a two-player game cannot be submitted as a record, unknown games are refused');
const nw = sub('c4', { npc: true, won: true }); assert(nw.ok && nw.trophy && nw.rank === null); ok('a win against a resident gives the (capped) trophy and no board entry');
assert.equal(games.submit('c:5', 'x', 'stack', { floors: 3 }, wall).ok, false); ok('a connection with no id is not remembered');

// ---- boards
for (let i = 0; i < 12; i++) { wall += 20000; games.submit('g:guest' + String(i).padStart(8, '0'), 'Guest ' + i, 'stack', { floors: 10 + i }, wall); }
const lb = games.leaderboard('stack', 'day', 'w:' + W, wall);
assert.equal(lb.top.length, 10); assert.equal(lb.top[0].score, 21); assert(lb.you && lb.you.rank > 10); assert.equal(lb.total, 13); ok('leaderboard: top 10 sorted, and your own rank below it');
const lw = games.leaderboard('stack', 'week', 'w:' + W, wall); assert(lw.total >= 13 && lw.key === G.weekKey(wall)); assert.equal(G.weekKey(Date.UTC(2026, 9, 15)), '2026-10-12'); ok('weekly board: weeks start on Monday (UTC)');
assert.equal(games.leaderboard('stack', 'day', 'w:' + W, wall + 2 * 864e5).total, 0); ok('a new day starts an empty daily board');

// ---- persistence
games.flush(); const again = G.open(dir, { now: () => wall, noTimers: true });
assert.equal(again.leaderboard('stack', 'day', 'w:' + W, wall).top[0].score, 21); assert.equal(again.profile('w:' + W).badges.includes('metronome'), true); ok('scores, trophies and badges survive a restart');

// ---- rock paper scissors: simultaneous reveal
const send = (p, m) => games.onMessage(p, m);
send(A, { t: 'g_challenge', to: 2, game: 'rps' });
const inv = last(B, 'g_invite'); assert(inv && inv.game === 'rps' && inv.from.id === 1 && last(A, 'g_sent')); ok('challenge: the target gets an invitation, the sender a confirmation');
send(B, { t: 'g_accept', cid: inv.cid });
const st = last(A, 'g_start'); assert(st && st.you === 0 && st.opp.id === 2 && last(B, 'g_start').you === 1); const mid = st.mid; ok('accept: both get g_start with their seat');
A.out.length = 0; B.out.length = 0; mono += 500;
send(A, { t: 'g_move', mid, pick: 'r' });
assert(!A.out.concat(B.out).some(m => m.t === 'g_reveal')); assert.deepEqual(last(B, 'g_state').ready, [true, false]); assert(!JSON.stringify(B.out).includes('"r"')); ok('rps: after one pick nothing is revealed and the opponent only sees "ready"');
send(B, { t: 'g_move', mid, pick: 's' });
const rv = last(A, 'g_reveal'); assert.deepEqual(rv.picks, ['r', 's']); assert.equal(rv.win, 0); assert.deepEqual(last(B, 'g_reveal').picks, ['r', 's']); ok('rps: both picks are revealed together, rock beats scissors');
mono += 4000; send(A, { t: 'g_move', mid, pick: 'p' }); send(B, { t: 'g_move', mid, pick: 'p' });
assert.equal(last(A, 'g_reveal').win, -1); assert(!last(A, 'g_end')); ok('rps: a tie does not count and the match goes on');
mono += 4000; send(A, { t: 'g_move', mid, pick: 'p' }); send(B, { t: 'g_move', mid, pick: 'r' });
const end = last(A, 'g_end'); assert(end && end.winner === 0 && end.why === 'rounds'); assert(last(A, 'g_reward') && last(A, 'g_reward').trophy); assert(!last(B, 'g_reward')); ok('rps: first to two wins; the winner gets the reward, the loser none');
assert.equal(A.match, null); ok('the match is cleaned up');
assert.equal(games.leaderboard('rps', 'day', games.identOf(A), wall).top[0].score, 1); ok('rps: the win is on the board');
// timeout: a missing pick is chosen for you after the deadline
send(A, { t: 'g_challenge', to: 2, game: 'rps' }); send(B, { t: 'g_accept', cid: last(B, 'g_invite').cid }); const mid2 = last(A, 'g_start').mid;
send(A, { t: 'g_move', mid: mid2, pick: 'r' }); mono += 16000; games.tick(); assert(last(A, 'g_reveal')); ok('rps: a player who does not pick in time gets a random pick, the round still resolves');
send(B, { t: 'g_quit', mid: mid2 }); assert(last(A, 'g_end').winner === 0 && last(A, 'g_end').why === 'left'); ok('quitting forfeits');

// ---- challenge rules
send(A, { t: 'g_challenge', to: 3, game: 'dance' }); const iv3 = last(C, 'g_invite'); assert(iv3);
send(A, { t: 'g_challenge', to: 3, game: 'dance' }); assert(last(A, 'g_err')); ok('challenge: asking the same player twice is refused');
mono += 21000; games.tick(); assert.equal(last(C, 'g_gone').why, 'expired'); send(C, { t: 'g_accept', cid: iv3.cid }); assert(!C.match); ok('challenge: an invitation expires after 20 s');
send(C, { t: 'g_challenge', to: 1, game: 'c4' }); send(A, { t: 'g_decline', cid: last(A, 'g_invite').cid }); assert.equal(last(C, 'g_gone').why, 'declined'); ok('challenge: decline reaches the challenger');
C.space = 'room:x'; mono += 2000; A.out.length = 0; send(A, { t: 'g_challenge', to: 3, game: 'rps' }); assert(last(A, 'g_err')); C.space = 'city'; ok('challenge: only players in the same space');

// ---- connect four
const E = (g, r) => G.gmMatch(g, r || rng, 0);
{
  const m = E('c4'); m.start(0); m.take();
  const play = (seat, col, t = 1) => { m.move(seat, { col }, t); return m.take(); };
  play(1, 0); assert.equal(m.st.n, 0); ok('connect four: moving out of turn is ignored');
  for (let i = 0; i < 3; i++) { play(0, i); play(1, i); }                  // seat 0 takes the bottom row at columns 0-2, seat 1 the row above
  const ev = play(0, 3); const end = ev.find(e => e.msg.t === 'g_end');
  assert(end && end.msg.winner === 0 && end.msg.line.length === 4); assert.deepEqual(end.msg.line.map(c => c[1]), [0, 0, 0, 0]); ok('connect four: a horizontal four wins and the line is reported');
}
{
  const m = E('c4'); m.start(0); m.take(); const play = (seat, col) => { m.move(seat, { col }, 1); return m.take(); };
  let ev; for (let i = 0; i < 3; i++) { play(0, 0); play(1, 1); } ev = play(0, 0);
  assert(ev.find(e => e.msg.t === 'g_end' && e.msg.winner === 0)); ok('connect four: a vertical four wins');
}
{
  const m = E('c4'); m.start(0); m.take(); const play = (seat, col) => { m.move(seat, { col }, 1); return m.take(); };
  // diagonal for seat 0: (0,0) (1,1) (2,2) (3,3)
  const cols = [0, 1, 1, 2, 6, 2, 2, 3, 6, 3, 5, 3, 3];                    // seat 0 owns the rising diagonal (0,0) (1,1) (2,2) (3,3); seat 1 gets three in a row twice but never four
  let win = null; cols.forEach((c, i) => { const ev = play(i % 2, c); const e = ev.find(x => x.msg.t === 'g_end'); if (e) win = e.msg; });
  assert(win && win.winner === 0 && win.why === 'four'); const line = win.line; assert.deepEqual(line.map(c => c[0]), [0, 1, 2, 3]); assert.deepEqual(line.map(c => c[1]), [0, 1, 2, 3]); ok('connect four: a diagonal four wins');
}
{
  const g = Array.from({ length: 7 }, () => Array(6).fill(null)); g[3][0] = g[4][1] = g[5][2] = 1; g[6][3] = 1;
  assert.deepEqual(G.gmC4Win(g, 4, 1).map(String), ['3,0', '4,1', '5,2', '6,3']); g[6][3] = 0; assert.equal(G.gmC4Win(g, 4, 1), null); ok('connect four: the falling diagonal and the near miss');
  const m = E('c4'); m.start(0); m.take(); for (let i = 0; i < 6; i++) { m.move(0, { col: 0 }, 1); m.take(); m.move(1, { col: 0 }, 1); m.take(); if (m.over) break; }
  assert.equal(m.st.grid[0].indexOf(null), -1); m.move(m.st.turn, { col: 0 }, 1); assert.equal(m.take().length, 0); ok('connect four: a full column refuses another piece');
  const m2 = E('c4'); m2.start(0); m2.take(); m2.tick(46000); const e = m2.take().find(x => x.msg.t === 'g_end'); assert(e && e.msg.winner === 1 && e.msg.why === 'timeout'); ok('connect four: running out of time loses');
}

// ---- long/short
{
  let sd = 3; const r2 = () => { sd = (sd * 48271) % 2147483647; return sd / 2147483647; };
  const m = E('ls', r2); m.start(0); const ev = m.take(); const rd = ev.find(e => e.msg.t === 'g_round').msg;
  assert.equal(rd.hist.length, 28); assert(rd.hist.every(c => c.length === 4 && c[1] >= Math.max(c[0], c[3]) && c[2] <= Math.min(c[0], c[3]))); assert(!JSON.stringify(rd).includes('fut')); ok('long/short: both get the same 28 candles and the future stays hidden');
  const hid = m.st.hist, fut = m.st.fut, base = hid[27][3], mv = (fut[3][3] / base - 1) * 100;
  m.move(0, { side: 'L' }, 1); assert(!m.take().some(e => e.msg.t === 'g_reveal')); m.move(1, { side: 'S' }, 1);
  const rv = m.take().find(e => e.msg.t === 'g_reveal').msg;
  assert.deepEqual(rv.pnl, [+(mv).toFixed(2), +(-mv).toFixed(2)]); assert.equal(rv.win, mv > 0 ? 0 : 1); assert.equal(rv.fut.length, 4); ok('long/short: PnL is the move of the next four candles, long gains what short loses, the better PnL wins the round');
  const m2 = E('ls', r2); m2.start(0); m2.take(); m2.move(0, { side: 'L' }, 1); m2.move(1, { side: 'L' }, 1); const rv2 = m2.take().find(e => e.msg.t === 'g_reveal').msg; assert.equal(rv2.win, -1); assert.deepEqual(m2.score, [0, 0]); ok('long/short: the same side on both is a tie round');
  const m3 = E('ls', r2); m3.start(0); m3.take(); m3.move(0, { side: 'X' }, 1); assert.equal(m3.st.picks[0], null); m3.tick(12000); const rv3 = m3.take().find(e => e.msg.t === 'g_reveal').msg; assert.deepEqual(rv3.picks, [null, null]); ok('long/short: an invalid side is ignored, no pick by the deadline is a flat position');
  const m4 = E('ls', r2); m4.start(0); m4.take(); let t = 1, guard = 0, end = null;
  while (!end && guard++ < 12) { m4.move(0, { side: 'L' }, t); m4.move(1, { side: 'S' }, t); end = m4.take().find(e => e.msg.t === 'g_end'); t += 6000; }
  assert(end && (end.msg.winner === 0 || end.msg.winner === 1) && Math.max(...end.msg.score) === 2); ok('long/short: best of three ends at two round wins');
}

// ---- dance copy
{
  const m = E('dance'); m.start(0); const r = m.take().find(e => e.msg.t === 'g_round').msg;
  assert.equal(r.seq.length, 4); assert.equal(r.leader, 0); m.move(0, { seq: r.seq }, 5000); assert.equal(m.take().length, 0); ok('dance: only the follower can answer');
  m.move(1, { seq: r.seq.slice(0, 3) }, 5000); const bad = m.take().find(e => e.msg.t === 'g_reveal').msg; assert.equal(bad.ok, false); ok('dance: a wrong sequence scores nothing');
  const r2 = m.take(); m.tick(100000); const nx = m.take().find(e => e.msg.t === 'g_round'); assert(nx); ok('dance: a missed deadline moves to the next round');
}

fs.rmSync(dir, { recursive: true, force: true }); console.log(`\nall ${n} games checks passed`);
