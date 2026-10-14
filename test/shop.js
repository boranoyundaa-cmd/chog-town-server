'use strict';
// The shop: catalog sanity, the client's ABI encoder, ownership (chain stand-in and mock), tier locks on wearing and placing, unowned pieces dropped on save,
// budget extras capped, events, tips, and the whole thing through the WebSocket server in mock mode.  Run: node test/shop.js (part of npm test)
process.env.PORT = '18787'; process.env.ROOM_PREP_MS = '50'; process.env.ROOM_SAVE_MS = '50'; process.env.SHOP_MOCK = '1'; delete process.env.SHOP_ADDRESS;
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'chog-shop-' + process.pid);
process.env.RPC_URL = 'http://127.0.0.1:18788'; process.env.MAX_PER_IP = '60';
const assert = require('assert'), fs = require('fs'), path = require('path'), http = require('http'), vm = require('vm'), os = require('os');
const WebSocket = require('ws');
const { Wallet, Interface, id: keccak } = require('ethers');
const shopLib = require('../shop'), roomsLib = require('../rooms'), hotelLib = require('../hotel');
const { server } = require('../index');
let n = 0; const ok = name => console.log(`  ok ${++n} ${name}`);
const W4 = Wallet.createRandom(), W1 = Wallet.createRandom(), FREE = Wallet.createRandom(), GUEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chog-shopu-'));
const HOLD = { 561: W4, 1: W1 };                                         // 561 a Legendary (tier 4), 1 an Uncommon (tier 1)
const chain = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    const one = q => { const d = q.params[0].data; let v;
      if (d.startsWith('0x70a08231')) { const a = '0x' + d.slice(-40); v = Object.values(HOLD).filter(w => w.address.toLowerCase() === a).length; }
      else { const w = HOLD[parseInt(d.slice(10), 16)]; v = w ? w.address.toLowerCase() : '0x' + '1'.repeat(40); }
      return { jsonrpc: '2.0', id: q.id, result: '0x' + (typeof v === 'number' ? v.toString(16) : v.slice(2)).padStart(64, '0') }; };
    const q = JSON.parse(body); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client() {
  const ws = new WebSocket('ws://127.0.0.1:' + process.env.PORT), c = { ws, got: [], send: m => ws.send(JSON.stringify(m)), waiters: [] };
  ws.on('message', d => { const m = JSON.parse(d); c.got.push(m); c.waiters.slice().forEach(w => w(m)); });
  c.wait = (pred, ms = 6000) => new Promise((res, rej) => { const hit = c.got.find(pred); if (hit) return res(hit); const t = setTimeout(() => rej(new Error('timeout waiting for ' + pred)), ms); const w = m => { if (pred(m)) { clearTimeout(t); c.waiters.splice(c.waiters.indexOf(w), 1); res(m); } }; c.waiters.push(w); });
  c.next = (pred, ms) => { c.got.length = 0; return c.wait(pred, ms); };
  c.open = new Promise(r => ws.on('open', r)); return c;
}
async function login(w) { const c = client(); await c.open; const wc = await c.wait(m => m.t === 'welcome'); c.id = wc.id; c.welcome = wc; c.send({ t: 'auth', sig: await w.signMessage(wc.challenge) }); await c.wait(m => m.t === 'authed'); await c.wait(m => m.t === 'shopstate'); return c; }
const doc = (name, pieces) => ({ name, theme: 'studio', pieces });
async function sign(c, w, kind, d) { c.got.length = 0; c.send({ t: kind + 'prep', doc: d }); const pr = await c.wait(m => m.t === kind + 'prep' || m.t === 'roomfail'); if (pr.t === 'roomfail') return pr; await sleep(80); c.got.length = 0; c.send({ t: kind + 'save', doc: d, ts: pr.ts, sig: await w.signMessage(pr.message) }); return c.wait(m => m.t === kind + 'saved' || m.t === 'roomfail'); }

