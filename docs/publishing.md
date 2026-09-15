# Publishing

The first planned npm release is `node-playsound@0.1.0`. Repository preparation
and an npm publish dry-run do not publish or reserve that name. The README's
registry install command becomes available only after publication succeeds.

## Prepare the release

1. Merge the release changes into `master`. Keep `package.json` and
   `package-lock.json` versions aligned and update `CHANGELOG.md`. For later
   releases, `npm version <version> --no-git-tag-version` updates both manifests;
   commit the reviewed changes before building.
2. Open this repository's [Build and verify workflow](https://github.com/Technikhighknee/node-playsound/actions/workflows/ci.yml).
   Select the run for the exact release commit on `master`. Require the entire
   run to pass: six native targets, Node 22 and 24 tests, sanitizer checks,
   installed-package checks, and the publication dry-run.
3. Complete and record real-device listening checks for WAV/MP3/FLAC, overlapping
   playback, volume, seeking, stop, and shutdown on Windows, macOS, and Linux.
   Consult [validation.md](validation.md): physical macOS/Linux listening is
   still unverified. CI's silent backend is not evidence of speaker output.
4. Download that run's `npm-package` artifact and extract its ZIP into a separate
   release directory. For 0.1.0 it contains `node-playsound-0.1.0.tgz`. Use this
   complete archive, not an individual `native-*` artifact or an older local build.

The archive contains all six native engines, JavaScript, declarations, license,
notices, documentation, examples, and changelog. CI checks executable permissions
and hashes before packing. Never combine binaries from different source commits.
Local `npm run package` is useful for inspection, but the release artifact should
come from the successful target-native CI build. Do not run bare `npm publish`
in the checkout: publish the verified `.tgz` explicitly, including on Windows.

## Publish the verified archive

Use an npm account with a verified email and two-factor authentication. Sign in
through npm's browser flow; do not commit credentials or paste tokens into this
repository. From the extracted artifact directory:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view node-playsound name version maintainers --registry=https://registry.npmjs.org/
npm publish ./node-playsound-0.1.0.tgz --dry-run --ignore-scripts --access public --registry=https://registry.npmjs.org/
```

Before the first publication, `npm view` is expected to report `E404`. This is
not a reservation or a guarantee that npm will accept the name. If a package
already exists, verify ownership before continuing. A dry-run checks packaging;
it does not prove publishing permission or satisfy the account's 2FA challenge.

When the reviewed artifact and account are ready, the following command makes
0.1.0 publicly installable under the `latest` tag:

```sh
npm publish ./node-playsound-0.1.0.tgz --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org/
```

Follow npm's authentication prompts. `--ignore-scripts` is intentional: the
archive has already been built and validated, and its development scripts and
compiler sources are not distributed. It does not omit archive contents.
A published name/version cannot be reused, even after unpublishing.

## Verify and record

```sh
npm view node-playsound@0.1.0 version dist.integrity dist.tarball --registry=https://registry.npmjs.org/
npm install node-playsound@0.1.0 --ignore-scripts --registry=https://registry.npmjs.org/
```

Run the installation command in a fresh consumer project. Try the README playback
example with a local audio file. Compare `dist.integrity` with the SHA-512 integrity
printed by the successful CI packaging step. Tag the exact tested commit `v0.1.0`
and create a GitHub release using the changelog and the same archive; do not tag a
newer commit merely because `master` has advanced.

Publishing is a manual maintainer action. CI has no npm token and does not publish
on pushes, tags, or GitHub releases. Future automated releases can use npm trusted
publishing and provenance after configuring the package's npm permissions; those
account settings are separate from preparing this repository.

References: [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/),
[npm publishing and authentication](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/),
[trusted publishing](https://docs.npmjs.com/trusted-publishers/).
