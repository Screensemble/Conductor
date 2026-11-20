#!/bin/sh
# Volumes created by older (root-run) images are root-owned — fix ownership,
# then drop to the unprivileged node user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data
  exec su-exec node "$@"
fi
exec "$@"
