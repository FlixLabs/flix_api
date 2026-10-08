# flix_api

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
