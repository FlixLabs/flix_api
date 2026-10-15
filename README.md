# flix_api

## Codex Session

Resume the development session:

```sh
codex resume 019d0252-50ae-7110-935a-753841d46961
```

**flix_api** is a lightweight Node.js API designed to complement [flix_webapp](https://github.com/FlixLabs/flix_webapp). While it remains entirely optional, integrating **flix_api** unlocks additional features such as multi-instance management for Radarr and Sonarr, and basic authentication for enhanced security.

---

## Features

### Download Clients (Optional)

Flix API provides a connector-based interface for inspecting completed torrents.
Deluge is the first supported connector; qBittorrent and Transmission are not yet
implemented. Existing Radarr/Sonarr download actions remain independent.

Add these optional fields to an instance in `instances.json`:

```json
{
  "download_clients_token": "replace-with-a-random-token-at-least-32-characters-long",
  "download_clients": [{
    "id": "main",
    "name": "My Deluge",
    "type": "deluge",
    "base_url": "http://deluge:8112",
    "password": "replace-with-the-deluge-web-password",
    "allow_delete_data": false
  }]
}
```

Merge these fields into your existing instance; keep its `name`, `radarr` and
`sonarr` settings. Generate a random token with `openssl rand -hex 32` and use it
in Flix's **Downloads > Download clients** dialog. It is independent of deployment
and storage-agent tokens. The browser keeps it only until the dialog closes.
Restart/redeploy the API to reload the instance configuration. Deluge Web must be
running and already connected to the intended daemon; Flix never automatically
selects a daemon. `base_url` is the Web UI base URL, without `/json`.

Client passwords, endpoints and access tokens are never returned by `/instances`.
Protect the API with HTTPS or a trusted private network. Never publish the instance
file. Every client endpoint requires `Authorization: Bearer <download_clients_token>`.
GET `/download-clients/:instance` lists client capabilities and normalized torrents;
DELETE `/download-clients/:instance/:client/:torrent` requires JSON
`{"name":"exact current torrent name","deleteData":false}`.

Before each removal, Flix rereads the torrent and every configured instance's
Radarr/Sonarr queues, including all pages. Active or tracked torrents cannot be
removed. A queue/authentication/daemon failure blocks cleanup. Untracked does not
prove import completion: seeding torrents can still be useful, and another app or
an unconfigured service may depend on them. Queue state can also change after
verification; no cross-service atomic transaction is possible.

Files are kept by default. Only set `allow_delete_data: true` after checking your
download/library paths and sharing setup; enabling it allows an additional explicit
confirmation to delete data. Flix does not prove library-file isolation and cannot
undo deletion. Lost write responses are reported as uncertain, never automatically
retried. Verify the client and refresh before another attempt.

New connectors implement `list()` and `remove(id, deleteData)` in `download-clients/`
and register their connection factory and ID validator in `index.js`. No arbitrary RPC proxy is exposed.
Deluge uses its [official Web JSON-RPC interface](https://deluge.readthedocs.io/en/deluge-2.2.0/devguide/how-to/curl-jsonrpc.html).

### Core Features

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
