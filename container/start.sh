#!/bin/sh
# Container entrypoint: the bgutil PO-token provider (needed to keep YouTube happy)
# runs on loopback, then the clip service takes the foreground.
set -eu

node /app/build/main.js &
POT_PID=$!

# Wait for the provider to answer /ping (max ~10s); tokens are optional, so don't fail hard.
i=0
while [ "$i" -lt 30 ]; do
  if node -e "fetch('http://127.0.0.1:4416/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "pot provider ready"
    break
  fi
  i=$((i + 1))
  sleep 0.3
done

trap 'kill "$POT_PID" 2>/dev/null || true' INT TERM

exec node /srv/service.mjs
