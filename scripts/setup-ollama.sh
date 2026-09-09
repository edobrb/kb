#!/usr/bin/env bash
# Pulls the models used by ai-wiki RAG. Override with EMBEDDING_MODEL / CHAT_MODEL env vars or .env.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
EMBEDDING_MODEL="${EMBEDDING_MODEL:-qwen3-embedding:0.6b}"
CHAT_MODEL="${CHAT_MODEL:-qwen3:8b}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama is not installed. Get it from https://ollama.com/download and re-run." >&2
  exit 1
fi
if ! curl -sf "${OLLAMA_HOST:-http://127.0.0.1:11434}/api/tags" >/dev/null; then
  echo "Ollama is not running. Start it with 'ollama serve' (or open the Ollama app) and re-run." >&2
  exit 1
fi

echo "Pulling embedding model: $EMBEDDING_MODEL"
ollama pull "$EMBEDDING_MODEL"
echo "Pulling chat model: $CHAT_MODEL"
ollama pull "$CHAT_MODEL"
echo
echo "Done. Next: npm run doctor && npm run ingest"
