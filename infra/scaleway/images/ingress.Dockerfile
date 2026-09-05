FROM node:24-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.ingress.json ./
RUN npm ci
COPY src/hosted/task.ts ./src/hosted/task.ts
COPY src/hosted/ingress ./src/hosted/ingress
RUN npm exec -- tsc --project tsconfig.ingress.json

FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/dist ./dist

USER node
CMD ["node", "dist/hosted/ingress/webhook-server.js"]
