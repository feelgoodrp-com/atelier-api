# Changelog

All notable changes to **atelier-api** (the sync server for the atelier
desktop app) are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and the project follows
[Semantic Versioning](https://semver.org/).

> atelier-api is a server, not a distributed binary — a "release" here is a
> version tag + notes. Deployment happens by redeploying (on Dokploy, pushing
> `master` auto-redeploys). See [RELEASING.md](RELEASING.md).

## [0.2.0] — 2026-07-17

### Added

- **Update-available check** — the server compares its running version against
  `master` on GitHub and reports whether it's behind on `/health`
  (`updateAvailable` + `latestVersion`), `GET /api/v1/version`, the browser
  landing page and the admin console, plus a startup-log warning. Disable with
  `ATELIER_API_UPDATE_CHECK=off`. "Updating" the server means redeploying it.

### Changed

- **Higher clothing split limit** — team-cloud builds now split at up to **256**
  drawables per gender/slot (was 128), matching the desktop app and the raised
  FiveM/CFX `.ymt` limit.

## [0.1.0]

### Added

- Initial sync server: Discord device auth, packs registry, team-cloud builds,
  admin web console.

[0.2.0]: https://github.com/feelgoodrp-com/atelier-api/releases/tag/v0.2.0
[0.1.0]: https://github.com/feelgoodrp-com/atelier-api/releases/tag/v0.1.0
