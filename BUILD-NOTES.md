# Mercury — build notes

Mercury builds from source into one self-contained, node-targeted ESM bundle.
`build.ts` is the whole build: a `Bun.build` call with a small resolver
plugin, a set of `define` constants, post-build payload vendoring, in-build
integrity tripwires, and a machine-readable artifact manifest. There is no
macro layer and no source transform — the source is what builds.

This file covers the build, packaging, vendored payloads, launchers, and
runtime constraints. The running product's surface (boot, update, recovery)
is `docs/TERMINAL-RUNTIME.md`.

## The build command

```sh
bun run setup        # once; bun install + the four vendored packs (network)
bun run build.ts     # -> dist/mercury.mjs + manifest.json + vendor payloads
node dist/mercury.mjs --version    # "Mercury <package.json version>"
```

`MERCURY_BUILD_OUTDIR` redirects the output directory, so a harness can
build into scratch space without touching the live `dist/`.

The build does not type-check. The type floor is `bun run typecheck`,
documented below.

## Outputs

A successful build writes, under `dist/`:

- `mercury.mjs` — the product bundle (entrypoint `src/entrypoints/cli.tsx`;
  `target: 'node'`, `format: 'esm'`, minified, no sourcemap).
- `verify-artifact.mjs` — the shipped provenance verifier, a second bundle
  from `src/services/privateChannel/verifyArtifactStandalone.ts`. It is the
  one compiled verification implementation: release archives ship it beside
  the bundle, the packaged launchers run it on interactive boots (warn-only),
  `scripts/release/package.mjs` imports the staged copy as its signing
  library, and `/health` runs the same source in-bundle.
- `manifest.json` — the artifact manifest (below). Written only when the
  whole build succeeds; a stale manifest and a stale `verify-artifact.mjs`
  are removed at build start, so absence always means "do not ship".
- `.build-tree` — the git tree hash of the tracked content the bundle was
  built from. Computed at bundle start (a mid-build edit can only cause a
  cache miss, never a false hit), written only on success. Consumers: the
  doctor's build-fresh check and the gate's dist cache. Best-effort: a
  non-git checkout gets no stamp.
- `vendor/…` — the vendored payloads (below).

## Runtime contract — three truths, never one number

| Truth | Value | Owner |
|---|---|---|
| Build runtime | Bun 1.3.x (the CI workflows pin the exact version) | `build.ts`; `.github/workflows/*.yml` |
| Shipped-bundle runtime | Node, supported range `>=24.20.0 <25` (the one qualified major; the 24.20.0 floor carries the fix for nodejs/node#56645; an open-ended "24 or newer" claim is banned) | `src/utils/runtime/nodePolicy.ts` is the single policy owner; `package.json` `engines.node` is its machine-readable projection, held equal mechanically |
| Calibration runtime | the exact patch in `.node-version` (development and CI reproduction; may advance within the major independently) | `.node-version` |

Enforcement: the entrypoint evaluates the runtime policy as its first
step, so every route — interactive, headless, `acp`, `daemon`, raw
`node dist/mercury.mjs` — receives the same non-zero refusal on an
unsupported Node. Bun-hosted
execution is exempt by name: bun is the build runtime, and its node-compat
version string is not the product's runtime claim. The manifest `node`
field and the packaged launchers project the range from the one owner.

## Module resolution (the build plugin)

- **`color-diff-napi`** — the one native-bare alias: `STUB_MAP` (and the matching `tsconfig.json` `paths` entry) resolves it to the pure-TS port at `src/native-ts/color-diff` (a drop-in surface for highlighted diffs).

- **`src/…` absolute specifiers** — the source mixes relative imports with
  bare `from 'src/foo/bar.js'` specifiers. An `onResolve` maps the `src/`
  root into the work tree, probing `.ts/.tsx/.js/.jsx/.mjs/.cjs/.json` and
  `/index.*` (bun does not auto-probe extensions for plugin-returned paths).
- **`jsonc-parser`** — redirected to the package's ESM build
  (`lib/esm/main.js`). Its UMD main passes `require` into a factory, which
  survives bundling as a real runtime `require('./impl/…')` and kills a
  single-file artifact. The vscode-family language services are deep-imported
  `/lib/esm` at source for the same reason.
- **Text loaders** — `.md`, `.txt`, `.sh`, `.py`, `.html`, `.xml`, `.dot`
  import as strings (bundled skills import their documentation and helper
  assets as text; code-module extensions stay real code).

## Build-time constants

`MACRO` is a `define` global; the zero-import `--version` fast path reads
`MACRO.VERSION`. One version root: `package.json` is the authority, the
build injects it, and the banner, manifest, release archives, and CLI all
render the same value.
Same pattern for the repository URL: `MACRO.PACKAGE_URL` derives from
`package.json` `repository.url`, and the private update channel resolves its
release slug from it — never a second hand-held literal. A missing
`engines.node` or an unrecognized `repository.url` fails the build.

Also defined: `process.env.NODE_ENV = 'production'`. Beta-only API request
shapes (global-scope prompt-cache blocks, deferred tool loading, the
experimental beta-header family — shapes the production API and proxy
providers reject) are baked off at source.

## Self-containment

`dist/mercury.mjs` runs where no `node_modules` exists — release archives
and the deployed runtime both copy it out of the tree. Three
in-build tripwires fail the build rather than ship a bundle that only works
in the repository:

### zod

Every resolvable package is inlined; nothing is `external`. The tripwire
scans the emitted bundle's import graph (`Bun.Transpiler.scanImports` — an
AST scan, because bundled skill documentation contains import statements as
prose) and fails on any bare static package import. Bare dynamic imports are
the sanctioned lazy-degradation seam for optional dependencies that fail at
call time with their own remedy, pinned to an explicit allowlist
(`cli-highlight`, `image-processor-napi`, `kerberos`, `plist`,
`proxy-agent`); a new one forces a conscious decision in `build.ts`.
`sharp`'s module-scope loader throws when no prebuilt binding resolves, so
it is imported lazily everywhere — a missing binding degrades image work at
call time instead of killing boot.

