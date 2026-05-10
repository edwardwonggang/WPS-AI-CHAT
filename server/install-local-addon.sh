#!/usr/bin/env bash
# Install the built add-in into the macOS WPS jsaddons folder and launch the
# local relay in the background. Mirrors install-local-addon.ps1 for macOS.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_JSON="$PROJECT_ROOT/package.json"
BUILD_DIR="$PROJECT_ROOT/dist"

if [[ ! -f "$PACKAGE_JSON" ]]; then
  echo "package.json not found." >&2
  exit 1
fi

if [[ ! -d "$BUILD_DIR" ]]; then
  echo "dist not found. Run 'npm run build' first." >&2
  exit 1
fi

# Parse package.json for addon metadata using python3 (available on macOS).
read_pkg_field() {
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get(sys.argv[2],''))" "$PACKAGE_JSON" "$1"
}

ADDON_NAME=$(read_pkg_field name)
ADDON_TYPE=$(read_pkg_field addonType)
ADDON_VERSION=$(read_pkg_field version)
OFFLINE_FOLDER_NAME="${ADDON_NAME}_${ADDON_VERSION}"

# WPS on macOS stores js add-ins under the user's application support directory.
# The layout mirrors Windows %APPDATA%/kingsoft/wps/jsaddons.
ADDON_ROOT="$HOME/Library/Application Support/Kingsoft/wps/jsaddons"
OFFLINE_TARGET="$ADDON_ROOT/$OFFLINE_FOLDER_NAME"
PUBLISH_XML="$ADDON_ROOT/publish.xml"

mkdir -p "$ADDON_ROOT"

# Clean out any previous installation of this add-in.
shopt -s nullglob
for existing in "$ADDON_ROOT/${ADDON_NAME}_"*; do
  if [[ -d "$existing" ]]; then
    rm -rf "$existing"
  fi
done
shopt -u nullglob

cp -R "$BUILD_DIR" "$OFFLINE_TARGET"

# Rewrite publish.xml so WPS picks up the new add-in.
if [[ ! -f "$PUBLISH_XML" ]]; then
  cat > "$PUBLISH_XML" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<jsplugins>
</jsplugins>
EOF
fi

# Use python3 (available on macOS by default) to edit the XML safely.
python3 - "$PUBLISH_XML" "$ADDON_NAME" "$ADDON_TYPE" "$OFFLINE_FOLDER_NAME" "$ADDON_VERSION" <<'PYEOF'
import sys
import xml.etree.ElementTree as ET

publish_path, addon_name, addon_type, folder_name, version = sys.argv[1:6]

try:
    tree = ET.parse(publish_path)
    root = tree.getroot()
except ET.ParseError:
    root = ET.Element("jsplugins")
    tree = ET.ElementTree(root)

if root.tag != "jsplugins":
    root = ET.Element("jsplugins")
    tree = ET.ElementTree(root)

# Remove previous entries for this add-in
for child in list(root):
    if child.get("name") == addon_name:
        root.remove(child)

plugin = ET.SubElement(root, "jsplugin")
plugin.set("name", addon_name)
plugin.set("type", addon_type)
plugin.set("url", folder_name)
plugin.set("version", version)
plugin.set("enable", "enable_dev")
plugin.set("install", "null")
plugin.set("customDomain", "")

tree.write(publish_path, encoding="UTF-8", xml_declaration=True)
PYEOF

echo "Installed add-in to: $OFFLINE_TARGET"
echo "Updated publish.xml:  $PUBLISH_XML"

# Start the relay in the background if it's not already running.
RELAY_SCRIPT="$SCRIPT_DIR/relay.mjs"
RELAY_PORT=3888

if lsof -iTCP:$RELAY_PORT -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Relay already running on port $RELAY_PORT."
else
  LOG_DIR="$HOME/Library/Logs/WPS AI"
  mkdir -p "$LOG_DIR"
  nohup node "$RELAY_SCRIPT" >> "$LOG_DIR/relay.log" 2>&1 &
  disown || true
  echo "Started relay in background. Logs: $LOG_DIR/relay.log"
fi

# Register launchd agent so the relay starts on login.
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LAUNCHD_PLIST="$LAUNCH_AGENTS_DIR/com.wps-ai.relay.plist"
NODE_BIN=$(command -v node)

if [[ -n "$NODE_BIN" ]]; then
  mkdir -p "$LAUNCH_AGENTS_DIR"
  cat > "$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.wps-ai.relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$RELAY_SCRIPT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/WPS AI/relay.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/WPS AI/relay.err.log</string>
</dict>
</plist>
EOF
  echo "Registered launchd agent at $LAUNCHD_PLIST"
  echo "Run 'launchctl load $LAUNCHD_PLIST' to enable auto-start on login."
fi
