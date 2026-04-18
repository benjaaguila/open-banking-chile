# Stage 1: Build TypeScript
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsup.config.ts ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production image
FROM node:20-slim

# Install Chromium, Xvfb (for BancoEstado headful), and fonts
RUN apt-get update && apt-get install -y \
    chromium \
    xvfb \
    fonts-liberation \
    fonts-noto \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV DISPLAY=:99
ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist/ ./dist/

EXPOSE 8080

CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset & sleep 1 && node dist/server.js"]
