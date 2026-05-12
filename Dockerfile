FROM node:20-bookworm-slim

# Runtime libraries required by Chrome for Testing in headless Linux.
RUN apt-get update && apt-get install -y \
  ca-certificates \
  fonts-freefont-ttf \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnss3 \
  libpango-1.0-0 \
  libx11-6 \
  libxcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  wget \
  xdg-utils \
  --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
ENV WA_ENGINE=baileys
ENV WA_USE_PUPPETEER_BUNDLED=true

COPY package*.json ./
RUN npm install --production --no-audit --no-fund \
  && npx puppeteer browsers install chrome --install-deps

COPY . .

EXPOSE 3000
CMD ["npm", "run", "start:all"]
