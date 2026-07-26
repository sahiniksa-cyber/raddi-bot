FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
ENV WA_ENGINE=baileys
# OUTGOING_CONNECTED_SETTLE_MS is intentionally unset so the Baileys worker
# uses its 3-second default.
ENV OUTGOING_STALE_JOB_MAX_AGE_MS=600000

COPY package*.json ./
RUN npm install --production --no-audit --no-fund

COPY . .

EXPOSE 3000
CMD ["npm", "run", "start:all"]