Behavioral coverage: `bun run artifact:smoke` copies the bundle to a fresh
temp dir with a fresh HOME and minimal PATH and drives `--version`,
`--help`, and `doctor --json` on plain node.

### undici

A `require` through a `createRequire(import.meta.url)` handle is opaque to
the bundler: it survives as a real runtime lookup beside the artifact, where
it can only throw `MODULE_NOT_FOUND`. The rule: a handle anchored on
`import.meta.url` may require node builtins and relative paths only —
packages are imported statically or through the module-scope `require` the
bundler inlines. Handles anchored on a workspace or vendor path (the
TypeScript facility, the grammar engine, the sidecars) are deliberate
out-of-bundle resolution and are not scanned. The tripwire scans `src/` and
fails the build on a bare package required through an `import.meta.url`
handle.

The failure mode this closes is a silent boot stall; its loud-failure
counterpart lives in the runtime: a module-load failure on the boot path
restores the terminal, prints a card, and exits 1.

### No build-host trace

Bundled CommonJS modules receive a literal `__filename` holding the absolute
build-time path — the build host's user name and checkout directory would
otherwise ship in every artifact. The build rewrites those literals to a
neutral virtual location (`/mercury/vendor/…`) and then fails if the build
root appears anywhere else in the bundle. Two hosts building the same tree
produce the same bytes at this seam.

## Vendored payloads

`Bun.build` produces only JavaScript; the post-build steps place the binary
and asset payloads the runtime expects beside it. `dist/manifest.json`
records each one either as `vendored: true` with its version and digest, or
as `vendored: false` with a remedy — plus a `degraded` list naming every
absent capability. A build never downloads anything: vendor caches are
prepared by explicit `scripts/vendor/fetch-*.ts` commands and re-verified
against their checked-in lock files before a byte is consumed.

- **ripgrep** (load-bearing — the build fails without it). The runtime
  resolver (`src/utils/ripgrep.ts`) expects
  `dist/vendor/ripgrep/<arch>-<platform>/rg` (`rg.exe` on win32) and spawns
  it for every Glob/Grep. Source priority: `@vscode/ripgrep` (devDependency;
  its postinstall downloads a platform binary), then a system `rg`
  (`/opt/homebrew/bin/rg`, then `which rg`), else the build fails.
  `MERCURY_BUILD_ALLOW_NO_RG=1` is the explicit degraded-developer-build
  opt-in: loud warning, `search.vendored: false` in the manifest, and the
  runtime suppresses Glob/Grep from the tool catalog until an rg appears
  (a live probe). `MERCURY_BUILD_NO_VENDOR_RG=1` forces the no-binary
  condition.
