#!/usr/bin/env bash
# Bump every version file, commit, tag, and push a release.
# Usage: ./scripts/release.sh 0.3.0
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ $# -ne 1 ]]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 0.3.0"
  exit 1
fi

VERSION="${1#v}"
TAG="v${VERSION}"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  echo "Invalid version: $1"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash changes first."
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" && "$BRANCH" != "master" ]]; then
  echo "Switch to main/master before releasing (on $BRANCH)."
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists."
  exit 1
fi

echo "→ Syncing version files to $VERSION"
node scripts/version.mjs set "$VERSION"

git add \
  package.json \
  package-lock.json \
  src-tauri/tauri.conf.json \
  src-tauri/Cargo.toml \
  src-tauri/Cargo.lock

git commit -m "Bump version to $VERSION"
git tag "$TAG"

echo "→ Pushing $BRANCH and $TAG"
git push origin "$BRANCH" "$TAG"

echo
echo "Done. Release workflow should start for $TAG"
echo "Watch: https://github.com/gabojkz/meme-factory/actions"
