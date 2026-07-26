FROM node:20-slim

RUN apt-get update && apt-get install -y \
  chromium \
  fonts-freefont-ttf \
  ca-certificates \
  --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV WA_ENGINE=baileys
# OUTGOING_CONNECTED_SETTLE_MS is intentionally unset so the Baileys worker
# uses its 3-second default.
ENV OUTGOING_STALE_JOB_MAX_AGE_MS=600000
# Store-scanner browser fallback only; the WhatsApp runtime is Baileys-only.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package*.json ./
RUN npm install --production --no-audit --no-fund

COPY . .

EXPOSE 3000
CMD ["npm", "run", "start:all"]
