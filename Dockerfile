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
ENV WA_SESSION_DIR=/tmp/raddi-wa-sessions
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package*.json ./
RUN npm install --production --no-audit --no-fund

COPY . .

EXPOSE 3000
CMD ["npm", "run", "start:all"]
