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

### User Invitations (API Required)

Invited accounts use administrator/user permissions and Mailjet invitation
delivery. Existing administrator credentials and sessions remain compatible. Guests
cannot read `/instances`, storage, download clients or administrator settings.
The administrator must enable authentication before creating invitations.

Configure these variables **in the API container environment**, never in `VITE_*`:

```dotenv
MAILJET_API_KEY=your-public-api-key
MAILJET_SECRET_KEY=your-secret-api-key
MAIL_FROM_EMAIL=flix@example.com
MAIL_FROM_NAME=Flix
FLIX_PUBLIC_URL=https://flix.example.com
```

Use an address/domain verified in Mailjet. The implementation uses
[Mailjet Send API v3.1](https://dev.mailjet.com/docs/email-api/send-api-v31/send-basic-email),
including per-message result validation. Use HTTPS for an externally accessible
deployment. Persist and back up Redis: accounts and the invitation outbox use
Redis, not `instances.json`.

Administrators manage invitations and guest access from **Users** in the webapp.
Guests sign in using their email in the username field. Invitations expire after
seven days, are single-use and cannot choose their role or recipient email.
Passwords use scrypt, sessions are stored by token hash, and access revocation
invalidates all the user's sessions. Authentication cannot be disabled while
active guests or pending invitations remain.
If the administrator record is lost while guests/invitations remain, protected
routes fail closed rather than reverting to public access; restore that record
from the Redis backup.

Invitation creation queues mail without waiting for Mailjet. A worker checks the
durable outbox every ten seconds, with a Redis lease across API replicas. Failed
sends retry with exponential backoff, up to five attempts. Delivery status is
visible in **Users**; use Refresh to update it. After a permanent failure, revoke
the invitation and create another. Delivery is at-least-once: a crash after
Mailjet acceptance can send the same invitation email again, but the link still
only creates one account. `sent` means Mailjet accepted the message, not that the
recipient inbox received it.

Invitation tokens are hashed for validation and encrypted in the pending outbox
using a key derived from `MAILJET_SECRET_KEY`. Rotating that secret requires
revoking and recreating queued invitations. The acceptance link carries its
secret in a URL fragment, which the webapp clears on opening. Do not share
invitation links publicly.

### Film and Series Requests

API 2.2.0 and webapp 3.25.0 add a **Requests** page for invited users and the
administrator. Configure `TMDB_API_KEY` in the API container environment (the same
TMDB application key may be used by the webapp). It is independent of the
webapp's build-time `VITE_TMDB_API_KEY`. No new browser access to Radarr/Sonarr is
required for guests. Never expose their service API keys in client configuration.

- Search films/series in TMDB, inspect availability and request a film, selected
  seasons, or the entire series including future seasons.
- Exact media/scope duplicates share one persistent request and multiple
  subscribers. Guests only see their own list and cannot see other subscribers
  or service targets. Metadata and external IDs are resolved on the server;
  client-supplied titles, credentials, URLs and roles are never trusted.
- Administrators approve or refuse from **All requests**, with an optional refusal
  reason. Approval selects a configured instance, native quality profile and
  native root folder, validated again on the server.
- New titles are added monitored, with a native missing-media search. Existing
  titles keep their quality profile and path. Season-specific requests preserve
  unrelated seasons; whole-series requests also monitor future seasons. Specials
  are not included. TMDB seasons not yet present in Sonarr cannot be approved yet.
- Approval means Radarr/Sonarr accepted the addition/monitoring, not that a release
  was downloaded. An unavailable future release can remain approved while waiting.
- Availability checks run in the API every minute (up to five due requests per
  pass), and the visible list refreshes every 30 seconds/on focus. Provider failures
  preserve the last confirmed status and flag it as unverified.
- Mutations are never automatically replayed after a timeout. **Needs review**
  requires an explicit **Check service**: a read-only check either confirms the
  monitored media or returns an absent item to pending approval. If the media
  exists but monitoring cannot be confirmed, inspect Radarr/Sonarr directly.

Requests use Redis compare-and-swap and a worker lease; keep Redis persistence
and backups enabled. Approval claims are durable and concurrent approvals cannot
trigger the same request twice. Stalled approvals become **Needs review** after
three minutes, checked at the next worker pass. Catalog access and submissions
are rate-limited per user; requests are capped at 5,000 records. Exact season
scopes are grouped; overlapping scopes can have separate requests, but native
identity checks prevent duplicate Radarr/Sonarr library entries.

Search uses [TMDB](https://developer.themoviedb.org/reference/search-movie).
Approval uses the native [Radarr](https://radarr.video/docs/api/) and
[Sonarr](https://sonarr.tv/docs/api/) APIs, not download-client credentials.
**Request notifications are not part of this stage**: Mailjet currently sends
invitations only. In-app/email request notifications follow on a separate branch.

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
