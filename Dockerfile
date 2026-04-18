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

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built dist
COPY dist/ ./dist/

EXPOSE 8080

# Start Xvfb (needed by BancoEstado forceHeadful) then the server
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset & sleep 1 && node dist/server.js"]