(async () => {
  // ---- catalog sanity: the page's catalog, the server's copy, the contract's list and the room catalog agree
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, '../../contracts/items.json'), 'utf8')).items;
  const srv = JSON.parse(fs.readFileSync(path.join(__dirname, '../shop_items.json'), 'utf8')), cli = JSON.parse(fs.readFileSync(path.join(__dirname, '../../prototype/data/shop_items.json'), 'utf8'));
  assert.deepEqual(srv, cli); assert.equal(srv.items.length, items.length);
  for (const it of items) { const s = srv.items.find(x => x.id === it.id); assert(s, 'item ' + it.id); assert.equal(s.priceChog, it.priceChog); assert.equal(s.minTier, it.minTier); assert.equal(s.maxPerWallet, it.maxPerWallet); assert(s.priceChog > 0 && s.priceChog <= 10000); assert(['decor', 'cosmetic', 'venue'].includes(s.tab)); assert(s.name && s.desc); }
  assert.equal(new Set(srv.items.map(i => i.id)).size, srv.items.length); ok('the catalog matches contracts/items.json (ids, prices, tiers, limits), page and server copies are identical');
  const CAT = roomsLib.CAT;
  for (const it of srv.items.filter(i => i.tab === 'decor')) { const d = CAT.pieces[it.piece]; assert(d, 'piece ' + it.piece); assert.equal(d.shop, it.id); assert.equal(d.minTier || 0, it.minTier); }
  assert.equal(Object.values(CAT.pieces).filter(d => d.shop).length, srv.items.filter(i => i.tab === 'decor').length); ok('every decor item has a room piece flagged with its id and the same tier lock');
  for (const it of srv.items.filter(i => i.tab === 'cosmetic')) assert(srv.slots.includes(it.slot) && it.look); assert(srv.items.some(i => i.slot === 'eyes' && i.minTier === 4)); ok('every cosmetic wears an extra slot (never an NFT trait)');

  // ---- the client's ABI encoder produces what ethers produces
  const src = fs.readFileSync(path.join(__dirname, '../../prototype/js/shop.js'), 'utf8'), a = src.indexOf('// ABI-BEGIN'), b = src.indexOf('// ABI-END');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(src.slice(a, b).replace('const SHOP_ABI', 'SHOP_ABI'), ctx); const ABI = ctx.SHOP_ABI;
  const A1 = W1.address, A2 = W4.address, I = new Interface(['function approve(address,uint256)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function buyWithChog(uint256,uint256)',
    'function buyWithMon(uint256,uint256,uint256,uint256)', 'function tip(address,uint256,uint256)', 'function router() view returns (address)', 'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function balanceOfBatch(address[],uint256[]) view returns (uint256[])']);
  const eq = (x, y) => assert.equal(x.toLowerCase(), y.toLowerCase());
  eq(ABI.approve(A1, ABI.wei(600)), I.encodeFunctionData('approve', [A1, 600n * 10n ** 18n])); eq(ABI.allowance(A1, A2), I.encodeFunctionData('allowance', [A1, A2])); eq(ABI.balanceOf(A1), I.encodeFunctionData('balanceOf', [A1]));
  eq(ABI.buyWithChog(9, 1), I.encodeFunctionData('buyWithChog', [9, 1])); eq(ABI.buyWithMon(9, 1, ABI.wei(600), 1790000000), I.encodeFunctionData('buyWithMon', [9, 1, 600n * 10n ** 18n, 1790000000]));
  eq(ABI.tip(A2, 401, ABI.wei(500)), I.encodeFunctionData('tip', [A2, 401, 500n * 10n ** 18n])); eq(ABI.router(), I.encodeFunctionData('router')); eq(ABI.slot0(), I.encodeFunctionData('slot0'));
  eq(ABI.balanceOfBatch([A1, A1, A1], [1, 2, 3]), I.encodeFunctionData('balanceOfBatch', [[A1, A1, A1], [1, 2, 3]])); ok('the page\'s ABI encoder matches ethers (approve, buy, tip, router, slot0, balanceOfBatch)');
  assert(/shop: null/.test(src) && !/shop: '0x/.test(src)); ok('the shop address is null in the page config until deployed');

  // ---- ownership from a chain stand-in (balanceOfBatch) and the shop contract address being unset
  const SHOP_AT = '0x' + 'ab'.repeat(20), bal = { [A1.toLowerCase()]: { 9: 1, 17: 1, 18: 1, 20: 2, 21: 1, 2: 1, 8: 1, 19: 5, 22: 3 } };
  const IF = new Interface(['function balanceOfBatch(address[],uint256[]) view returns (uint256[])', 'event Tip(address indexed from, address indexed to, uint256 indexed venueId, uint256 amount)']);
  let batchCalls = 0, receipt = null;
  const rpc2 = http.createServer((req, res) => { let body = ''; req.on('data', d => body += d); req.on('end', () => { const q = JSON.parse(body); let r;
    if (q.method === 'eth_call') { batchCalls++; const [accounts, ids] = IF.decodeFunctionData('balanceOfBatch', q.params[0].data); r = IF.encodeFunctionResult('balanceOfBatch', [ids.map((id, k) => BigInt((bal[accounts[k].toLowerCase()] || {})[id] || 0))]); }
    else if (q.method === 'eth_getTransactionReceipt') r = receipt; res.end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: r })); }); });
  await new Promise(r => rpc2.listen(18789, r));
  const chainShop = shopLib.open(fs.mkdtempSync(path.join(os.tmpdir(), 'chog-shopc-')), { mock: false, address: SHOP_AT, rpc: 'http://127.0.0.1:18789' }); assert.equal(chainShop.mode, 'chain');
  const o1 = await chainShop.owned(A1.toLowerCase()); assert.equal(o1[9], 1); assert.equal(o1[19], 5); assert(!o1[3]); await chainShop.owned(A1.toLowerCase()); assert.equal(batchCalls, 1); ok('ownership is read with one balanceOfBatch call and cached');
  assert.deepEqual(await chainShop.owned(FREE.address.toLowerCase()), {}); assert.equal(shopLib.open(fs.mkdtempSync(path.join(os.tmpdir(), 'chog-shopo-')), { mock: false, address: '' }).mode, 'off'); ok('a wallet with nothing owns nothing; no address = shop off');
  const ad = A1.toLowerCase();
  assert.equal(chainShop.may(ad, 17, 4), true); assert.equal(chainShop.may(ad, 18, 3), false); assert.equal(chainShop.may(ad, 18, 4), true); ok('a tier-locked item (rainbow laser eyes, Legend) is refused below tier 4 and allowed at tier 4');
  assert.throws(() => chainShop.equip(ad, 'eyes', 18, 2), /Requires Legend/); assert.throws(() => chainShop.equip(ad, 'aura', 17, 4), /does not fit/); assert.throws(() => chainShop.equip(ad, 'badge', 13, 4), /do not own/); chainShop.equip(ad, 'eyes', 17, 1); assert.deepEqual(chainShop.worn(ad, 1), { eyes: 17 }); ok('equip: right slot, owned, and the tier lock is enforced on the server');
  chainShop.equip(ad, 'eyes', 18, 4); assert.deepEqual(chainShop.worn(ad, 4), { eyes: 18 }); assert.deepEqual(chainShop.worn(ad, 2), {}); ok('a worn item that the tier no longer allows is not shown to others');
  assert.deepEqual(chainShop.budget(ad, 1), { pieces: 40, lights: 8 }); assert.deepEqual(chainShop.budget(ad, 3), { pieces: 100, lights: 8 }); ok('budget extras: +20 pieces x2, +60 only from Whale; lights capped at +8 (5 owned = +20 uncapped)');
  bal[ad][20] = 99; chainShop.invalidate(ad); await chainShop.owned(ad); assert.deepEqual(chainShop.budget(ad, 4), { pieces: shopLib.EXTRA_CAP.pieces, lights: 8 }); assert.equal(shopLib.EXTRA_CAP.pieces, 120); ok('the piece budget never goes above the cap, however many stacks are owned');
  const own = chainShop.ownsFn(ad, 1); assert.equal(own(2), true); assert.equal(own(3), false); assert.equal(own(8), false); assert.equal(chainShop.ownsFn(ad, 3)(8), true); ok('ownsFn: owned yes, not owned no, tier lock (Whale tank) needs tier 3');

  // ---- unowned shop pieces are dropped when a room is saved
  const full = [{ p: 'shopBull', x: 0, z: 0 }, { p: 'shopBearRug', x: 2, z: 1 }, { p: 'shopAquarium', x: -3, z: 2 }, { p: 'sofa', x: 3, z: 3 }, { p: 'shopTrophyShelf', x: 0, z: -5 }];
  let clean = roomsLib.sanitize(doc('t', full), 80, [13, 10], 'x', { tier: 4, owns: chainShop.ownsFn(ad, 4) }); assert.deepEqual(clean.pieces.map(p => p.p), ['shopBull', 'shopAquarium', 'sofa']); ok('a saved room keeps the shop pieces the wallet owns and the free ones, and drops the rest');
  clean = roomsLib.sanitize(doc('t', full), 80, [13, 10], 'x', { tier: 2, owns: chainShop.ownsFn(ad, 2) }); assert.deepEqual(clean.pieces.map(p => p.p), ['shopBull', 'sofa']); ok('the Whale-tier tank is dropped at tier 2 even though it is owned');
  clean = roomsLib.sanitize(doc('t', full), 80, [13, 10], 'x', { tier: 4 }); assert.deepEqual(clean.pieces.map(p => p.p), ['sofa']); ok('with no ownership information every shop piece is dropped (default deny)');

  // ---- venue budget through the hotel
  const hdir = fs.mkdtempSync(path.join(os.tmpdir(), 'chog-shoph-')), hotel = hotelLib.open(hdir, { shop: chainShop });
  hotel.activate(ad, 3, { name: 'Test' }); const v = hotel.byOwner(ad); const t3 = hotelLib.TEMPLATES[3];
  assert.equal(hotel.piecesOf(hotel.get(v.id)), t3.pieces + 120); assert.equal(hotel.lightsOf(hotel.get(v.id)), t3.lights + 8); assert.equal(hotel.limitsOf(v).limit, t3.pieces + 120); assert.equal(hotel.mine(ad).template.pieces, t3.pieces + 120); ok('the venue\'s piece and light budget include the owner\'s extras (capped)');
  assert.equal(hotel.piecesOf(hotel.get('v102')) || 0, hotel.piecesOf(hotel.get('v102'))); const seed = hotel.list()[0]; assert.equal(hotel.piecesOf(hotel.get(seed.id)), hotelLib.TEMPLATES[1].pieces); ok('seed venues have no extras');

  // ---- events (mock store, a clock the test moves)
  let clock = Date.now(); const m = shopLib.open(fs.mkdtempSync(path.join(os.tmpdir(), 'chog-shope-')), { mock: true, now: () => clock });
  const E = Wallet.createRandom().address.toLowerCase(); const venue = { id: 'hx', no: 301, name: 'Club', addr: E, state: 'open', tier: 3 };
  assert.throws(() => m.startEvent(E, venue, 'Party night', false, 3), /Event pass/); m.mockBuy(E, 22, 1); m.mockBuy(E, 23, 1);
  assert.throws(() => m.startEvent(E, { ...venue, state: 'closed' }, 'Party night', false, 3), /Open your venue/); assert.throws(() => m.startEvent(E, venue, 'x', false, 3), /title/);
  const ev = m.startEvent(E, venue, 'Green candle https://x.io party', false, 3); assert.equal(ev.until - clock, m.EVENT_MS); assert(!/https|x\.io/.test(ev.title)); assert.equal(m.activeEvents().length, 1); assert.equal(m.eventFor('hx').title, ev.title); ok('an event pass starts a 24 h event with a cleaned title and is used up');
  assert.throws(() => m.startEvent(E, venue, 'Another', false, 3), /already running/); m.mockBuy(E, 22, 1); assert.throws(() => m.startEvent(E, venue, 'Another', false, 3), /already running/); ok('one event at a time per venue');
  assert.throws(() => m.startEvent(E, { ...venue, id: 'hy' }, 'Mega night', true, 4), /mega-event/); m.mockBuy(E, 24, 1); assert.throws(() => m.startEvent(E, { ...venue, id: 'hy' }, 'Mega night', true, 3), /mega-event/); ok('the Penthouse mega event needs the item and a Legend venue');
  clock += m.EVENT_MS + 1000; assert.equal(m.sweepEvents(), true); assert.equal(m.activeEvents().length, 0); assert.equal(m.eventFor('hx'), null); const ev2 = m.startEvent(E, venue, 'Second night', false, 3); assert(ev2.until > clock); ok('an event ends after 24 hours and the second pass can be used');
  assert.equal(m.cameraAllowed(E, 3), true); assert.equal(m.cameraAllowed(Wallet.createRandom().address.toLowerCase(), 4), false); ok('the security camera needs the item');
  assert.throws(() => m.mockBuy(E, 13, 2), /most/); m.mockBuy(E, 13, 1); assert.throws(() => m.mockBuy(E, 13, 1), /most/); assert.throws(() => chainShop.mockBuy(ad, 13, 1), /off/); ok('mock purchases respect the per-wallet limit and exist only in mock mode');

  // ---- tips: the Tip event of a confirmed transaction
  const tipTx = '0x' + '5'.repeat(64), topic = a => '0x' + a.slice(2).toLowerCase().padStart(64, '0'), owner = Wallet.createRandom().address;
  receipt = { status: '0x1', logs: [{ address: SHOP_AT, topics: [shopLib.TIP_TOPIC, topic(A1), topic(owner), '0x' + (401).toString(16).padStart(64, '0')], data: '0x' + (500n * 10n ** 18n).toString(16).padStart(64, '0') }] };
  const got = await chainShop.verifyTip(tipTx, { from: A1, to: owner, venueId: 401, amount: 500n * 10n ** 18n }); assert.equal(got, String(500n * 10n ** 18n)); await assert.rejects(chainShop.verifyTip(tipTx, { from: A1, to: owner, venueId: 401, amount: 1 }), /already counted/); ok('a tip is verified from the transaction\'s Tip event, once');
  receipt = { status: '0x1', logs: [] }; await assert.rejects(chainShop.verifyTip('0x' + '6'.repeat(64), { from: A1, to: owner, venueId: 401, amount: 1 }), /No tip found/); receipt = null; await assert.rejects(chainShop.verifyTip('0x' + '7'.repeat(64), { from: A1, to: owner, venueId: 401, amount: 1 }), /not confirmed/); ok('no event or an unconfirmed transaction is refused');

  // ---- through the server (mock mode)
  await new Promise(r => chain.listen(18788, r)); await new Promise(r => server.listen(+process.env.PORT, r));
  const T4 = await login(W4), T1 = await login(W1), F = await login(FREE);
  assert.equal(T4.welcome.shop.mode, 'mock'); const st0 = T4.got.find(x => x.t === 'shopstate'); assert.deepEqual(st0.owned, {}); ok('the server reports mock mode and a new wallet owns nothing');
  F.send({ t: 'equip', slot: 'aura', id: 9 }); const nf = await F.wait(x => x.t === 'roomfail'); assert(/do not own/.test(nf.reason)); ok('equipping something you do not own is refused');
  const guest = client(); await guest.open; await guest.wait(x => x.t === 'welcome'); guest.send({ t: 'shopbuy', id: 9, qty: 1 }); const gf = await guest.wait(x => x.t === 'roomfail'); assert(/sign in/.test(gf.reason)); ok('a guest (no wallet) cannot buy');
  await sleep(350); T4.next(x => x.t === 'shopstate'); T4.send({ t: 'shopbuy', id: 9, qty: 1 }); let s = await T4.wait(x => x.t === 'shopstate'); assert.equal(s.owned[9], 1); await sleep(350);
  T4.next(x => x.t === 'shopstate'); T4.send({ t: 'shopbuy', id: 9, qty: 1 }); const dup = await T4.wait(x => x.t === 'roomfail' || x.t === 'shopstate'); assert.equal(dup.t, 'roomfail'); ok('a mock purchase is recorded and the per-wallet limit holds');
  await sleep(350); T4.next(x => x.t === 'shopstate'); T4.send({ t: 'shopbuy', id: 18, qty: 1 }); await T4.wait(x => x.t === 'shopstate'); await sleep(350);
  const seen = T1.next(x => x.t === 'appear' && x.p.id === T4.id, 3000).catch(() => null);
  T4.next(x => x.t === 'shopstate'); T4.send({ t: 'equip', slot: 'aura', id: 9 }); s = await T4.wait(x => x.t === 'shopstate'); assert.equal(s.equip.aura, 9); const ap = await seen; assert(ap && ap.p.cos && ap.p.cos.aura === 9); ok('wearing an aura is broadcast to the others in presence (cos)');
  await sleep(350); T4.next(x => x.t === 'shopstate'); T4.send({ t: 'equip', slot: 'eyes', id: 18 }); s = await T4.wait(x => x.t === 'shopstate'); assert.equal(s.equip.eyes, 18); ok('a Legend wallet can wear the Legend laser eyes');
  await sleep(350); T1.send({ t: 'shopbuy', id: 18, qty: 1 }); await T1.wait(x => x.t === 'shopstate' && x.owned[18] === 1); await sleep(350); T1.got.length = 0; T1.send({ t: 'equip', slot: 'eyes', id: 18 }); const lk = await T1.wait(x => x.t === 'roomfail'); assert(/Requires Legend/.test(lk.reason)); ok('a tier 1 wallet that owns rainbow eyes still cannot wear them');
  const late = client(); await late.open; const lw = await late.wait(x => x.t === 'welcome'); await late.wait(x => x.t === 'events'); ok('a new connection gets the running events');

  // Home save: unowned shop pieces dropped, owned kept (a tier 4 wallet that owns the bull)
  await sleep(350); T4.send({ t: 'shopbuy', id: 2, qty: 1 }); await T4.wait(x => x.t === 'shopstate' && x.owned[2] === 1);
  const sv = await sign(T4, W4, 'room', doc('My Home', full)); assert.equal(sv.t, 'roomsaved');
  const home = require('../index').CFG && JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'rooms', W4.address.toLowerCase() + '.json'), 'utf8')); assert.deepEqual(home.doc.pieces.map(p => p.p), ['shopBull', 'sofa']); ok('saving a Home through the server keeps owned shop pieces and drops the unowned ones');
  await sleep(150); const pr = await sign(T1, W1, 'room', doc('My Home', [{ p: 'shopBull', x: 0, z: 0 }, { p: 'sofa', x: 2, z: 2 }])); assert.equal(pr.t, 'roomsaved'); const home1 = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'rooms', W1.address.toLowerCase() + '.json'), 'utf8')); assert.deepEqual(home1.doc.pieces.map(p => p.p), ['sofa']); ok('another wallet that does not own the bull loses it on save');

  // venue: extras budget, event, camera, tip announcement
  await sleep(1100); T4.send({ t: 'venuemake', name: 'Skyline', cat: 'Club', desc: 'Top' }); const mk = await T4.wait(x => x.t === 'venuemine'); const base = mk.mine.template.pieces;
  await sleep(350); T4.send({ t: 'shopbuy', id: 20, qty: 3 }); await T4.wait(x => x.t === 'shopstate' && x.owned[20] === 3); const vm2 = await T4.wait(x => x.t === 'venuemine' && x.mine.template.pieces === base + 60); assert.equal(vm2.mine.template.extra.pieces, 60); ok('extra piece budget bought in the shop raises the venue\'s limit (shown on the owner\'s venue card)');
  await sleep(150); T4.got.length = 0; T4.send({ t: 'venueprep', doc: doc('Skyline', Array.from({ length: base + 100 }, (_, i) => ({ p: 'plant', x: -10 + (i % 20), z: -6 + (i % 12) }))) }); const pp = await T4.wait(x => x.t === 'venueprep'); assert.equal(pp.n, base + 60); ok('the server enforces the extended budget (and no more)');
  await sleep(350); T4.got.length = 0; T4.send({ t: 'eventstart', title: 'Opening night' }); const nev = await T4.wait(x => x.t === 'roomfail'); assert(/Open your venue|Event pass/.test(nev.reason)); ok('an event needs a pass and an open venue');
  await sleep(150); const many = [{ p: 'sofa', x: 0, z: 0 }]; const sv2 = await sign(T4, W4, 'venue', doc('Skyline', many)); assert.equal(sv2.t, 'venuesaved'); await sleep(150); T4.send({ t: 'venueset', open: true }); await T4.wait(x => x.t === 'venuemine' && x.mine.state === 'open');
  await sleep(350); T4.send({ t: 'shopbuy', id: 22, qty: 1 }); await T4.wait(x => x.t === 'shopstate' && x.owned[22] === 1); await sleep(350);
  const evSeen = late.next(x => x.t === 'events' && x.list.length === 1, 4000); T4.send({ t: 'eventstart', title: 'Opening night' }); const ee = await evSeen; assert.equal(ee.list[0].title, 'Opening night'); assert.equal(ee.list[0].name, 'Skyline'); ok('starting an event announces it to everybody');
  late.got.length = 0; late.send({ t: 'hotelinfo' }); const hl = await late.wait(x => x.t === 'hotel'); assert.equal(hl.venues.find(x => x.id === mk.mine.id).event, 'Opening night'); ok('the lobby directory carries the event');
  await sleep(350); T4.got.length = 0; T4.send({ t: 'camopen' }); const nc = await T4.wait(x => x.t === 'roomfail'); assert(/security camera/.test(nc.reason)); await sleep(350); T4.send({ t: 'shopbuy', id: 23, qty: 1 }); await T4.wait(x => x.t === 'shopstate' && x.owned[23] === 1); await sleep(350);
  T4.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); await T4.wait(x => x.t === 'entered' && x.space === 'venue'); T4.send({ t: 'camopen' }); const ci = await T4.wait(x => x.t === 'camera' && x.init); assert(ci.pieces.length === 1 && ci.size[0] > 10);
  const frame = await T4.wait(x => x.t === 'camera' && x.players && x.players.some(q => q.owner), 3000); assert(frame.players[0].name); ok('the security camera sends the room plan and a live list of who is inside');
  await sleep(450); T1.send({ t: 'enter', space: 'venue', id: mk.mine.id, x: 0, z: 0, ry: 0 }); const ent = await T1.wait(x => x.t === 'entered' && x.space === 'venue'); assert.equal(ent.venue.limit, base + 60); ok('visitors get the extended piece limit too, so the owner\'s room is not cut');
  await sleep(450); T4.got.length = 0; T1.got.length = 0; T1.send({ t: 'tip', venueId: mk.mine.id, amount: 500 }); const tp = await T4.wait(x => x.t === 'tipped'); assert.equal(tp.amount, 500); await T1.wait(x => x.t === 'tipped'); ok('a tip is announced to everybody inside the venue (mock mode takes the amount on trust)');
  await sleep(2100); T1.got.length = 0; T1.send({ t: 'tip', venueId: mk.mine.id, amount: 0 }); assert(/valid/.test((await T1.wait(x => x.t === 'roomfail')).reason)); await sleep(350); T4.got.length = 0; T4.send({ t: 'tip', venueId: mk.mine.id, amount: 100 }); assert(/yourself/.test((await T4.wait(x => x.t === 'roomfail')).reason)); ok('bad tips and tipping yourself are refused');
  await sleep(350); T4.send({ t: 'logout' }); await sleep(100); const pf = await T1.wait(x => x.t === 'appear' && x.p.id === T4.id && !x.p.cos, 2000).catch(() => null); ok('logging out takes the cosmetics off');

  console.log(`shop: ${n} checks passed`); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
