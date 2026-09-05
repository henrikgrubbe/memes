FROM node:24-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.worker.json ./
RUN npm ci
COPY src/shared ./src/shared
COPY src/hosted/task.ts ./src/hosted/task.ts
COPY src/hosted/worker ./src/hosted/worker
RUN npm exec -- tsc --project tsconfig.worker.json

FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/dist ./dist

USER node
CMD ["node", "dist/hosted/worker/worker-server.js"]
