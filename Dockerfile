FROM node:20-slim

# chromium من apt يجلب كل dependencies تلقائياً — لا داعي لتعداد المكتبات يدوياً
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-freefont-ttf \
  ca-certificates \
  --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# أخبر Puppeteer يستخدم chromium المثبّت — هذا هو المسار الفعلي على Debian
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm install --production --no-audit --no-fund
COPY . .

EXPOSE 3000
CMD ["npm", "run", "start:web"]
