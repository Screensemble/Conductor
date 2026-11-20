FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# Persistent state — player registry, playlists, media library, staged
# uploads. Mount a volume or bind-mount to keep it across rebuilds.
VOLUME ["/app/data"]
EXPOSE 8080
CMD ["node", "src/index.js"]
