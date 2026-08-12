#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the Gestão de Condomínio monorepo.
# Safe to run repeatedly and against cached/snapshotted state.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUN_VERSION="1.3.5"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

link_bun_globally() {
  # Make bun/bunx resolvable from non-login shells (terminals, start).
  for bin in bun bunx; do
    if [ -x "$BUN_INSTALL/bin/$bin" ]; then
      if [ -w /usr/local/bin ]; then
        ln -sf "$BUN_INSTALL/bin/$bin" "/usr/local/bin/$bin"
      elif command -v sudo >/dev/null 2>&1; then
        sudo ln -sf "$BUN_INSTALL/bin/$bin" "/usr/local/bin/$bin" || true
      fi
    fi
  done
}

echo "==> Ensuring Bun $BUN_VERSION is installed"
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null)" != "$BUN_VERSION" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
fi
link_bun_globally
echo "    bun $(bun --version)"

echo "==> Installing workspace dependencies (bun install --frozen-lockfile)"
bun install --frozen-lockfile

echo "==> Ensuring root .env exists for local development"
if [ ! -f .env ]; then
  cp .env.template .env
  SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  node - "$SECRET" <<'NODE'
const fs = require("fs");
const secret = process.argv[2];
let s = fs.readFileSync(".env", "utf8");
s = s.replace(/^NODE_ENV=.*/m, "NODE_ENV=development");
s = s.replace(/^WEBSITE_URL=.*/m, "WEBSITE_URL=http://localhost:4200");
s = s.replace(/^BETTER_AUTH_SECRET=.*/m, `BETTER_AUTH_SECRET=${secret}`);
s = s.replace(/^DATABASE_URL=.*/m, "DATABASE_URL=file:./local.db");
s = s.replace(/^DATABASE_AUTH_TOKEN=.*/m, "DATABASE_AUTH_TOKEN=");
fs.writeFileSync(".env", s);
NODE
  echo "    created .env (local SQLite + generated auth secret)"
else
  echo "    .env already present, leaving it untouched"
fi

echo "==> Seeding local SQLite database (idempotent)"
( cd packages/web && bun run scripts/setup-local-db.ts )

echo "==> Bootstrap complete"
