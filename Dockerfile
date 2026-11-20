FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
# better-sqlite3 uses a prebuilt binary when one's published; the build
# tools are a fallback for source compiles (removed in the same layer).
# ffmpeg powers server-side frame extraction; the npm ffmpeg-static
# bundle is glibc-only, so the real package is the one that works here.
RUN apk add --no-cache su-exec ffmpeg \
 && apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && apk del .build-deps
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/
# Persistent state — player registry, playlists, media library, staged
# uploads. Mount a volume or bind-mount to keep it across rebuilds.
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
