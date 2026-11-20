FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
# better-sqlite3 uses a prebuilt binary when one's published; the build
# tools are a fallback for source compiles (removed in the same layer).
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && apk del .build-deps
COPY src ./src
COPY public ./public
# Persistent state — player registry, playlists, media library, staged
# uploads. Mount a volume or bind-mount to keep it across rebuilds.
VOLUME ["/app/data"]
EXPOSE 8080
CMD ["node", "src/index.js"]
