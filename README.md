# Chog Hotel server

The realtime server of [Chog Hotel](https://github.com/boranoyundaa-cmd/chog-town) (Chogathon 2026): Node + WebSocket, live at `wss://chog-town-ws.fly.dev`.

It carries presence, chat, signed room saves, hotel records (rooms, venues, tiers), the mini-game referee, the Exhibition contest, shop checks against the ChogShop contract on Monad, phone keys and Web Push. Ownership and money stay on-chain; the server holds no funds, and the game still runs solo without it.

```bash
npm install
node index.js      # ws://localhost:8767
npm test           # smoke, venues, migration, units, games, exhibition, phone, shop
```

Protocol and design: `docs/engineering/server.md` in the game repository.
