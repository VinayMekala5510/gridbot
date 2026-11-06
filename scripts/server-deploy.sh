#!/usr/bin/env bash
# Runs ON the server (called by scripts/deploy.ps1 after `git pull`).
# Installs dependencies, builds, and restarts the gridbot process with pm2.
set -euo pipefail
cd "$(dirname "$0")/.."

# First deploy: create the encryption key for saved exchange accounts.
touch .env && chmod 600 .env
if ! grep -q '^MASTER_KEY=[0-9a-f]\{64\}$' .env; then
  sed -i '/^MASTER_KEY=/d' .env
  echo "MASTER_KEY=$(openssl rand -hex 32)" >> .env
  echo "Generated MASTER_KEY in .env (back it up: without it saved accounts cannot be decrypted)"
fi
grep -q '^HOST=' .env || echo "HOST=127.0.0.1" >> .env
grep -q '^PORT=' .env || echo "PORT=3000" >> .env

echo "→ Installing dependencies"
npm ci --no-audit --no-fund --loglevel=error

echo "→ Building dashboard"
NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=900 npx next build > /tmp/gridbot-build.log 2>&1 \
  || { tail -40 /tmp/gridbot-build.log; exit 1; }

echo "→ Restarting (running bots suspend and resume from MySQL)"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save > /dev/null

for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health > /dev/null 2>&1; then
    echo "✓ Healthy: $(curl -fsS http://127.0.0.1:3000/api/health)"
    echo "✓ Deployed $(git log --oneline -1)"
    exit 0
  fi
  sleep 1
done
echo "✗ Server did not become healthy. Recent logs:"
pm2 logs gridbot --lines 40 --nostream
exit 1
