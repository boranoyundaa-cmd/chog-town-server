'use strict';
// Venue license: which Chogs a wallet holds and the venue tier that gives (docs/game/design.md). The points table comes from the collection's own
// Tier trait (tools/build_license_data.py -> license_data.json); ownership is always checked on chain. The owner snapshot only says which tokens to check first;
// if the wallet holds more than the snapshot knows (bought since), the whole collection is scanned once. Results are cached for ten minutes.
const DATA = require('./license_data.json');
const TTL = 10 * 60e3;

function open(chain) {                       // chain: { balanceOf(addr) -> n, ownersOf(ids[]) -> [addr|null] }
  const cache = new Map(), busy = new Map();
  const tierFor = points => { let t = 0; for (const v of DATA.venueTiers) if (points >= v.min) t = v.tier; return t; };
  async function lookup(addr) {
    const bal = await chain.balanceOf(addr), found = [];
    if (bal > 0) {
      const cand = Object.entries(DATA.owners).filter(([, o]) => o === addr).map(([id]) => +id);
      const own = await chain.ownersOf(cand); cand.forEach((id, i) => { if (own[i] === addr) found.push(id); });
      for (let start = 1; found.length < bal && start <= DATA.supply; start += 100) {            // the snapshot is stale: scan the rest
        const ids = []; for (let i = start; i < Math.min(start + 100, DATA.supply + 1); i++) if (!found.includes(i) && !cand.includes(i)) ids.push(i);
        const o = await chain.ownersOf(ids); ids.forEach((id, i) => { if (o[i] === addr) found.push(id); });
      }
    }
    const points = found.reduce((s, id) => s + (DATA.points[id] || 0), 0);
    return { tokens: found.sort((a, b) => a - b), points, tier: tierFor(points), at: Date.now() };
  }
  return {
    tierFor, pointsOf: id => DATA.points[id] || 0,
    // the wallet's license (cached; fresh = skip the cache, used when the owner acts on it)
    get(addr, fresh = false) {
      const c = cache.get(addr); if (c && !fresh && Date.now() - c.at < TTL) return Promise.resolve(c);
      if (busy.has(addr)) return busy.get(addr);
      const pr = lookup(addr).then(r => { cache.set(addr, r); return r; }).finally(() => busy.delete(addr)); busy.set(addr, pr); return pr;
    },
  };
}
module.exports = { open, DATA };
