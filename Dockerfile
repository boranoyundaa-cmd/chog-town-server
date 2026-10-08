FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js filter.js ./
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production PORT=8767
EXPOSE 8767
USER node
CMD ["node", "index.js"]
