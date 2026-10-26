# 1) build the dashboard  2) run the Node server, which serves the dashboard + API on port 4000
FROM node:22-alpine AS dashboard
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/ ./
RUN npm run build

# the Chrome extension as customers download it (same build as the Chrome Web Store ZIP) — always the latest
FROM python:3.12-alpine AS extension
WORKDIR /src
COPY extension ./extension
COPY scripts/build-extension.sh ./scripts/
RUN sh scripts/build-extension.sh https://specter.monster && mkdir -p /out && cp dist/*.zip /out/fb-lead-finder-extension.zip

FROM node:22-alpine
RUN apk add --no-cache tzdata
ENV NODE_ENV=production TZ=Asia/Dhaka PORT=4000
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/src ./src
COPY apps-script/Code.gs /app/apps-script/Code.gs
COPY extension/manifest.json /app/extension/manifest.json
COPY --from=dashboard /app/dashboard/dist /app/dashboard/dist
COPY --from=extension /out/ /app/dashboard/dist/downloads/
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/api/health >/dev/null || exit 1
CMD ["node", "src/index.js"]
