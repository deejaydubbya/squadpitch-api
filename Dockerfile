FROM node:20-slim AS base
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY prisma ./prisma/
RUN npx prisma generate

COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
