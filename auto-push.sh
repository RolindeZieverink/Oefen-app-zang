#!/bin/bash
# Zet wijzigingen in deze map automatisch op GitHub. Wordt elke minuut gestart door de installatie hieronder.
cd "$(dirname "$0")" || exit 1
export PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
[ -f .git/index.lock ] && exit 0
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "Automatische update $(date '+%Y-%m-%d %H:%M')"
fi
if [ "$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)" -gt 0 ]; then
  git push -q
fi
