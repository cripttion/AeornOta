#!/usr/bin/env bash
# Kept for older instructions. The setup is now one cross-platform command: npm run setup
exec node "$(cd "$(dirname "$0")" && pwd)/setup.mjs" "$@"
