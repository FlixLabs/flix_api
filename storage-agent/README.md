# Storage Agent

Install this agent on the host running Radarr, Sonarr and the download client.
It reads filesystem capacity, not directory sizes or file contents. No Docker
socket, SSH access or privileged mode is required.

## Configure on the Storage Host

1. Find the host sources of the Radarr `/movies`, Sonarr `/tv` and Deluge download
   mounts using `docker inspect`. Use those same directories, not the container
   paths. Do not guess the download location.
2. In this directory, create `.env` using `.env.dist` as its template.
3. Generate a token with `openssl rand -hex 32` and set `STORAGE_AGENT_TOKEN`.
4. Set the three host paths. Relative paths resolve against this Compose folder.
   Existing absolute host paths are also supported; neither is hard-coded.
5. Set `STORAGE_AGENT_BIND_IP` to the private interface reachable by Flix API,
   and `STORAGE_AGENT_PORT` to an available port, for example `9010`.

```sh
docker compose up -d --build
```

All three paths must exist. Compose must not silently create empty directories.
SSHFS must already be mounted and readable by the container's unprivileged
`node` user (UID 1000). Configure permissions on the host; do not make the agent
privileged. If the SSHFS mount is recreated, recreate the agent too and recheck
the capacities. Bind propagation requires shared host mount propagation.

Keep the agent on a private network; allow only the Flix API host through the
firewall. HTTP does not encrypt the bearer token: use HTTPS through an existing
reverse proxy or an encrypted private network when traffic crosses an untrusted
network. Do not publish the agent directly on the Internet.

## Configure Flix API

Add this optional object to the relevant instance in the API host's
`instances.json` (alongside `name`, `radarr` and `sonarr`):

```json
"storage_agent": {
  "base_url": "http://STORAGE_HOST_PRIVATE_ADDRESS:9010",
  "token": "THE_SAME_GENERATED_TOKEN"
}
```

Restart Flix API to reload instances. Instances without this object keep working.
The API never returns this object to browsers; `/instances` only publishes
`has_storage_agent`. Browser requests use `GET /storage/Example`, with the instance
name URL-encoded. The API forwards requests with the configured token, rejects
redirects, uses a five-second timeout and returns 502 when the agent is unavailable.
This route uses Flix API's existing access model; it does not add user/session
authentication to the rest of the API.

The webapp integration is separate: this branch adds the agent and API endpoint.

## Verify Real Measurements

Compare `df -k` on the three host directories with the agent response, then with
`GET /storage/Example` on Flix API. Supply the agent token with `Authorization: Bearer`.
Never paste that token into logs, screenshots or commit history.

The response contains a collection timestamp and one record per location:

- `id`: `movies`, `series` or `downloads`.
- `path`: the agent's mount path.
- `available`: false when the path cannot be read (no fabricated zero metrics).
- `totalBytes`, `usedBytes`, `availableBytes`, `reservedBytes`: filesystem bytes.
- `usagePercent`: rounded up like `df`, excluding reserved space from the denominator.
- `volumeId`: opaque identifier shared by bind mounts of the same filesystem.

Use `volumeId` to avoid summing the same filesystem twice. The identifier is
derived from mount information and can change after remount/restart; it is not a
persistent hardware identity. Separately mounted SSHFS filesystems are not
automatically inferred to be the same physical remote disk.

Measurements are coalesced and cached for five seconds. No request parameter can
select another path. The agent supports only authenticated `GET /storage`.

Implementation uses Node.js `statfs` and Linux `/proc/self/mountinfo`:
[Node filesystem API](https://nodejs.org/docs/latest-v24.x/api/fs.html),
[Linux mount information](https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html).
