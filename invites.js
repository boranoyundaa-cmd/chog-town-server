'use strict';
// Invitations to a Home (docs/game/world.md). A Home is private: only its owner and people they invited can enter.
// Two kinds: a direct invitation to one connected player (kept in memory on that player, index.js) and a share link:
// one random token per owner, valid for a week, replaced on renew (which revokes the old link). Links are stored in DATA_DIR/invites.json.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LINK_MS = 7 * 24 * 3600e3, DIRECT_MS = 30 * 60e3;

function open(dataDir) {
  const file = path.join(dataDir, 'invites.json');
  let links = {};                                                       // token -> { owner, exp }
  try { links = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { /* none yet */ }
  const save = () => { try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(links)); fs.renameSync(tmp, file); } catch (e) { /* the link still works until a restart */ } };
  const prune = now => { let n = 0; for (const [k, l] of Object.entries(links)) if (l.exp <= now) { delete links[k]; n++; } return n; };
  return {
    // the owner's current link, or a new one (renew = true replaces and so revokes the old one)
    link(owner, renew = false, now = Date.now()) {
      prune(now);
      const have = Object.entries(links).find(([, l]) => l.owner === owner);
      if (have && !renew) return { token: have[0], exp: have[1].exp };
      for (const [k, l] of Object.entries(links)) if (l.owner === owner) delete links[k];
      const token = crypto.randomBytes(12).toString('hex'); links[token] = { owner, exp: now + LINK_MS }; save();
      return { token, exp: links[token].exp };
    },
    check(token, owner, now = Date.now()) { const l = typeof token === 'string' ? links[token] : null; return !!l && l.owner === owner && l.exp > now; },
  };
}

module.exports = { open, LINK_MS, DIRECT_MS };
