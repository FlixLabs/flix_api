# flix_api

## Codex Session

Resume the development session:

```sh
codex resume 019d0252-50ae-7110-935a-753841d46961
```

**flix_api** is a lightweight Node.js API designed to complement [flix_webapp](https://github.com/FlixLabs/flix_webapp). While it remains entirely optional, integrating **flix_api** unlocks additional features such as multi-instance management for Radarr and Sonarr, and basic authentication for enhanced security.

---

## Features

- **Multi-Instance Management** for Radarr and Sonarr
- **Authentication** options for enhanced security
- **Color** options for enhanced UI

This project is developed entirely in my free time, and while it is already functional, improvements in **security** and **code factorization** are always welcome. Contributions and feedback are greatly appreciated!

---

## Recommended IDE Setup

[VSCode](https://code.visualstudio.com/) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Project Setup

Use Node.js 24 LTS and Yarn Classic (1.x).

```sh
yarn
```

### Start the API

```sh
yarn start
```

### Storage Agent (Optional)

To measure the actual movie, series and download filesystems, deploy the
[storage agent](storage-agent/README.md) on their host. It uses read-only mounts
and a bearer token, without access to the Docker socket.

### Tests

```sh
yarn test
```

### GitLab Releases

The version in `package.json` is the release source of truth. API and webapp
versions are independent.

- `quality` runs on merge requests, the default branch and stable `vX.Y.Z` tags.
  It runs tests in a dedicated Docker image,
  without production variables or registry authentication.
  The quality script temporarily applies its ignore file at the context root
  for compatibility with both BuildKit and the legacy Docker builder.
- After successful default-branch validation, `create_release_tag` creates an
  annotated `vX.Y.Z` tag and triggers its pipeline. Existing tags are never moved;
  bump `package.json` to release another version.
- Tag pipelines build the production image with the configured variables and
  publish it as `vX.Y.Z` and `latest`. Deployment uses the exact requested tag via the `X-Deploy-Version` webhook header and keeps
  the existing server-side `instances.json` copy step.
- Mirrors remain independent and run on the default branch and release tags.

Before enabling automatic releases in GitLab:

1. In **Settings > CI/CD > Job token permissions**, enable **Allow Git push
   requests to the repository**. The script explicitly triggers the tag pipeline
   because a job-token push does not trigger one automatically.
2. Protect `v*` tags and allow the pipeline user to create them. Keep production
   variables protected and available to release jobs (environment scope `*`).
   Merge-request quality checks do not need these variables.
3. Update `deploy-agent/deploy.sh` and `deploy-agent/hooks.json` on the server,
   then recreate the production deploy-agent before merging to reload its hooks.
   Keep the registry repository in `API_IMAGE`; the agent overrides only its tag.
   No Compose changes are required.

The release script uses the existing job token. No new personal token or manual
tag push is needed. Test release scripts with:

```sh
yarn test:ci
```
