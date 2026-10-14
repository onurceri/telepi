#!/bin/sh
# One command from a checkout: ./install.sh
# Checks the two things the telepi CLI cannot check for itself (Node and pnpm, which it runs on), then installs the
# dependencies and runs `telepi setup`, which checks and prepares everything else.
set -u
cd "$(dirname "$0")" || exit 1

fail() {
  printf '\ntelepi: %s\n  -> %s\n\nNothing was changed. Fix it and run ./install.sh again.\n' "$1" "$2" >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  if [ "$(uname)" = Darwin ] && command -v brew >/dev/null 2>&1; then fix='`brew install node`, or with nvm: `nvm install 22`'
  else fix='with nvm: `nvm install 22` (https://github.com/nvm-sh/nvm), or the installer at https://nodejs.org'; fi
  fail "Node is not installed (telepi needs Node 22 or newer)." "$fix"
fi
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || fail "Node $(node -v) is too old (22 or newer needed)." 'with nvm: `nvm install 22`, or the installer at https://nodejs.org'

if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm is not installed." '`corepack enable pnpm` (corepack ships with Node), or `npm install -g pnpm`'
fi

echo "Installing dependencies (pnpm install) ..."
pnpm install --frozen-lockfile || fail "pnpm install failed (see above)." "check your network, then run ./install.sh again"
exec node scripts/telepi.mjs setup "$@"
