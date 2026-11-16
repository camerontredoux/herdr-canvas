#!/usr/bin/env bash
# Copies the live mod from Herdr's folder into this repo's mods/canvas, so you can commit it.
# Leaves out the files Herdr writes there for editor type checking.
set -euo pipefail
src="${HERDR_HOME:-$HOME/.config/herdr-app}/mods/canvas/"
dst="$(cd "$(dirname "$0")" && pwd)/mods/canvas/"
rsync -a --delete --exclude gpui-kit.d.ts --exclude jsconfig.json --exclude '*.error' --exclude '.*' "$src" "$dst"
git -C "$dst" status --short -- .
