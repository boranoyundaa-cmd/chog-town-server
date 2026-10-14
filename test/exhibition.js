'use strict';
// The weekly Home contest: theme rotation, submit and replace, deadlines, vote rules, hidden counts, winner and trophy at week end.  Run: node test/exhibition.js (part of npm test)
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { Wallet } = require('ethers');
const roomsLib = require('../rooms'), exLib = require('../exhibition');
let n = 0; const ok = name => console.log(`  ok ${++n} ${name}`);
const throws = (fn, re) => assert.throws(fn, re);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chog-exh-'));
const MON = Date.UTC(2026, 9, 12);                                    // Monday 12 Oct 2026 00:00 UTC (ISO week 42)
let wall = MON + 10 * 3600e3;
const rooms = roomsLib.open(dir), users = { nameOf: a => (a === A.addr ? 'Ann' : null) };
const ex = exLib.open(dir, { now: () => wall, rooms, users });
const mk = () => { const w = Wallet.createRandom(); return { w, addr: w.address.toLowerCase() }; };
const A = mk(), B = mk(), C = mk(), D = mk(), E = mk(), NOHOME = mk();
async function home(P, name, pieces = 3) {                            // a signed, saved Home
  const doc = { name, theme: 'studio', pieces: Array.from({ length: pieces }, (_, i) => ({ p: 'sofa', x: i - 1, z: 0 })) };
  const prep = rooms.prepare(doc, {}, wall); rooms.save(P.addr, doc, prep.ts, await P.w.signMessage(prep.message), {}, wall);
}
const enter = async P => { const r = ex.prepareSubmit(P.addr); return ex.submit(P.addr, r.ts, await P.w.signMessage(r.message)); };
const vote = async (P, id) => { const r = ex.prepareVote(P.addr, id); return ex.vote(P.addr, id, r.ts, await P.w.signMessage(r.message)); };
const idOfName = (P, name) => ex.list(P.addr).entries.find(e => e.name === name).id;

