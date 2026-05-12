FROM node:20-slim

RUN apt-get update && apt-get install -y \
  ca-certificates \
  fonts-freefont-ttf \
  --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV WA_ENGINE=baileys
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package*.json ./
RUN npm install --production --no-audit --no-fund

COPY . .

EXPOSE 3000
CMD ["npm", "run", "start:all"]