- **debugpy** (optional). The Python debug adapter, an extracted wheel under
  `dist/vendor/debugpy/`. Truth is `vendor/debugpy.lock.json`
  (version · wheel · sha256 · adapter entry); the local cache is reproduced
  by `bun run scripts/vendor/fetch-debugpy.ts` (`--check` = no-network
  validity). No cache ⇒ the build succeeds degraded
  (`python-debugger`) and the runtime falls back to an installed debugpy
  module. `MERCURY_BUILD_NO_VENDOR_DEBUGPY=1` forces the degraded arm.
- **Pyright** (optional). The Python language server, an extracted npm
  tarball under `dist/vendor/pyright/` (pure JS under Mercury's node
  prerequisite — it analyses the operator's selected Python environment; no
  Python runtime is bundled). Truth is `vendor/pyright.lock.json` (sha512);
  cache via `bun run scripts/vendor/fetch-pyright.ts` (`--check`
  supported). Absent ⇒ degraded `python-intelligence` with a PATH
  `pyright-langserver` fallback. `MERCURY_BUILD_NO_VENDOR_PYRIGHT=1` forces
  it.
- **js-debug** (optional). The Node/TypeScript debug adapter
  (vscode-js-debug's DAP server), an extracted release tarball under
  `dist/vendor/js-debug/` (pure JS under Mercury's node prerequisite; a
  multi-session adapter — the debugger's child-session road drives it).
  Truth is `vendor/js-debug.lock.json` (version · tarball · sha512); cache
  via `bun run scripts/vendor/fetch-js-debug.ts` (`--check` supported). The
  build writes a one-line `{"type":"commonjs"}` `package.json` into the
  vendored tree so node classes the CJS server correctly under any ancestor
  scope. Absent ⇒ degraded `js-debugger`, and the runtime falls back to
  `MERCURY_JS_DEBUG_DAP` or a `~/.js-debug` unpack; a PRESENT cache that
  mismatches the lock fails the build and names the fetch command.
  `MERCURY_BUILD_NO_VENDOR_JSDEBUG=1` forces the degraded arm.
- **TypeScript compiler** (optional). `dist/vendor/typescript/` — the
  single-file compiler from the repo's own pinned devDependency, with
  LICENSE, a `vendor.json` stamp, and a `{"type":"commonjs"}` `package.json`
  scoping the directory (a `"type":"module"` above `dist/` would otherwise
  make `require()` read the CJS compiler as an empty ESM namespace). Serves
  projects that carry no `typescript` of their own; the runtime prefers the
  workspace compiler. Absent ⇒ degraded `structural-intelligence`.
  `MERCURY_BUILD_NO_VENDOR_TYPESCRIPT=1` forces it.
- **tree-sitter grammar engine** (optional). `dist/vendor/treesitter/` —
  the WASM loader, runtime, and exactly the grammar files the declarative
  registry names (`src/services/structure/grammarRegistry.ts` — the same
  module the runtime routes with). Two sources: the
  `@vscode/tree-sitter-wasm` devDependency, and a cherry-picked grammar pack
  whose cache is verified per-file by sha256 against
  `vendor/grammars.lock.json` (`bun run scripts/vendor/fetch-grammars.ts`).
  Per-grammar licence notices travel with the artifact
  (`GRAMMAR-NOTICES.json`). A missing pack cache degrades honestly
  (`structure-polyglot-extended`) while the devDependency grammars still
  ship; a failed copy removes the whole directory rather than leaving a torn
  engine. WASM is platform-independent — one asset set serves every
  platform. `MERCURY_BUILD_NO_VENDOR_TREESITTER=1` and
  `MERCURY_BUILD_NO_VENDOR_GRAMMARPACK=1` force the degraded arms.
- **sharp** (deliberately not vendored). Its native
  binding is `node_modules`-resident, so a clean-machine artifact loses
  sixel/half-cell image decode at call time with sharp's own named error
  while the iTerm/kitty native image tiers keep working. The manifest's
  `imageProcessing` entry states this so the absence is a stated trade, not
  a silent surprise.

## The NOTICE stamp

Both JS artifacts receive a composed NOTICE head (`src/constants/legalNotice.ts`):
product identity, the named text slots (absent until written — never
placeholdered), and the third-party attribution pointer. Stamped
before the manifest is written so `bundleBytes`/`bundleSha256` describe the
shipped bytes; self-checked in-build (`BUILD OK` is impossible with a stale
or missing stamp). Version-only — no dates — so
reproducible-build comparisons are unaffected.

## The artifact manifest

`dist/manifest.json`, schema 2: `{schema, name, version, buildTime,
buildTree, bundle, bundleBytes, bundleSha256, node, selfContained, search,
pythonDebugger, pyright, jsDebug, typescript, treeSitter, imageProcessing,
degraded}`. `bun run artifact:smoke` asserts every claim against the real
files. The runtime tool catalog does not read it — it probes the real
binary state live, which agrees by construction since both derive from the
same vendored files. `bundleSha256` names the exact bundle bytes;
`scripts/ops/deploy-runtime.sh` recomputes it and refuses a mismatch, so a
tampered or torn bundle cannot deploy silently.

## Reproducible-build seams

The build stamp resolves `MERCURY_BUILD_TIME` (ISO string), then
`SOURCE_DATE_EPOCH` (seconds), then the wall clock.
`MERCURY_BUILD_MINIFY=oracle` keeps whitespace and syntax minification
(dead-branch elimination unchanged) but preserves identifiers, because the
full minifier's identifier renamer is nondeterministic across identical
inputs. `scripts/build/dist-compare.sh` builds the current tree with a
pinned stamp into scratch and prints the bundle hash — equal hashes are
proof of no change; differing hashes are inconclusive (the bundler is not a
pure function of its input).

## Packaging and launchers

`node scripts/release/package.mjs --target <linux-x64|macos-arm64|macos-x64|windows-x64>`
assembles one platform archive and then proves the friend path on the spot
(unpack into a directory with spaces, no repo or bun nearby, `--version`,
`--help`, no dev residue). Contents: the bundle, `manifest.json`, the
platform ripgrep, the platform launcher (`mercury`, or `mercury.cmd` +
`mercury.ps1`), the enter-screen pair (`splash.mjs` + `splash-core.mjs`,
canonical in `assets/splash/`), `verify-artifact.mjs`, optional install
scripts, `README-FIRST.md`, and `NOTICES.md` (the generated
`THIRD_PARTY_NOTICES.md` verbatim). A degraded manifest refuses to package
unless `--allow-degraded` says so explicitly.

Launcher templates live in `scripts/release/launcherTemplates.mjs`; every
launcher and README projects the Node policy from `engines.node` through a
parser that refuses unrecognized shapes. Signing is optional at packaging:
a signing key enters only through `MERCURY_SIGNING_KEY_FILE`
(Ed25519 over the release-manifest tuple); an unsigned archive says so
plainly. Release publication (tag ≡ version, `SHA256SUMS.txt`, the release
notes extracted from the bundled changelog's `## <version>` section —
`src/constants/changelog.ts`, by `scripts/release/notesFromChangelog.mjs`) is
the release workflow under `.github/workflows/`.

The repository also carries the source-checkout launcher
(`scripts/ops/launcher-mercury.sh`) and the runtime publisher
(`scripts/ops/deploy-runtime.sh`) that `AGENTS.md` installs;
`docs/TERMINAL-RUNTIME.md` describes that runtime surface.

## TypeScript configuration

One `tsconfig.json`, no overlay: editors, the typecheck gate
(`bun run typecheck`), and bun's runtime resolver read the same file; tsc
never emits. `strict: true` with a zero-diagnostic floor. `baseUrl: "."` is
load-bearing at runtime, not only for tsc: bun resolves the bare `src/…`
import family through it under `bun run scripts/…`.

## Dependencies

`bun install` resolves cleanly; `bun.lock` is the resolution authority and
every specifier is a version or bounded range. `THIRD_PARTY_NOTICES.md` is
the generated per-package inventory — regenerate after any dependency
change (`bun run scripts/distribution/generate-third-party-notices.ts`, or
`bun run version:sync`); a drift check holds it exactly equal to
`package.json`'s dependencies.

Pins with a reason visible in the source:

- `zod ~4.5.1` — the source imports the `zod/v4` API surface throughout.
- `commander ~15.0.0` (+ `@commander-js/extra-typings`) — the pinned major.
  The `-d2e, --debug-to-stderr` debug flag is a raw argv read
  (`src/utils/debug.ts`), so nothing in the source leans on the parser
  beyond the bounded range; an upgrade is a deliberate decision.
