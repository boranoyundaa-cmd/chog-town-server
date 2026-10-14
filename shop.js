'use strict';
// The shop (docs/project/build-plan.md): soulbound ERC-1155 items on the ChogShop contract (contracts/). The server never holds funds and never signs;
// it READS what a wallet owns (balanceOfBatch, cached), and enforces what that ownership allows: decor pieces in a saved room, cosmetics worn in the extra Chog slots,
// venue budget extras, events, the security camera, tip announcements. Tier locks are enforced here too (the contract stores minTier but does not check it).
//
// Config (env): SHOP_ADDRESS  the deployed ChogShop (empty = the shop is "opening soon": nothing can be owned)
//               CHOG_TOKEN    the $CHOG token (default below; only used to document the pair, the server reads the shop contract)
//               SHOP_MOCK=1   local testing: purchases are recorded in DATA_DIR/shop/<wallet>.json (never use on the live server)
// The catalog (ids, prices, tiers) is shop_items.json, built from contracts/items.json by tools/build_shop_catalog.js.
const fs = require('fs');
const path = require('path');
const { Interface } = require('ethers');
const { clean } = require('./filter');
const CATALOG = require('./shop_items.json');

const CHOG_TOKEN = '0x350035555E10d9AfAF1566AaebfCeD5BA6C27777';
const SLOTS = CATALOG.slots, ITEMS = CATALOG.items, BY_ID = new Map(ITEMS.map(i => [i.id, i]));
const EXTRA_CAP = CATALOG.extraCap;                       // the most extra pieces / lights any venue can get, however many stacks are owned
const EVENT_MS = 24 * 3600e3, TTL = 60e3, TITLE_MAX = 40;
const IFACE = new Interface(['function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])', 'event Tip(address indexed from, address indexed to, uint256 indexed venueId, uint256 amount)']);
const TIP_TOPIC = IFACE.getEvent('Tip').topicHash;
const OK_ADDR = /^0x[0-9a-f]{40}$/;
const text = (raw, max) => clean(String(raw == null ? '' : raw).slice(0, 200)).text.replace(/\[(link|address) removed\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function open(dataDir, opts = {}) {
  const now = opts.now || Date.now;
  const mock = opts.mock !== undefined ? !!opts.mock : process.env.SHOP_MOCK === '1';
  const address = (opts.address !== undefined ? opts.address : process.env.SHOP_ADDRESS || '').toLowerCase() || null;
  const rpcUrl = opts.rpc || process.env.RPC_URL || 'https://rpc.monad.xyz';
  const mode = mock ? 'mock' : address ? 'chain' : 'off';
  const dir = path.join(dataDir, 'shop'); fs.mkdirSync(dir, { recursive: true });
  const writeJson = (file, obj) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); };

  // ---- per wallet record: what is worn, how many events were used, mock purchases
  const recs = new Map();
  const recFile = a => path.join(dir, a + '.json');
  function rec(addr) {
    if (!OK_ADDR.test(addr)) throw new Error('no wallet');
    let r = recs.get(addr);
    if (!r) { try { r = JSON.parse(fs.readFileSync(recFile(addr), 'utf8')); } catch (e) { r = {}; } r.equip = r.equip || {}; r.used = r.used || {}; r.mock = r.mock || {}; recs.set(addr, r); if (recs.size > 2000) recs.delete(recs.keys().next().value); }
    return r;
  }
  const save = addr => writeJson(recFile(addr), rec(addr));

  // ---- ownership: the chain's balances (cached), or the mock store
  const cache = new Map(), busy = new Map();
  async function chainBalances(addr) {
    const ids = ITEMS.map(i => i.id), data = IFACE.encodeFunctionData('balanceOfBatch', [ids.map(() => addr), ids]);
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(rpcUrl, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data }, 'latest'] }) });
      const j = await r.json(); if (!j.result) throw new Error(j.error ? j.error.message : 'no result');
      const out = {}; IFACE.decodeFunctionResult('balanceOfBatch', j.result)[0].forEach((b, k) => { if (b > 0n) out[ids[k]] = Number(b > 1000000n ? 1000000n : b); });
      return out;
    } finally { clearTimeout(timer); }
  }
  async function owned(addr, fresh = false) {                    // { itemId: qty }, cached for a minute; fresh = skip the cache (after a purchase)
    if (!OK_ADDR.test(addr || '')) return {};
    if (mode === 'off') return {};
    if (mode === 'mock') return Object.assign({}, rec(addr).mock);
    const c = cache.get(addr); if (c && !fresh && now() - c.at < TTL) return c.owned;
    if (busy.has(addr)) return busy.get(addr);
    const pr = chainBalances(addr).then(o => { cache.set(addr, { at: now(), owned: o }); if (cache.size > 2000) cache.delete(cache.keys().next().value); return o; }).finally(() => busy.delete(addr));
    busy.set(addr, pr); return pr;
  }
  const ownedSync = addr => (mode === 'mock' ? (OK_ADDR.test(addr || '') ? rec(addr).mock : {}) : mode === 'chain' && cache.get(addr) ? cache.get(addr).owned : {});     // what the last reading said (never reads the chain)
  const qty = (addr, id) => ownedSync(addr)[id] || 0;
  const invalidate = addr => cache.delete(addr);
  // can this wallet use the item at this tier? (own it, and the venue / license tier reaches the item's lock)
  const may = (addr, id, tier) => { const it = BY_ID.get(id); return !!it && it.active !== false && qty(addr, id) > 0 && (it.minTier || 0) <= (tier || 0); };
  const ownsFn = (addr, tier) => id => may(addr, id, tier);       // handed to rooms.sanitize: a shop piece is kept only if this says yes

  // ---- mock purchase (SHOP_MOCK=1 only): the same limits the contract has (active, max per wallet)
  function mockBuy(addr, id, n = 1) {
    if (mode !== 'mock') throw new Error('Mock purchases are off on this server.');
    const it = BY_ID.get(+id); if (!it || it.active === false) throw new Error('That item is not for sale.');
    n = Math.max(1, Math.min(50, Math.floor(+n) || 1)); const r = rec(addr), have = r.mock[it.id] || 0;
    if (it.maxPerWallet && have + n > it.maxPerWallet) throw new Error('You already own the most of this you can.');
    r.mock[it.id] = have + n; save(addr); return r.mock;
  }

  // ---- worn cosmetics (extra slots only, never the NFT's traits)
  function equip(addr, slot, id, tier) {
    if (!SLOTS.includes(slot)) throw new Error('No such slot.');
    const r = rec(addr);
    if (id == null) delete r.equip[slot];
    else {
      const it = BY_ID.get(+id); if (!it || it.slot !== slot) throw new Error('That does not fit this slot.');
      if (!qty(addr, it.id)) throw new Error('You do not own that.');
      if ((it.minTier || 0) > (tier || 0)) throw new Error('Requires ' + ['', 'Ser', 'Fren', 'Whale', 'Legend'][it.minTier] + '.');
      r.equip[slot] = it.id;
    }
    save(addr); return worn(addr, tier);
  }
  const worn = (addr, tier) => { const out = {}, e = rec(addr).equip; for (const s of SLOTS) if (e[s] && may(addr, e[s], tier)) out[s] = e[s]; return out; };      // what others see: only what is still owned and allowed

  // ---- venue budget extras (never above EXTRA_CAP)
  function budget(addr, tier) {
    const b = { pieces: 0, lights: 0 };
    if (!addr) return b;
    for (const it of ITEMS) if (it.extra && may(addr, it.id, tier)) for (const k of ['pieces', 'lights']) b[k] += (it.extra[k] || 0) * qty(addr, it.id);
    b.pieces = Math.min(b.pieces, EXTRA_CAP.pieces); b.lights = Math.min(b.lights, EXTRA_CAP.lights); return b;
  }

  // ---- events: a purchase is one 24 hour announcement (the shop item is used up); the title shows in the directory and as a town banner
  const evFile = path.join(dir, 'events.json'); let events = {};
  try { events = JSON.parse(fs.readFileSync(evFile, 'utf8')); } catch (e) { events = {}; }
  const evSave = () => writeJson(evFile, events);
  const itemOfUse = use => ITEMS.find(i => i.use === use);
  function available(addr, use, tier) { const it = itemOfUse(use); if (!it || !may(addr, it.id, tier)) return 0; return Math.max(0, qty(addr, it.id) - (rec(addr).used[it.id] || 0)); }
  function startEvent(addr, venue, title, mega, tier) {
    if (!venue || venue.addr !== addr) throw new Error('You have no venue yet.');
    if (venue.state !== 'open') throw new Error('Open your venue first, then announce the event.');
    const t = text(title, TITLE_MAX); if (t.length < 3) throw new Error('Give the event a title (at least 3 letters).');
    const cur = events[venue.id]; if (cur && cur.until > now()) throw new Error('An event is already running at your venue.');
    const use = mega ? 'mega' : 'event', it = itemOfUse(use);
    if (!available(addr, use, tier)) throw new Error(mega ? 'You need a Penthouse mega-event from the shop (Legend venues).' : 'You need an Event pass from the shop.');
    const r = rec(addr); r.used[it.id] = (r.used[it.id] || 0) + 1; save(addr);
    events[venue.id] = { id: venue.id, no: venue.no, name: venue.name, title: t, mega: !!mega, addr, at: now(), until: now() + EVENT_MS }; evSave();
    return events[venue.id];
  }
  const activeEvents = () => Object.values(events).filter(e => e.until > now()).sort((a, b) => (b.mega - a.mega) || a.until - b.until).map(e => ({ id: e.id, no: e.no, name: e.name, title: e.title, mega: !!e.mega, until: e.until }));
  const eventFor = id => { const e = events[id]; return e && e.until > now() ? e : null; };
  function sweepEvents() { let ch = false; for (const k of Object.keys(events)) if (events[k].until <= now()) { delete events[k]; ch = true; } if (ch) evSave(); return ch; }
  function dropEvent(id) { if (events[id]) { delete events[id]; evSave(); } }

  // ---- tips: the player pays on chain; the client reports the transaction and the server checks the Tip event before it tells the venue
  const seenTx = new Set();
  async function verifyTip(tx, want) {                            // want: { from, to, venueId, amount (wei string or number) } -> amount actually tipped (string) or throws
    if (mode === 'off') throw new Error('The shop is not open yet.');
    if (mode === 'mock') return String(want.amount);
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx || '')) throw new Error('No transaction.');
    if (seenTx.has(tx)) throw new Error('That tip was already counted.');
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    let j; try { const r = await fetch(rpcUrl, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [tx] }) }); j = await r.json(); } finally { clearTimeout(timer); }
    const rc = j && j.result; if (!rc || rc.status !== '0x1') throw new Error('That transaction is not confirmed.');
    const pad = a => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
    const lg = (rc.logs || []).find(l => (l.address || '').toLowerCase() === address && l.topics && l.topics[0] === TIP_TOPIC && l.topics[1] === pad(want.from) && l.topics[2] === pad(want.to) && BigInt(l.topics[3]) === BigInt(want.venueId));
    if (!lg) throw new Error('No tip found in that transaction.');
    seenTx.add(tx); if (seenTx.size > 5000) seenTx.delete(seenTx.values().next().value);
    return BigInt(lg.data).toString();
  }

  return {
    mode, address, items: ITEMS, byId: BY_ID, SLOTS, EXTRA_CAP, EVENT_MS, CHOG_TOKEN, info: () => ({ mode, address }),
    owned, ownedSync, qty, invalidate, may, ownsFn, mockBuy, equip, worn, budget, available,
    startEvent, activeEvents, eventFor, sweepEvents, dropEvent, verifyTip,
    cameraAllowed: (addr, tier) => may(addr, itemOfUse('camera').id, tier),
    snapshot: (addr, tier) => ({ mode, address, owned: ownedSync(addr), equip: worn(addr, tier), events: { event: available(addr, 'event', tier), mega: available(addr, 'mega', tier) }, camera: itemOfUse('camera') ? may(addr, itemOfUse('camera').id, tier) : false, budget: budget(addr, tier) }),
  };
}
module.exports = { open, ITEMS, BY_ID, SLOTS, EXTRA_CAP, CHOG_TOKEN, TIP_TOPIC };
