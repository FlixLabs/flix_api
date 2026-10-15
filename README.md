# flix_api


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

Merge these fields into your existing instance; keep its name, Radarr and Sonarr settings.
Restart/redeploy the API to reload it. Deluge Web must already be connected to the
intended daemon; the URL is the Web UI base URL without /json.

Download clients use the Flix login session, not a separate access token. The old
`download_clients_token` can be removed from instances.json (it is ignored and never
returned). The webapp loads clients when the panel opens.

### Flix Authentication (API 2.0.0 / Webapp 3.21.0)

Deploy the API and webapp together. GET /auth returns only account metadata, never
a password or password hash. POST /session verifies the username/password on the
API and issues a random session; DELETE /session revokes it. Passwords are salted
and hashed with asynchronous scrypt. Sessions are stored as digests in Redis with
a 30-day expiry and are invalidated by password changes. Sign-in attempts are
rate limited. Redis persistence is required to retain accounts across restarts.

For an existing encrypted account, temporarily add `AUTH_LEGACY_CRYPT_KEY` to the
API environment, with the exact former webapp `VITE_CRYPT_KEY` value. Recreate the
API container to load this new environment variable (restarting alone does not
update container environment). Sign in with the usual Flix username/password.
The API migrates the account to a salted hash atomically after verification; then
the migration key may be removed. No password reset or extra client token is needed.
CryptoJS is used only for this legacy migration, not for new password storage.

The webapp remembers the Flix session in this browser's local storage, separately
for each API URL; it works across reloads and browser restarts. It is accessible
to same-origin JavaScript: use a trusted webapp origin and HTTPS, and avoid shared
browser profiles. A session expires after 30 days, on sign-out or on account change.
Do not publish credentials or include session tokens in VITE build variables.

When Flix authentication is disabled, the API intentionally operates in public
mode, including client actions. Only use this mode on a trusted private network;
enable Flix authentication before exposing the API. CORS is not authorization.
The API now protects instances, storage, download clients and settings writes.
Direct Radarr/Sonarr browser connections retain their existing API-key model.

Before each removal, Flix rereads the torrent and every configured instance's
Radarr/Sonarr queues, including all pages. Incomplete torrents and unverifiable
tracking remain blocked. Completed tracked torrents require an explicit force
confirmation (DELETE body `force: true`); this may interrupt import and does not
clear Radarr/Sonarr queue entries or remove media from the library. The optional
force flag must be boolean. It never bypasses permissions to delete files.

Untracked does not prove import completion or that deletion is safe. Uncertain
write results are never retried automatically. No cross-service atomic transaction
is possible between Deluge and Radarr/Sonarr.

Implementation references: [Node crypto](https://nodejs.org/api/crypto.html) and
[Express security](https://expressjs.com/en/advanced/best-practice-security.html).

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
