# Silver Demo bot — simple Node image. Railway is set to the Dockerfile builder
# and looks for silver-bot/Dockerfile, so this satisfies it directly (no need to
# change Railway's builder setting).
FROM node:20-slim

WORKDIR /app

# Install production dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY . .

# Long-running worker (cron-driven trader) — no HTTP port needed
CMD ["node", "index.js"]
