#!/usr/bin/env bash
# Zero-downtime-on-failure deploy, run ON the VPS from the GitHub Action.
#
# The live app (pm2 "hotelier-server", cwd ~/NODE-HOTELIER, dist/server.js) is NEVER touched until a
# complete new build already exists: install, prisma generate and the TypeScript build all happen in
# a separate staging checkout. If anything fails there, the script exits and the old code keeps
# serving. Only after everything succeeds are node_modules + dist swapped in and pm2 restarted; if the
# new process then fails its health check, the previous node_modules + dist are put back automatically.
#
# A lock makes deploys wait for each other, so two pushes (e.g. to two remotes) can never run npm/git
# in the same folder at once - that race is what corrupted node_modules before.
#
# DEPLOY_DRY_RUN=1 runs everything up to and including the build, then stops (no migrate, no swap).
set -euo pipefail

APP="$HOME/NODE-HOTELIER"
STAGE="$HOME/NODE-HOTELIER-stage"
PREV_MODULES="$HOME/NODE-HOTELIER-node_modules.prev"
PREV_DIST="$HOME/NODE-HOTELIER-dist.prev"
PM2_NAME="hotelier-server"

# The workflow already holds the lock while it fetches, so it sets HOTELIER_DEPLOY_LOCKED; a manual run takes it here.
if [ "${HOTELIER_DEPLOY_LOCKED:-0}" != "1" ]; then
  exec 9>"$HOME/.hotelier-deploy.lock"
  flock -w 1500 9 || { echo "Another deploy is still running after 25 minutes - giving up"; exit 1; }
fi

# rm -rf can hit ENOTEMPTY on this host; if it does, move the folder out of the way instead.
discard() {
  [ -e "$1" ] || return 0
  rm -rf "$1" 2>/dev/null || true
  if [ -e "$1" ]; then mv "$1" "$1.trash-$(date +%s)" 2>/dev/null || true; fi
}

cd "$APP"
git update-ref -d refs/remotes/origin/main || true
git fetch --prune --force origin +refs/heads/main:refs/remotes/origin/main
SHA="$(git rev-parse origin/main)"
echo "==> Deploying $SHA"

echo "==> Building in staging (live app untouched)"
discard "$STAGE"
git clone --quiet --no-checkout "$APP" "$STAGE"
git -C "$STAGE" checkout --quiet "$SHA"
cp "$APP/.env" "$STAGE/.env"
cd "$STAGE"
npm ci --no-audit --no-fund
npx prisma generate
npm run build
test -f dist/server.js || { echo "Build produced no dist/server.js"; exit 1; }

if [ "${DEPLOY_DRY_RUN:-0}" = "1" ]; then
  echo "==> Dry run OK (build succeeded). Skipping migrate and swap."
  cd "$HOME"; discard "$STAGE"
  exit 0
fi

echo "==> Applying database migrations"
npx prisma migrate deploy

echo "==> Swapping in the new build"
PORT_NUM="$(grep -E '^PORT=' "$APP/.env" | tail -1 | cut -d= -f2 | tr -d '\"[:space:]' || true)"
PORT_NUM="${PORT_NUM:-4000}"
cd "$APP"
discard "$PREV_MODULES"; discard "$PREV_DIST"
[ -d "$APP/node_modules" ] && mv "$APP/node_modules" "$PREV_MODULES"
[ -d "$APP/dist" ] && mv "$APP/dist" "$PREV_DIST"
mv "$STAGE/node_modules" "$APP/node_modules"
mv "$STAGE/dist" "$APP/dist"
git reset --hard "$SHA" --quiet

restore_previous() {
  echo "!! New build failed its health check - restoring the previous version"
  discard "$APP/node_modules.failed"; discard "$APP/dist.failed"
  [ -d "$APP/node_modules" ] && mv "$APP/node_modules" "$APP/node_modules.failed"
  [ -d "$APP/dist" ] && mv "$APP/dist" "$APP/dist.failed"
  [ -d "$PREV_MODULES" ] && mv "$PREV_MODULES" "$APP/node_modules"
  [ -d "$PREV_DIST" ] && mv "$PREV_DIST" "$APP/dist"
  pm2 restart "$PM2_NAME" --update-env || true
}

pm2 restart "$PM2_NAME" --update-env
healthy=0
for _ in $(seq 1 30); do
  sleep 2
  if curl -fsS -m 3 "http://localhost:${PORT_NUM}/api/health" >/dev/null 2>&1; then healthy=1; break; fi
done
if [ "$healthy" != "1" ]; then restore_previous; exit 1; fi

echo "==> Healthy on port ${PORT_NUM}. Deploy of $SHA complete."
cd "$HOME"; discard "$STAGE"
