# Releasing atelier-api

atelier-api is a **server**, not a distributed app — there are no installers.
A "release" is a version tag + notes that (a) gives the update-available check a
number to compare against, and (b) records what changed. Deployment is separate.

## Cut a release

1. **Bump the version** in `package.json` (`version`), following
   [SemVer](https://semver.org/) — patch for fixes, minor for features.
2. **Add a CHANGELOG section** `## [x.y.z] — YYYY-MM-DD` at the top, plus a
   `[x.y.z]:` link reference at the bottom.
3. **Commit to `master`** and push. On Dokploy this auto-redeploys the server.
4. **Tag and push:**
   ```bash
   git tag -a vx.y.z -m "atelier-api vx.y.z"
   git push origin vx.y.z
   ```
   The `Release` workflow verifies the tag matches `package.json`, extracts the
   CHANGELOG section and publishes a GitHub Release.

## Why the version matters

The running server checks GitHub `master`'s `package.json` version against its
own and reports "update available" (see `src/version-check.ts`). **If you don't
bump the version, deployed servers never notice they're behind.**

"Updating" a deployed server = **redeploy** it. On Dokploy, pushing `master`
already triggers a rebuild + redeploy, so a merged bump both marks the new
version *and* rolls it out.
