FROM node:20-slim AS base
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY prisma ./prisma/
RUN npx prisma generate

COPY . .

EXPOSE 8080
# --import ./instrument.js initializes Sentry before Express/http are
# loaded so @sentry/node v8 auto-instrumentation can hook the request
# lifecycle. This MUST match the npm start script in package.json.
CMD ["node", "--import", "./instrument.js", "server.js"]
