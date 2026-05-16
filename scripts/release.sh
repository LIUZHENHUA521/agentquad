#!/usr/bin/env bash
set -euo pipefail

LEVEL="${1:-patch}"
case "$LEVEL" in
  patch|minor|major) ;;
  *)
    echo "usage: npm run release[:patch|:minor|:major]"
    echo "  got level: $LEVEL"
    exit 1
    ;;
esac

if ! git diff-index --quiet HEAD --; then
  echo "❌ Working tree not clean. Commit or stash first."
  git status --short
  exit 1
fi

BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "❌ Must release from main (currently on '$BRANCH')."
  exit 1
fi

git pull --ff-only origin main

OLD=$(node -p 'require("./package.json").version')
npm version "$LEVEL" -m "release: bump version to %s"
NEW=$(node -p 'require("./package.json").version')

git push origin main --follow-tags

# prepack auto-runs ensure-web-deps + build:web, so the tarball is fresh.
npm publish

echo ""
echo "✅ Released agentquad $OLD → $NEW"
echo "   npm:    https://www.npmjs.com/package/agentquad/v/$NEW"
echo "   verify: npx agentquad@$NEW doctor"
