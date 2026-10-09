#!/bin/sh
set -eu

version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)"[[:space:]]*,\{0,1\}[[:space:]]*$/\1/p' package.json)
if [ "$(printf '%s\n' "$version" | wc -l)" -ne 1 ] || ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "package.json must declare a stable SemVer version (major.minor.patch)." >&2
  exit 1
fi
printf '%s\n' "$version"
