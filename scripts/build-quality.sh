#!/bin/sh
set -eu

# Legacy Docker only reads the root ignore file. Restore it after validation.
backup=$(mktemp)
cp .dockerignore "$backup"
trap 'cp "$backup" .dockerignore; rm -f "$backup"' EXIT
cp Dockerfile.quality.dockerignore .dockerignore
docker build -f Dockerfile.quality .
