# Build context is the repository root. Do not deploy this image in
# Assignment 1. See README.md in this directory.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
ENV NODE_ENV=production
ENV CHIEF_SUPERVISOR_MODE=embedded
ENV CHIEF_SUPERVISOR_LISTEN=1
CMD ["node", "scripts/chief-managed-supervisor.mjs"]
