#!/usr/bin/env bash
# Túnel HTTPS para testes no iPad (Cloudflare quick tunnel).
# A URL trycloudflare muda a cada sessão: actualiza WEBSITE_URL no .env e reinicia bun run dev.
set -euo pipefail

PORT=4200
CLOUDFLARED="${CLOUDFLARED:-}"
if [[ -z "$CLOUDFLARED" ]]; then
  if command -v cloudflared >/dev/null 2>&1; then
    CLOUDFLARED="$(command -v cloudflared)"
  elif [[ -x "$HOME/bin/cloudflared" ]]; then
    CLOUDFLARED="$HOME/bin/cloudflared"
  elif [[ -x "$HOME/.local/bin/cloudflared" ]]; then
    CLOUDFLARED="$HOME/.local/bin/cloudflared"
  else
    echo "cloudflared não encontrado. Instala o binário linux-amd64 ou define CLOUDFLARED=/caminho/completo" >&2
    exit 1
  fi
fi

echo "Lembra-te:"
echo "  1. bun run dev já a correr na porta ${PORT} (noutro terminal)"
echo "  2. Copia o https://....trycloudflare.com que o cloudflared imprimir"
echo "  3. No .env da raiz: WEBSITE_URL=<essa URL>"
echo "  4. Reinicia bun run dev"
echo "  5. iPad: hotspot do portátil + abre o mesmo URL https"
echo ""
echo "A iniciar túnel: $CLOUDFLARED tunnel --url http://localhost:${PORT}"
exec "$CLOUDFLARED" tunnel --url "http://localhost:${PORT}"
