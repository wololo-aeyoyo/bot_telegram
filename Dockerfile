FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install deps first so this layer caches across source-only changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Drop root — the bot needs no privileges, no writable files, no ports
USER node

CMD ["node", "src/index.js"]
