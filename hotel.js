'use strict';
// The Chog Hotel's list of venues (docs/game/world.md). v0: the venues the game itself puts in the hotel (seed_venues.json, built by tools/build_seed_venues.js).
// Holder venues will join the same list with an owner and a tier. A venue is a room document plus where its door is: number = floor * 100 + slot (slot 1..8).
const seeds = require('./seed_venues.json');

const venues = seeds.map(v => ({ ...v }));
const byId = new Map(venues.map(v => [v.id, v]));

module.exports = {
  get: id => byId.get(id) || null,
  floors: () => venues.reduce((n, v) => Math.max(n, v.floor), 0),
  // the public list: everything but the room document (visitors get that when they walk in)
  list: () => venues.map(({ id, no, floor, name, cat, desc, by }) => ({ id, no, floor, name, cat, desc, by })),
};