(async () => {
  // ---- weeks and themes
  assert.equal(ex.weekKey(MON), '2026-W42'); assert.equal(ex.weekStart(wall), MON); assert.equal(ex.weekStart(MON + 7 * 864e5 - 1), MON); assert.equal(ex.weekStart(MON + 7 * 864e5), MON + 7 * 864e5); ok('a week runs Monday 00:00 to Sunday 24:00 UTC and has an ISO label');
  assert(exLib.THEMES.length >= 12); assert.notEqual(ex.themeOf(MON), ex.themeOf(MON + exLib.WEEK)); assert.equal(ex.themeOf(MON), ex.themeOf(MON + exLib.THEMES.length * exLib.WEEK)); ok('the theme changes every week and the list rotates');

  // ---- submit
  throws(() => ex.prepareSubmit(null), /sign in/); throws(() => ex.prepareSubmit(NOHOME.addr), /Save your Home/); ok('no wallet or no saved Home: no entry');
  await home(A, 'Ann Den'); await home(B, 'Bob Bar'); await home(C, 'Cat Cafe'); await home(D, 'Dan Desk'); await home(E, 'Eve Loft');
  const r1 = ex.prepareSubmit(A.addr); assert(/^Chog Hotel exhibition\nEnter 2026-W42/.test(r1.message)); assert(r1.message.includes('Hash: ')); ok('the message to sign names the week and the exact Home');
  throws(() => ex.submit(A.addr, r1.ts, 'not a signature'), /not valid/);
  throws(() => ex.submit(B.addr, r1.ts, await_sig(A, r1.message)), /another wallet/); ok('a bad or foreign signature is refused');
  wall += 3 * 60e3; throws(() => ex.submit(A.addr, r1.ts, await_sig(A, r1.message)), /too old/); ok('an old signature is refused');
  assert.equal((await enter(A)).replaced, false); await enter(B); await enter(C); await enter(D); wall += 1000; await enter(E);
  let L = ex.list(A.addr); assert.equal(L.entries.length, 5); assert.equal(L.entries[0].by, 'Ann'); assert(L.entries[1].by.includes('…')); assert(!JSON.stringify(L).includes(B.addr)); ok('five entries, shown with a username or a short address, never the wallet');
  assert.equal(L.week.theme, ex.themeOf(MON)); assert(L.you.entered && L.you.canEnter); ok('the list carries the week theme and what you can do');

  // ---- replace
  await home(A, 'Ann Den v2', 4); const rep = await enter(A); assert.equal(rep.replaced, true); assert.equal(ex.list(A.addr).entries.length, 5); assert(ex.list(A.addr).entries.some(e => e.name === 'Ann Den v2')); ok('one entry per wallet: entering again replaces it');
  assert.equal(ex.view(idOfName(A, 'Ann Den v2')).doc.pieces.length, 4); await home(A, 'Ann Den v3', 5); assert.equal(ex.view(idOfName(A, 'Ann Den v2')).doc.pieces.length, 4); ok('the entry is a snapshot: editing the Home later does not change it');

  // ---- votes
  const idA = idOfName(A, 'Ann Den v2'), idB = idOfName(B, 'Bob Bar'), idC = idOfName(C, 'Cat Cafe'), idD = idOfName(D, 'Dan Desk'), idE = idOfName(E, 'Eve Loft');
  throws(() => ex.prepareVote(A.addr, idA), /own entry/); ok('voting for yourself is refused');
  throws(() => ex.prepareVote(null, idA), /sign in/); throws(() => ex.prepareVote(NOHOME.addr, idA), /Save a Home/); throws(() => ex.prepareVote(B.addr, 'nope'), /not in this week/); ok('no wallet, no saved Home, or an unknown entry: no vote');
  const pv = ex.prepareVote(B.addr, idA); throws(() => ex.vote(B.addr, idA, pv.ts, await_sig(C, pv.message)), /another wallet/); ok('a vote needs the voter\'s own signature');
  assert.equal(ex.list(B.addr).entries.every(e => e.votes === null), true); ok('before you voted no count is shown');
  await vote(B, idA); await vote(C, idA); await vote(D, idB); await vote(E, idB); await vote(A, idC);
  L = ex.list(B.addr); assert.equal(L.entries.find(e => e.id === idA).votes, 2); assert.equal(L.you.voted, idA); ok('after voting the counts are shown');
  assert.equal(ex.list(NOHOME.addr).entries.every(e => e.votes === null), true); assert.equal(ex.list(null).entries.every(e => e.votes === null), true); ok('a visitor who did not vote sees no counts');
  const mv = await vote(B, idC); assert.equal(mv.moved, true); L = ex.list(B.addr); assert.equal(L.entries.find(e => e.id === idA).votes, 1); assert.equal(L.entries.find(e => e.id === idC).votes, 2); ok('one vote per wallet: voting again moves it');
  await vote(B, idD);                                                                      // C -> A, D -> B, E -> B, A -> C, B -> D
  L = ex.list(B.addr); assert.equal(L.entries.reduce((s, e) => s + e.votes, 0), 5); ok('five voters, five votes');

  // ---- the entry deadline: Sunday 12:00 UTC; votes go on until Sunday 24:00
  wall = MON + 6 * 864e5 + 11.9 * 3600e3; await home(A, 'Ann Den v4', 2); await enter(A); ok('Sunday before noon an entry can still be replaced');
  await vote(A, idC); wall = MON + 6 * 864e5 + 12 * 3600e3 + 1000;
  throws(() => ex.prepareSubmit(A.addr), /closed/); throws(() => ex.submit(A.addr, wall, 'x'), /closed/); assert.equal(ex.list(A.addr).you.canEnter, false); ok('after Sunday noon no new entry and no replacement');
  wall += 3600e3; await vote(C, idB); ok('votes can still be moved on Sunday afternoon');

  // ---- tally at week end (A replaced its entry with a different Home: the vote it had is gone)
  L = ex.list(D.addr); const cnt = id => L.entries.find(e => e.id === id).votes;
  assert.equal(cnt(idB), 3); assert.equal(cnt(idC), 1); assert.equal(cnt(idA), 0); ok('replacing the entry with a different Home clears the votes it had');
  wall = MON + 7 * 864e5 - 1; await vote(A, idB); wall = MON + 7 * 864e5;                    // the last millisecond counts, the next does not
  throws(() => ex.prepareVote(D.addr, idB), /not in this week/); ok('at Monday 00:00 the old week no longer takes votes');
  const next = ex.list(D.addr); assert.equal(next.week.key, '2026-W43'); assert.equal(next.entries.length, 0); assert(next.winner); assert.equal(next.winner.name, 'Bob Bar'); assert.equal(next.winner.votes, 4); assert.equal(next.winner.week, '2026-W42'); ok('the winner of last week heads the new week with its final count');
  assert.equal(ex.trophies(B.addr).length, 1); assert.equal(ex.trophies(B.addr)[0].week, '2026-W42'); assert.equal(ex.list(B.addr).trophies.length, 1); assert.equal(ex.trophies(C.addr).length, 0); ok('the winner gets a trophy, listed with the player');
  assert.equal(ex.view(next.winner.id).current, false); assert(ex.view(next.winner.id).doc); ok('last week\'s winner can still be visited');
  wall += 100; assert.equal(ex.trophies(B.addr).length, 1); ok('a trophy is awarded only once');

  // ---- tie: the earlier submission wins; no votes: no winner
  wall = MON + 7 * 864e5 + 3600e3; const W2 = MON + 7 * 864e5;
  await enter(C); wall += 5000; await enter(D); wall += 5000; await enter(E);
  const c2 = idOfName(C, 'Cat Cafe'), d2 = idOfName(C, 'Dan Desk');
  await vote(A, d2); await vote(B, c2);   await vote(C, d2); await vote(D, c2);                                                      // A, C -> D and B, D -> C: two each, C submitted first
  wall = W2 + 7 * 864e5 + 1000; const after = ex.list(A.addr);
  assert.equal(after.winner.name, 'Cat Cafe'); assert.equal(after.winner.votes, 2); assert.equal(ex.trophies(C.addr).length, 1); assert.equal(ex.trophies(D.addr).length, 0); ok('a tie goes to the earlier submission');
  wall = W2 + 14 * 864e5 + 1000; assert.equal(ex.list(A.addr).winner, null); ok('a week with no entries leaves no winner door');

  // ---- no votes at all: no winner, no trophy
  wall = W2 + 14 * 864e5 + 3600e3; await enter(B); wall += 7 * 864e5; ex.list(null); assert.equal(ex.list(A.addr).winner, null); assert.equal(ex.trophies(B.addr).length, 1); ok('an entry with no votes wins nothing');

  // ---- persistence
  const again = exLib.open(dir, { now: () => wall, rooms, users }); assert.equal(again.trophies(B.addr).length, 1); assert.equal(again.trophies(C.addr).length, 1); ok('entries and trophies survive a restart');

  // ---- the protocol wrapper
  const out = []; const p = { addr: A.addr, lastEx: 0 }, send = (q, m) => out.push(m);
  wall += 2e3; assert.equal(ex.onMessage(p, { t: 'ex_list' }, send), true); assert.equal(out.pop().t, 'ex_list');
  wall += 1e3; ex.onMessage(p, { t: 'ex_voteprep', id: 'nope' }, send); assert.equal(out.pop().t, 'ex_fail'); wall += 1e3; assert.equal(ex.onMessage(p, { t: 'ex_other' }, send), false); ok('ex_ messages are answered, errors come as ex_fail');
  console.log('exhibition: all ok');
})().catch(e => { console.error(e); process.exit(1); });
function await_sig(P, msg) { return P.w.signMessageSync(msg); }
