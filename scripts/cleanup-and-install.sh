#!/usr/bin/env bash
set -euo pipefail

JSADDONS_DIR="$HOME/Library/Application Support/Kingsoft/wps/jsaddons"

# Clean up any previous broken install
if [ -d "$JSADDONS_DIR" ]; then
  rm -rf "$JSADDONS_DIR"
  echo "Cleaned old jsaddons directory."
fi

# Kill any existing relay
lsof -ti:3888 2>/dev/null | xargs kill -9 2>/dev/null || true

# Run the install script
cd "$(dirname "$0")/.."
bash server/install-local-addon.sh

echo ""
echo "=== Done ==="
echo "Verify relay:"
sleep 1
curl -sS http://127.0.0.1:3888/health
echo ""
