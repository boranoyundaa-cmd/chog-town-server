FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js filter.js rooms.js invites.js hotel.js license.js users.js games.js exhibition.js shop.js shop_items.json room_catalog.json seed_venues.json license_data.json ./
RUN apk add --no-cache su-exec && mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production PORT=8767
EXPOSE 8767
# the Fly volume is mounted at /data owned by root: fix its owner, then drop to the unprivileged user
CMD ["sh", "-c", "chown -R node:node /data 2>/dev/null; exec su-exec node node index.js"]
