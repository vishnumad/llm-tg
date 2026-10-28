FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM oven/bun:1-alpine
RUN apk add --no-cache chromium
ENV NODE_ENV=production PERCHANCE_CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p data && chown bun:bun data
USER bun
CMD ["bun", "src/index.ts"]
