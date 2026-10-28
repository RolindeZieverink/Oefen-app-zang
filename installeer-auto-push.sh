#!/bin/bash
# Eenmalig uitvoeren: bash installeer-auto-push.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/nl.naklank.autopush.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>nl.naklank.autopush</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/auto-push.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>/tmp/naklank-autopush.log</string>
  <key>StandardOutPath</key><string>/tmp/naklank-autopush.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST" && echo "Klaar: wijzigingen worden nu elke minuut automatisch gepusht."
