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
ENV WA_ENGINE=whatsapp-web
ENV WA_WEB_VERSION_CACHE=local
ENV WA_SESSION_BACKUP_DELAY_MS=30000
ENV OUTGOING_CONNECTED_SETTLE_MS=20000
ENV OUTGOING_STALE_JOB_MAX_AGE_MS=600000
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package*.json ./
RUN npm install --production --no-audit --no-fund

COPY . .

EXPOSE 3000
CMD ["npm", "run", "start:all"]
