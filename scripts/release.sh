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

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" && "$BRANCH" != "master" ]]; then
  echo "Switch to main/master before releasing (on $BRANCH)."
  exit 1
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists locally."
  exit 1
fi

if git ls-remote --tags origin "refs/tags/$TAG" | grep -q "$TAG"; then
  echo "Tag $TAG already exists on origin."
  exit 1
fi

# Allow dirty tree only for the version files we're about to rewrite.
DIRTY="$(git status --porcelain | grep -vE ' (package\.json|package-lock\.json|src-tauri/tauri\.conf\.json|src-tauri/Cargo\.toml|src-tauri/Cargo\.lock|snapcraft\.yaml)$' || true)"
if [[ -n "$DIRTY" ]]; then
  echo "Working tree has unrelated changes. Commit or stash them first:"
  echo "$DIRTY"
  exit 1
fi

echo "→ Syncing version files to $VERSION"
node scripts/version.mjs set "$VERSION"

git add \
  package.json \
  package-lock.json \
  src-tauri/tauri.conf.json \
  src-tauri/Cargo.toml \
  src-tauri/Cargo.lock \
  snapcraft.yaml

if ! git diff --cached --quiet; then
  echo "→ Committing version bump"
  git commit -m "Bump version to $VERSION"
else
  echo "→ Version files already at $VERSION (nothing to commit)"
fi

echo "→ Creating tag $TAG"
git tag "$TAG"

echo "→ Pushing $BRANCH and $TAG"
git push origin "$BRANCH" "$TAG"

echo
echo "Done. Release workflow should start for $TAG"
echo "Watch: https://github.com/gabojkz/meme-factory/actions"
