'use strict';
// Chat cleanup. There is deliberately NO word/profanity filter (owner decision, 2026-10-08): the audience is adult and crypto-native.
// What is removed is only what is dangerous in a crypto game: links (phishing, fake mints) and wallet addresses, plus control characters.
const URL_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|io|xyz|gg|app|net|org|me|co|link|ly|finance|top)\b\S*|discord\.gg\S*|t\.me\/\S*/gi;
const ADDR_RE = /0x[a-fA-F0-9]{40}/g;

// returns { text, changed }: the cleaned message, and whether anything was removed
function clean(raw) {
  let changed = false;
  let t = String(raw).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(URL_RE, () => { changed = true; return '[link removed]'; });
  t = t.replace(ADDR_RE, () => { changed = true; return '[address removed]'; });
  return { text: t, changed };
}

module.exports = { clean };
