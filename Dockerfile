# Job Autopilot — single container: dashboard API + scheduler + headless Chromium.
# Needs a persistent volume mounted at /app/data (database + encrypted files).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY assets ./assets
# Chromium + its system libraries, matching the pinned playwright version
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app/data && chown -R node:node /app /ms-playwright
USER node
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/index.js"]
