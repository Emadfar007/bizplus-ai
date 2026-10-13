FROM node:24.19.0-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && chmod -R a+rx /ms-playwright
COPY src ./src
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=10000 OBSERVER_DATABASE_PATH=/app/data/observer.sqlite OBSERVER_HISTORY_POLICY=temporary
EXPOSE 10000
CMD ["node", "src/server.mjs"]
