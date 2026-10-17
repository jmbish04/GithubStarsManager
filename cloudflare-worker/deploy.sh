#!/usr/bin/env bash
# ==============================================================================
# GitHub Stars Manager — Cloudflare Worker Vector Search Deploy Launcher (macOS / Linux)
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
    echo "❌ Node.js is required (>= 18.0.0). Please install Node.js first."
    exit 1
fi

node deploy.mjs "$@"
