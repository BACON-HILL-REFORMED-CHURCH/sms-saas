# ============================================================
# Dockerfile — Telegram Bot
# ============================================================

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Copy static Mini App files to dist/public
RUN cp -r src/public dist/public 2>/dev/null || true

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
