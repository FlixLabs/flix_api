#!/bin/sh
set -eu

if [ "${CI_COMMIT_BRANCH:-}" != "${CI_DEFAULT_BRANCH:-master}" ]; then
  echo "Release tags can only be created on the default branch." >&2
  exit 1
fi

tag="v$(sh scripts/read-version.sh)"
head_commit=$(git rev-parse HEAD)
remote_refs=$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")
if [ -n "$remote_refs" ]; then
  remote_commit=$(printf '%s\n' "$remote_refs" | awk 'NR == 1 { first=$1 } /\^\{\}$/ { peeled=$1 } END { print peeled ? peeled : first }')
  if [ "$remote_commit" != "$head_commit" ]; then
    echo "$tag already releases $remote_commit; bump package.json to release another version."
    exit 0
  fi
  echo "$tag already points to this commit; retrying its pipeline."
else
  if git show-ref --verify --quiet "refs/tags/$tag"; then
    test "$(git rev-list -n 1 "$tag")" = "$head_commit" || {
      echo "Local $tag points to another commit; refusing to overwrite it." >&2
      exit 1
    }
  else
    git -c user.name="Flix Release Bot" -c user.email="release@flix.invalid" \
      -c tag.gpgSign=false tag -a "$tag" -m "Release $tag"
  fi
  git push origin "refs/tags/$tag"
fi

# Job-token pushes do not start a pipeline; trigger the tag pipeline explicitly.
response=$(mktemp)
trap 'rm -f "$response"' EXIT
for delay in 0 2 4 8 16; do
  sleep "$delay"
  status=$(curl -sS -o "$response" -w '%{http_code}' -X POST \
    --form "token=$CI_JOB_TOKEN" --form "ref=$tag" \
    "$CI_API_V4_URL/projects/$CI_PROJECT_ID/trigger/pipeline") || status=000
  if [ "$status" = 201 ]; then
    echo "Triggered the $tag pipeline."
    exit 0
  fi
  echo "Tag pipeline trigger returned HTTP $status; retrying."
done
cat "$response" >&2
echo "Unable to trigger the $tag pipeline." >&2
exit 1
