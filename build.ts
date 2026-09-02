// Mercury build script.
// Bundles the Mercury source (src/entrypoints/cli.tsx) into a single
// node-targeted ESM file with bun. There is no build-time injection: no
// `feature()` macro and no define-folds — this script only provides `MACRO.*`
// constants, local stubs for the native `*-napi` dependencies, and the
// vendored ripgrep.

import { resolve } from 'node:path';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = import.meta.dir;
const SRC = resolve(ROOT, 'src');
// Output dir is injectable so proof harnesses can build into scratch dirs
// without clobbering the live dist/ (the pooled gate prebuilds dist ONCE and
// every suite reads it — a concurrent scratch build must never touch it).
const OUT = resolve(ROOT, process.env.MERCURY_BUILD_OUTDIR ?? 'dist');

// Reproducible-build seam: the stamp is injectable so two builds of the same
// tree can be byte-compared (the dist-identity oracle in scripts/build/
// dist-compare.sh depends on it). Precedence: MERCURY_BUILD_TIME (ISO string) >
// SOURCE_DATE_EPOCH (seconds) > wall clock.
const resolveBuildTime = (): string => {
  if (process.env.MERCURY_BUILD_TIME) return process.env.MERCURY_BUILD_TIME;
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (process.env.SOURCE_DATE_EPOCH && Number.isFinite(epoch)) {
    return new Date(epoch * 1000).toISOString();
  }
  return new Date().toISOString();
};

// Map of bare import specifier -> local stub absolute path.
const STUB_MAP: Record<string, string> = {
  // The pure-TS port (src/native-ts/color-diff) is a drop-in for the native
  // Rust addon: same ColorDiff/ColorFile/getSyntaxTheme/SyntaxTheme surface and
  // render(theme,width,dim) signature, highlighting via highlight.js. Aliasing
  // to it (instead of the inert stub, which had a render-less ColorDiff and
  // crashed every syntax-highlighted diff render) restores real highlighted
  // diffs in all build modes — matching the colorDiff.ts comment.
  'color-diff-napi': resolve(SRC, 'native-ts/color-diff/index.ts'),
};

// MACRO build-time constants.
// ONE version, Mercury's own; the update/feedback
// strings point at Mercury's repo + /feedback unconditionally (a source
// build's issues cannot be triaged in another product's tracker; the loyalty
// ratchet holds foreign distribution URLs at zero).
// ONE VERSION ROOT: package.json is the authority;
// the build injects it (MACRO.VERSION define) and product.ts re-exports the
// define — CLI --version, the banner, the manifest, and the release
// archives all read the same value. Bump package.json only.
const PKG_JSON = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string; engines?: { node?: string }; repository?: { url?: string } };
const MACRO_VERSION = PKG_JSON.version;
// ONE NODE-RANGE ROOT: package.json engines.node is
// the machine-readable support policy (prover-pinned equal to
// src/utils/runtime/nodePolicy.ts NODE_SUPPORT.range); the manifest projects it
// verbatim — never a hand-copied literal. A build without it must not ship.
const NODE_SUPPORTED_RANGE = PKG_JSON.engines?.node;
if (!NODE_SUPPORTED_RANGE) throw new Error('package.json engines.node missing — the manifest cannot record the supported Node range');
// ONE REPOSITORY ROOT: the packaged
// repository URL — the private update channel resolves its owner/repo slug
// from it (services/privateChannel/ghRelease.ts) — derives from package.json
// repository.url, never a second hand-held literal.
const REPO_URL = (PKG_JSON.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
if (!REPO_URL.startsWith('https://github.com/')) throw new Error('package.json repository.url missing or unrecognized — MACRO.PACKAGE_URL cannot be derived');
const MACRO = {
  VERSION: MACRO_VERSION,
  PACKAGE_URL: REPO_URL,
  NATIVE_PACKAGE_URL: `${REPO_URL}/releases`,
  FEEDBACK_CHANNEL: '/feedback',
  BUILD_TIME: resolveBuildTime(),
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER: 'report the issue with /feedback',
};

const mercuryPlugin: import('bun').BunPlugin = {
  name: 'mercury-build-time-resolves',
  setup(build) {
    // The source mixes relative imports with absolute `src/...` specifiers
    // (e.g. `from 'src/types/connectorText.js'`). Map the `src/` root to our
    // work-dir src directory. TS-style `.js` specifiers must be resolved to the
    // real `.ts`/`.tsx` on disk, including `/index.*` directory imports — bun's
    // onResolve does not auto-probe extensions for paths we return, so probe
    // them here.
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
    const probe = (base: string): string | null => {
      const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
      const candidates = [
        base,
        ...exts.map((e) => stripped + e),
        ...exts.map((e) => stripped + '/index' + e),
      ];
      for (const c of candidates) {
        try {
          if (statSync(c).isFile()) return c;
        } catch {
          /* not this one */
        }
      }
      return null;
    };
    build.onResolve({ filter: /^src\// }, (args) => {
      const abs = resolve(SRC, args.path.slice('src/'.length));
      const found = probe(abs);
      return found ? { path: found } : undefined;
    });

    // native deps -> local stubs
    const stubKeys = Object.keys(STUB_MAP);
    const stubFilter = new RegExp(
      '^(' + stubKeys.map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|') + ')$',
    );
    build.onResolve({ filter: stubFilter }, (args) => ({ path: STUB_MAP[args.path] }));

    // Native .node addons loaded by require() -> mark external (never resolved
    // at bundle time; only dlopen'd at runtime behind disabled gates).
    build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));

    //jsonc-parser's UMD main passes `require` INTO its factory, so
    // its relative requires survive bundling as RUNTIME requires and the
    // single-file artifact dies with "Cannot find module './impl/format'".
    // Redirect the bare import to the package's clean ESM build (the
    // vscode-family language services are deep-imported /lib/esm at source
    // for the same reason — see webSidecar/sidecar.ts).
    build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
      path: resolve(ROOT, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js'),
    }));
  },
};

// CONTENT BINDING for the /doctor build-fresh check + the gate's Phase-0
// dist-cache:
// the SOURCE TREE sha this bundle is built from — a temp-index write-tree
// over the tracked working content. Computed HERE, at bundle START: stamping
// after the bundle recorded any edit saved MID-BUILD as if the bundle
// contained it, and the next gate's dist-cache false-HIT then tested a
// binary missing the edit. Computed-before ⇒ a mid-build edit can only make
// the recorded tree differ from the post-edit content — a cache MISS and a
// rebuild, never a false HIT. The stamp files are still written only after
// a successful build (absence means "do not ship"). Best-effort: a non-git
// checkout gets no stamp (the mtime heuristic stands).
let buildTree: string | null = null;
try {
  const { execSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const idxDir = mkdtempSync(pjoin(tmpdir(), 'build-tree-'));
  const env = { ...process.env, GIT_INDEX_FILE: pjoin(idxDir, 'index') };
  try {
    execSync('git read-tree HEAD', { env, stdio: 'pipe' });
    execSync('git add -A', { env, stdio: 'pipe' });
    const tree = execSync('git write-tree', { env, stdio: 'pipe' }).toString().trim();
    if (tree) buildTree = tree;
  } finally {
    rmSync(idxDir, { recursive: true, force: true });
  }
} catch {
  // best-effort — no stamp, the doctor falls back to mtime honesty
}

const result = await Bun.build({
  entrypoints: [resolve(ROOT, 'src/entrypoints/cli.tsx')],
  outdir: OUT,
  naming: 'mercury.mjs',
  target: 'node',
  format: 'esm',
  sourcemap: 'none',
  // Enable minify so the bundler's constant-folding pass collapses the
  // `false ? require('./X') : null` branches (after the feature()→false
  // transform) and drops the dead `require()` targets entirely.
  //
  // ORACLE MODE (MERCURY_BUILD_MINIFY=oracle): the full minifier's IDENTIFIER
  // renamer is nondeterministic across identical inputs (parallel symbol
  // allocation — two same-tree builds differ in every short name), which
  // breaks byte-comparison proofs. Oracle mode keeps whitespace+syntax
  // minification (syntax does the constant-folding DCE, so dead-branch
  // elimination is unchanged) but preserves original identifiers, making the
  // bundle a deterministic function of the input tree. Shipping builds stay
  // fully minified.
  minify:
    process.env.MERCURY_BUILD_MINIFY === 'oracle'
      ? { whitespace: true, syntax: true, identifiers: false }
      : true,
  // zod is INLINED (no `external`): dist/mercury.mjs must be genuinely
  // self-contained — it is copied out of the tree by `mercury join-kit` and
  // run where no node_modules exists. The known bun footgun here — bun
  // mis-scoping zod's internal `util` namespace when inlined
  // (ReferenceError: util is not defined from zod's object() factory) —
  // does not reproduce on bun 1.3.11.
  // The isolated-artifact proof (scripts/build/prove-isolated-artifact.ts)
  // runs the bundle from a temp dir with no module resolution and fails the
  // gate if a bare-specifier import ever reappears.
  plugins: [mercuryPlugin],
  loader: {
    // Bundled skills import their documentation as text: `import md from './X.md'`.
    '.md': 'text',
    // Some prompts ship as raw .txt and are `require()`d as strings.
    '.txt': 'text',
    // Bundled-skill REFERENCE SCRIPTS/ASSETS inline as text too, so a skill's
    // helper scripts extract to disk on invocation (getBundledSkillsRoot temp,
    // never ~/.claude). Only NON-code-module extensions are safe to globalize
    // to 'text' — .js/.cjs/.ts stay real code (a skill's .js/.ts/extensionless
    // refs are inlined via a generated `*.inlined.txt` sibling instead, see
    // scripts/skills/gen-bundled.ts).
    '.sh': 'text',
    '.py': 'text',
    '.html': 'text',
    '.xml': 'text',
    '.dot': 'text',
  },
  define: {
    MACRO: JSON.stringify(MACRO),
    'process.env.NODE_ENV': JSON.stringify('production'),
    // The experimental-betas kill (beta-only API shapes: global-scope
    // prompt-cache blocks, deferred tool loading, the experimental
    // beta-header family — shapes the production API and proxies reject) is
    // baked at SOURCE: shouldIncludeFirstPartyOnlyBetas() and
    // shouldUseGlobalCacheScope() fold to false in
    // src/utils/model/capabilities.ts, and the api.ts strip choke point
    // rides them. No env define carries it, and no env read exists —
    // un-baking it is a deliberate build-policy change, never a cleanup.
  },
  // Keep node built-ins + remaining npm deps as runtime requires? No: bundle
  // everything resolvable; node: builtins are handled natively by target=node.
});

if (!result.success) {
  console.error('BUILD FAILED');
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// A stale manifest from a previous build must never describe THIS build's
// output — drop it now; it is re-written only when this build fully succeeds.
rmSync(resolve(OUT, 'manifest.json'), { force: true });
// Same staleness law for the shipped verifier: it is rebuilt below on every
// successful build; a leftover from an earlier tree must never ride along.
rmSync(resolve(OUT, 'verify-artifact.mjs'), { force: true });
// And for the build-tree stamp: written only on success (below), so a build
// that fails inside its own window left the PREVIOUS stamp beside the new
// bundle and doctor certified the bundle as built from a tree it was not
// (the stale-stamp class).
rmSync(resolve(OUT, '.build-tree'), { force: true });

// SELF-CONTAINMENT TRIPWIRE: dist/mercury.mjs is copied out of the tree
// (mercury join-kit) and run where no node_modules exists, so the bundle may
// never re-grow a bare STATIC package import (the shape a re-added `external`
// emits — zod was external until and killed every out-of-tree
// copy with ERR_MODULE_NOT_FOUND). AST scan, not a text needle: bundled
// skill docs contain `import … from "zod"` as PROSE, which a regex
// false-positives on. Bare DYNAMIC imports are the sanctioned lazy
// degradation seam (sharp-class: optional deps that fail at call time with
// their own remedy), pinned to a known allowlist so a new one forces a
// conscious decision here. Behavioral coverage: prove-isolated-artifact.ts.
// The bundle carries no trace of the machine that built it. Bundled CommonJS
// modules (undici, vscode-languageserver) receive a literal `__filename`
// holding the ABSOLUTE build-time path — the build host's user name and
// checkout directory would ship in every artifact. Those modules never read
// the real path at runtime (stack cosmetics only), so the literal is rewritten
// to a neutral virtual location, then the whole bundle is proven clean of the
// build root. Reproducible-build seam: two hosts now yield the same bytes here.
{
  const bundlePath = resolve(OUT, 'mercury.mjs');
  const raw = readFileSync(bundlePath, 'utf8');
  const rootsToErase = [ROOT, realpathSync(ROOT)].filter((r, i, a) => a.indexOf(r) === i);
  let neutral = raw;
  for (const root of rootsToErase) {
    neutral = neutral.split(`${root}/node_modules/`).join('/mercury/vendor/');
  }
  for (const root of rootsToErase) {
    if (neutral.includes(root)) {
      const at = neutral.indexOf(root);
      throw new Error(
        `build root leaked into dist/mercury.mjs beyond the vendored-module __filename seam: …${neutral.slice(Math.max(0, at - 80), at + root.length + 40)}…`,
      );
    }
  }
  if (neutral !== raw) writeFileSync(bundlePath, neutral);
}
{
  const bundleText = readFileSync(resolve(OUT, 'mercury.mjs'), 'utf8');
  const { builtinModules } = await import('node:module');
  const builtin = new Set(builtinModules);
  const isBare = (p: string): boolean =>
    !p.startsWith('node:') && !p.startsWith('./') && !p.startsWith('../') && !builtin.has(p);
  const ALLOWED_LAZY_BARE = new Set([
    // Uninstalled optional deps, imported lazily behind try/catch-style
    // degradation; they fail closed in-repo today (nothing to bundle).
    'cli-highlight',
    'image-processor-napi',
    'kerberos',
    'plist',
    //@puppeteer/browsers imports proxy-agent lazily on EVERY download
    // request (httpUtil.js, no env-var condition) inside a try/catch that
    // falls back to Node's standard agents — a missing module never crashes,
    // but a proxied operator silently loses the proxy (no named error).
    'proxy-agent',
    // @puppeteer/browsers 3.2 imports yauzl lazily as its LAST zip fallback,
    // after `unzip` and `tar.exe`/PowerShell; a box with none of them gets the
    // package's own named error ("…or add the optional `yauzl` dependency").
    // Optional peer, not in the lockfile — a stale copy in one node_modules
    // once hid this line by inlining it.
    'yauzl',
  ]);
  const scanned = new Bun.Transpiler({ loader: 'js' }).scanImports(bundleText);
  const staticBare = [...new Set(scanned.filter((i) => i.kind === 'import-statement' && isBare(i.path)).map((i) => i.path))];
  const newLazyBare = [
    ...new Set(scanned.filter((i) => i.kind === 'dynamic-import' && isBare(i.path) && !ALLOWED_LAZY_BARE.has(i.path)).map((i) => i.path)),
  ];
  if (staticBare.length > 0 || newLazyBare.length > 0) {
    console.error(
      'BUILD FAILED: dist/mercury.mjs is not self-contained.\n' +
        (staticBare.length > 0
          ? `  Bare STATIC imports (boot-fatal outside a node_modules tree): ${staticBare.join(', ')}\n` +
            '    → remove the `external` entry / bundle the package (see BUILD-NOTES.md §zod).\n'
          : '') +
        (newLazyBare.length > 0
          ? `  NEW bare dynamic imports (lazy, but unresolvable out-of-tree): ${newLazyBare.join(', ')}\n` +
            '    → bundle the package, or if it is a sanctioned optional-degradation seam\n' +
            '      add it to ALLOWED_LAZY_BARE in build.ts with a guard at the call site.\n'
          : ''),
    );
    process.exit(1);
  }
}

// RUNTIME-REQUIRE TRIPWIRE: a require through a
// createRequire(import.meta.url) handle is opaque to the bundler — it survives
// as a real lookup beside the artifact, where no node_modules exists. The
// deployed runtime died exactly so: proxy.ts required `undici` through such a
// handle, the lookup threw MODULE_NOT_FOUND inside init(), and the boot idled
// on a blank screen. The AST scan above cannot see the shape (the handle is a
// plain identifier), so the SOURCE is scanned: a handle anchored on
// import.meta.url may require node builtins and relative paths only. Packages
// are imported statically, or through the module-scope `require` the bundler
// inlines (lockfile.ts, semver.ts) — never through a handle. Handles anchored
// elsewhere (a workspace or vendor path: tsFacility, grammarFacility, the TS
// sidecar) are deliberate out-of-bundle resolution and are not scanned.
{
  const { builtinModules } = await import('node:module');
  const builtin = new Set(builtinModules);
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) {
        // Bundled skill payloads ship as text, never as part of the module graph.
        if (full === resolve(SRC, 'skills', 'bundled')) continue;
        walk(full);
      } else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name)) {
        sources.push(full);
      }
    }
  };
  walk(SRC);
  const offenders: string[] = [];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('createRequire(')) continue;
    const handles = new Set(
      [...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^\n;]*\bcreateRequire\(\s*import\.meta\.url\s*\)/g)].map((m) => m[1] as string),
    );
    for (const handle of handles) {
      const call = new RegExp(`(?<![\\w$.])${handle.replace(/\$/g, '\\$')}\\(\\s*(['"])([^'"]+)\\1\\s*\\)`, 'g');
      for (const m of text.matchAll(call)) {
        const spec = m[2] as string;
        const bare = !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:') && !builtin.has(spec);
        if (bare) offenders.push(`${file.slice(ROOT.length + 1)}: ${handle}('${spec}')`);
      }
    }
  }
  if (offenders.length > 0) {
    console.error(
      'BUILD FAILED: a package is required at RUNTIME through a createRequire(import.meta.url) handle —\n' +
        'the bundler cannot inline it, and the artifact dies with MODULE_NOT_FOUND wherever no node_modules sits beside it:\n' +
        offenders.map((o) => `  ${o}`).join('\n') +
        '\n    → import the package statically, or call the module-scope `require` the bundler inlines (BUILD-NOTES.md §undici).\n',
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Post-build: vendor a ripgrep binary next to the bundle.
//
// LOAD-BEARING. The runtime resolver (src/utils/ripgrep.ts) computes a
// `builtin` rg path of `dist/vendor/ripgrep/<arch>-<platform>/rg` (`rg.exe` on
// win32) and spawns it for every Glob/Grep / file-search. Because this build is
// a plain Bun.build ESM bundle (NOT `bun --compile`), neither the
// npm-vendored-rg layout NOR the embedded (bun-internal, argv0='rg') path
// applies, and nothing else copies an rg into place. Without this step the
// resolver points at a file that was never produced and every search spawn
// fails with ENOENT (the system-rg fallback only fires when a real `rg` is on
// PATH, which is not guaranteed). So: produce exactly what the resolver expects.
//
// Source binary, in priority order:
//   1. @vscode/ripgrep (devDependency) — its postinstall downloads a
//      platform-matched rg; we copy from `require('@vscode/ripgrep').rgPath`.
//   2. a system rg, if present (/opt/homebrew/bin/rg, then `which rg`).
//   3. NEITHER — the build FAILS (a "successful" build may not ship with
//      Glob/Grep broken). `MERCURY_BUILD_ALLOW_NO_RG=1` is the explicit
//      degraded-developer-build opt-in: the build then succeeds, the manifest
//      records search as unavailable, and the runtime suppresses Glob/Grep
//      from the tool catalog (searchToolsAvailability in src/utils/ripgrep.ts).
//      `MERCURY_BUILD_NO_VENDOR_RG=1` is a proof seam that forces the
//      no-binary condition regardless of what this machine has.
const rgRelPath = `vendor/ripgrep/${process.arch}-${process.platform}/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`;
let rgVendored = false;
let rgSourceLabel = '';
{
  const rgDest = resolve(OUT, rgRelPath);
  const rgDestDir = resolve(rgDest, '..');

  // Resolve a source rg binary by the documented priority.
  let rgSource: string | null = null;
  const forceNoRg = process.env.MERCURY_BUILD_NO_VENDOR_RG === '1';

  // (1) @vscode/ripgrep — the postinstall fetches a platform-matched binary.
  if (!forceNoRg) {
    try {
      const req = createRequire(import.meta.url);
      const candidate = req('@vscode/ripgrep').rgPath as string;
      if (candidate && statSync(candidate).isFile()) {
        rgSource = candidate;
        rgSourceLabel = '@vscode/ripgrep';
      }
    } catch {
      /* package absent / postinstall didn't run — fall through */
    }
  }

  // (2) system rg — Homebrew's known path first, then PATH via `which`.
  if (!rgSource && !forceNoRg) {
    const systemCandidates: string[] = ['/opt/homebrew/bin/rg'];
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const found = execFileSync(whichCmd, ['rg'], { encoding: 'utf8' })
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      systemCandidates.push(...found);
    } catch {
      /* no rg on PATH */
    }
    for (const c of systemCandidates) {
      try {
        if (statSync(c).isFile()) {
          rgSource = c;
          rgSourceLabel = `system rg (${c})`;
          break;
        }
      } catch {
        /* not this one */
      }
    }
  }

  // (3) copy it into place, or fail — degraded output needs the explicit opt-in.
  if (rgSource) {
    mkdirSync(rgDestDir, { recursive: true });
    copyFileSync(rgSource, rgDest);
    chmodSync(rgDest, 0o755);
    rgVendored = true;
    console.log(`VENDORED ripgrep from ${rgSourceLabel}\n  -> ${rgDest}`);
  } else if (process.env.MERCURY_BUILD_ALLOW_NO_RG === '1') {
    console.warn(
      '\n' +
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
        '!! DEGRADED BUILD (MERCURY_BUILD_ALLOW_NO_RG=1): no ripgrep vendored.\n' +
        `!! Expected output: ${rgDest}\n` +
        '!! manifest.json records search as unavailable; the runtime suppresses\n' +
        '!! Glob/Grep from the tool catalog until an rg is provided. Fix by either:\n' +
        '!!   - `bun add -d @vscode/ripgrep` (downloads a platform rg), or\n' +
        '!!   - installing ripgrep so `rg` is on PATH (e.g. `brew install ripgrep`),\n' +
        '!!     then re-run `bun run build.ts`.\n' +
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n',
    );
  } else {
    console.error(
      'BUILD FAILED: no ripgrep binary could be vendored.\n' +
        `  Expected output: ${rgDest}\n` +
        '  Neither @vscode/ripgrep (devDependency) nor a system rg was found, and\n' +
        '  without it every Glob/Grep spawn fails ENOENT. Fix by either:\n' +
        '    - `bun add -d @vscode/ripgrep` (downloads a platform rg), or\n' +
        '    - installing ripgrep so `rg` is on PATH (e.g. `brew install ripgrep`).\n' +
        '  To intentionally produce a degraded developer build without search,\n' +
        '  re-run with MERCURY_BUILD_ALLOW_NO_RG=1 (manifest.json will mark search\n' +
        '  unavailable and the runtime will suppress Glob/Grep).',
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Post-build: vendor the pinned debugpy distribution next to the bundle
//. OPTIONAL, unlike ripgrep: a missing vendor input degrades
// the manifest honestly (`degraded: ['python-debugger']`) and the runtime
// keeps its installed-module fallback — the build never touches the network.
// The vendor cache is reproduced from vendor/debugpy.lock.json by the
// explicit command `bun run scripts/vendor/fetch-debugpy.ts`; this step
// consumes ONLY those known local bytes after re-verifying the cache's own
// manifest against the lock. `MERCURY_BUILD_NO_VENDOR_DEBUGPY=1` is the proof
// seam that forces the degraded condition regardless of the cache state.
const debugpyRelPath = 'vendor/debugpy';
let debugpyVendored = false;
let debugpyMeta: { version: string; wheel: string; sha256: string } | null = null;
{
  const debugpyDest = resolve(OUT, debugpyRelPath);
  rmSync(debugpyDest, { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_DEBUGPY === '1';
  const lockPath = resolve(ROOT, 'vendor', 'debugpy.lock.json');
  const extractedDir = resolve(ROOT, 'vendor', 'debugpy', 'extracted');
  const vendorManifestPath = resolve(extractedDir, '.vendor-manifest.json');
  if (!forceNo && statSync(lockPath, { throwIfNoEntry: false })?.isFile() && statSync(vendorManifestPath, { throwIfNoEntry: false })?.isFile()) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { version: string; wheel: string; sha256: string; adapterEntry: string };
      const vman = JSON.parse(readFileSync(vendorManifestPath, 'utf8')) as { version: string; wheelSha256: string };
      if (vman.version === lock.version && vman.wheelSha256 === lock.sha256 && statSync(resolve(extractedDir, lock.adapterEntry, '__main__.py'), { throwIfNoEntry: false })?.isFile()) {
        const { cpSync } = await import('node:fs');
        cpSync(extractedDir, debugpyDest, { recursive: true });
        debugpyVendored = true;
        debugpyMeta = { version: lock.version, wheel: lock.wheel, sha256: lock.sha256 };
        console.log(`VENDORED debugpy ${lock.version} (pinned wheel, sha256-verified cache)\n  -> ${debugpyDest}`);
      } else {
        // GUARD (vendor-staleness law): a PRESENT cache that mismatches the
        // lock is a re-pinned lock whose fetch never ran — the class that
        // silently shipped a degraded artifact until someone read the build
        // log. Mismatch ⇒ the build FAILS naming the fetch command; ABSENCE
        // (fresh clone, no cache at all) keeps the honest degrade below — a
        // clone still builds. (The ALLOWED_LAZY_BARE guard-comment
        // discipline: the distinction is the law, state it where it binds.)
        console.error(
          'BUILD FAILED: vendor/debugpy cache does not match vendor/debugpy.lock.json ' +
            `(cache ${vman.version}, lock ${lock.version}) — the lock was re-pinned without refetching.\n` +
            '  remedy: bun run scripts/vendor/fetch-debugpy.ts   (then rebuild)\n' +
            '  (a missing cache degrades honestly instead — only a PRESENT-but-wrong cache fails the build)',
        );
        process.exit(1);
      }
    } catch (e) {
      console.error(
        `BUILD FAILED: vendor/debugpy cache present but unreadable (${String(e)}) — ` +
          'refetch it: bun run scripts/vendor/fetch-debugpy.ts (a missing cache degrades honestly instead)',
      );
      process.exit(1);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_DEBUGPY=1 — debugpy NOT vendored (degraded: python-debugger; proof seam).');
  } else {
    console.warn('no debugpy vendor cache — the artifact ships WITHOUT the bundled Python debug adapter (degraded: python-debugger; runtime falls back to an installed debugpy). Prepare it: bun run scripts/vendor/fetch-debugpy.ts');
  }
}

// ---------------------------------------------------------------------------
// Post-build: vendor the pinned Pyright language server next to the bundle
//. Same discipline as debugpy: OPTIONAL (absence ⇒ honest
// degraded manifest + runtime PATH fallback), consumes ONLY the local
// sha512-verified cache reproduced by `bun run scripts/vendor/fetch-pyright.ts`.
// Pyright is pure JS under Mercury's node prerequisite — it analyses the
// operator's selected Python environment; no Python runtime is bundled.
// `MERCURY_BUILD_NO_VENDOR_PYRIGHT=1` forces the degraded condition.
const pyrightRelPath = 'vendor/pyright';
let pyrightVendored = false;
let pyrightMeta: { version: string; tarball: string; sha512: string } | null = null;
{
  const pyrightDest = resolve(OUT, pyrightRelPath);
  rmSync(pyrightDest, { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_PYRIGHT === '1';
  const lockPath = resolve(ROOT, 'vendor', 'pyright.lock.json');
  const extractedDir = resolve(ROOT, 'vendor', 'pyright', 'extracted');
  const vendorManifestPath = resolve(extractedDir, '.vendor-manifest.json');
  if (!forceNo && statSync(lockPath, { throwIfNoEntry: false })?.isFile() && statSync(vendorManifestPath, { throwIfNoEntry: false })?.isFile()) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { version: string; tarball: string; sha512: string; serverEntry: string };
      const vman = JSON.parse(readFileSync(vendorManifestPath, 'utf8')) as { version: string; tarballSha512: string };
      if (vman.version === lock.version && vman.tarballSha512 === lock.sha512 && statSync(resolve(extractedDir, lock.serverEntry), { throwIfNoEntry: false })?.isFile()) {
        const { cpSync } = await import('node:fs');
        cpSync(extractedDir, pyrightDest, { recursive: true });
        pyrightVendored = true;
        pyrightMeta = { version: lock.version, tarball: lock.tarball, sha512: lock.sha512 };
        console.log(`VENDORED pyright ${lock.version} (pinned npm tarball, sha512-verified cache)\n  -> ${pyrightDest}`);
      } else {
        // GUARD (vendor-staleness law — the outage this ratchet closes): the
        // 1.1.411→1.1.413 re-pin landed without its fetch, every later build
        // warned "SKIPPED (degraded: python-intelligence)" into an unread
        // log, and the deployed product shipped with NO Python language
        // server. Mismatch ⇒ FAIL naming the fetch command; ABSENCE (fresh
        // clone) keeps the honest degrade below — a clone still builds.
        console.error(
          'BUILD FAILED: vendor/pyright cache does not match vendor/pyright.lock.json ' +
            `(cache ${vman.version}, lock ${lock.version}) — the lock was re-pinned without refetching.\n` +
            '  remedy: bun run scripts/vendor/fetch-pyright.ts   (then rebuild)\n' +
            '  (a missing cache degrades honestly instead — only a PRESENT-but-wrong cache fails the build)',
        );
        process.exit(1);
      }
    } catch (e) {
      console.error(
        `BUILD FAILED: vendor/pyright cache present but unreadable (${String(e)}) — ` +
          'refetch it: bun run scripts/vendor/fetch-pyright.ts (a missing cache degrades honestly instead)',
      );
      process.exit(1);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_PYRIGHT=1 — pyright NOT vendored (degraded: python-intelligence; proof seam).');
  } else {
    console.warn('no pyright vendor cache — the artifact ships WITHOUT the bundled Python language server (degraded: python-intelligence; runtime falls back to a PATH pyright-langserver). Prepare it: bun run scripts/vendor/fetch-pyright.ts');
  }
}

// ---------------------------------------------------------------------------
// Post-build: vendor the pinned js-debug DAP server next to the bundle
// (the Node/TypeScript debug lane). Same discipline as debugpy/pyright:
// OPTIONAL (absence ⇒ honest degraded manifest; the runtime keeps its
// MERCURY_JS_DEBUG_DAP override and legacy ~/.js-debug unpack fallbacks),
// consumes ONLY the local sha512-verified cache reproduced by
// `bun run scripts/vendor/fetch-js-debug.ts`. js-debug is pure JS under
// Mercury's node prerequisite (the DAP server rides `node`), and it is a
// MULTI-SESSION adapter — dapClient's child-session road drives it.
// `MERCURY_BUILD_NO_VENDOR_JSDEBUG=1` forces the degraded condition.
const jsDebugRelPath = 'vendor/js-debug';
let jsDebugVendored = false;
let jsDebugMeta: { version: string; tarball: string; sha512: string } | null = null;
{
  const jsDebugDest = resolve(OUT, jsDebugRelPath);
  rmSync(jsDebugDest, { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_JSDEBUG === '1';
  const lockPath = resolve(ROOT, 'vendor', 'js-debug.lock.json');
  const extractedDir = resolve(ROOT, 'vendor', 'js-debug', 'extracted');
  const vendorManifestPath = resolve(extractedDir, '.vendor-manifest.json');
  if (!forceNo && statSync(lockPath, { throwIfNoEntry: false })?.isFile() && statSync(vendorManifestPath, { throwIfNoEntry: false })?.isFile()) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { version: string; tarball: string; sha512: string; serverEntry: string };
      const vman = JSON.parse(readFileSync(vendorManifestPath, 'utf8')) as { version: string; tarballSha512: string };
      if (vman.version === lock.version && vman.tarballSha512 === lock.sha512 && statSync(resolve(extractedDir, lock.serverEntry), { throwIfNoEntry: false })?.isFile()) {
        const { cpSync } = await import('node:fs');
        cpSync(extractedDir, jsDebugDest, { recursive: true });
        // THE MODULE-CLASS FENCE: upstream's tarball ships NO package.json,
        // so node classes the CJS dapDebugServer.js bundle by the NEAREST
        // ANCESTOR package.json — a type:module scope above the tree (this
        // repo's own, or a stray one above an operator's config home) loads
        // it as ESM and it dies at boot ("Dynamic require of 'fs' is not
        // supported"). The one-line fence makes the tree self-classifying
        // everywhere. Written at the BUILD step, never into the extraction
        // (the cache stays pure upstream bytes; the lock's determinism
        // census stands).
        writeFileSync(resolve(jsDebugDest, 'package.json'), '{"type":"commonjs"}\n');
        jsDebugVendored = true;
        jsDebugMeta = { version: lock.version, tarball: lock.tarball, sha512: lock.sha512 };
        console.log(`VENDORED js-debug ${lock.version} (pinned release asset, sha512-verified cache; module-class fence written)\n  -> ${jsDebugDest}`);
      } else {
        // GUARD (vendor-staleness law — the debugpy/pyright ratchet applied
        // at birth): a PRESENT cache that mismatches the lock is a re-pinned
        // lock whose fetch never ran — the class that silently shipped a
        // degraded artifact until someone read the build log. Mismatch ⇒
        // FAIL naming the fetch command; ABSENCE (fresh clone) keeps the
        // honest degrade below — a clone still builds.
        console.error(
          'BUILD FAILED: vendor/js-debug cache does not match vendor/js-debug.lock.json ' +
            `(cache ${vman.version}, lock ${lock.version}) — the lock was re-pinned without refetching.\n` +
            '  remedy: bun run scripts/vendor/fetch-js-debug.ts   (then rebuild)\n' +
            '  (a missing cache degrades honestly instead — only a PRESENT-but-wrong cache fails the build)',
        );
        process.exit(1);
      }
    } catch (e) {
      console.error(
        `BUILD FAILED: vendor/js-debug cache present but unreadable (${String(e)}) — ` +
          'refetch it: bun run scripts/vendor/fetch-js-debug.ts (a missing cache degrades honestly instead)',
      );
      process.exit(1);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_JSDEBUG=1 — js-debug NOT vendored (degraded: js-debugger; proof seam).');
  } else {
    console.warn('no js-debug vendor cache — the artifact ships WITHOUT the bundled Node/TS debug adapter (degraded: js-debugger; runtime falls back to MERCURY_JS_DEBUG_DAP or the ~/.js-debug unpack). Prepare it: bun run scripts/vendor/fetch-js-debug.ts');
  }
}

// ---------------------------------------------------------------------------
// Post-build: vendor the pinned Node RUNTIME beside the bundle — the fifth
// pack: a release install needs no Node on the machine. Same discipline as
// debugpy/pyright/js-debug: OPTIONAL (absence ⇒ honest degraded manifest;
// the launchers fall back to MERCURY_NODE or a PATH node inside the
// supported range), consumes ONLY the HOST platform's sha256-verified cache
// reproduced by `bun run scripts/vendor/fetch-node.ts`. The pack sits at
// the FIXED path vendor/node (bin/node · node.exe) so every launcher finds
// it without knowing the platform — the host-built rg beside it already
// makes a dist host-bound. `MERCURY_BUILD_NO_VENDOR_NODE=1` forces the
// degraded condition.
const { RUNTIME_PACK_PATH: nodeRelPath, nodePackPlatform, runtimeBinaryFor } = await import('./src/services/privateChannel/vendoredRuntime.ts');
let nodeVendored = false;
let nodeMeta: { version: string; platform: string; license: string; archiveSha256: string; binary: string; binarySha256: string } | null = null;
{
  const nodeDest = resolve(OUT, nodeRelPath);
  rmSync(nodeDest, { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_NODE === '1';
  const hostPlatform = nodePackPlatform(process.platform, process.arch);
  const lockPath = resolve(ROOT, 'vendor', 'node.lock.json');
  const extractedDir = hostPlatform ? resolve(ROOT, 'vendor', 'node', 'extracted', hostPlatform) : null;
  const vendorManifestPath = extractedDir ? resolve(extractedDir, '.vendor-manifest.json') : null;
  if (!forceNo && hostPlatform && extractedDir && vendorManifestPath && statSync(lockPath, { throwIfNoEntry: false })?.isFile() && statSync(vendorManifestPath, { throwIfNoEntry: false })?.isFile()) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { version: string; license: string; platforms: Record<string, { sha256: string }> };
      const vman = JSON.parse(readFileSync(vendorManifestPath, 'utf8')) as { version: string; platform: string; archiveSha256: string; binary: string };
      const pinned = lock.platforms[hostPlatform];
      const binary = runtimeBinaryFor(hostPlatform);
      const binaryPath = resolve(extractedDir, ...binary.split('/'));
      if (pinned && vman.version === lock.version && vman.platform === hostPlatform && vman.archiveSha256 === pinned.sha256 && vman.binary === binary && statSync(binaryPath, { throwIfNoEntry: false })?.isFile()) {
        const { cpSync } = await import('node:fs');
        cpSync(extractedDir, nodeDest, { recursive: true });
        const shipped = resolve(nodeDest, ...binary.split('/'));
        if (process.platform !== 'win32') chmodSync(shipped, 0o755);
        nodeVendored = true;
        nodeMeta = {
          version: lock.version,
          platform: hostPlatform,
          license: lock.license,
          archiveSha256: pinned.sha256,
          binary,
          binarySha256: createHash('sha256').update(readFileSync(shipped)).digest('hex'),
        };
        console.log(`VENDORED node ${lock.version} ${hostPlatform} (pinned nodejs.org archive, sha256-verified cache)\n  -> ${nodeDest}`);
      } else {
        // GUARD (vendor-staleness law — the debugpy/pyright ratchet applied
        // at birth): a PRESENT cache that mismatches the lock is a re-pinned
        // lock whose fetch never ran. Mismatch ⇒ FAIL naming the fetch
        // command; ABSENCE (fresh clone) keeps the honest degrade below.
        console.error(
          'BUILD FAILED: vendor/node cache does not match vendor/node.lock.json ' +
            `(cache ${vman.version} ${vman.platform}, lock ${lock.version} ${hostPlatform}) — the lock was re-pinned without refetching.\n` +
            '  remedy: bun run scripts/vendor/fetch-node.ts   (then rebuild)\n' +
            '  (a missing cache degrades honestly instead — only a PRESENT-but-wrong cache fails the build)',
        );
        process.exit(1);
      }
    } catch (e) {
      console.error(
        `BUILD FAILED: vendor/node cache present but unreadable (${String(e)}) — ` +
          'refetch it: bun run scripts/vendor/fetch-node.ts (a missing cache degrades honestly instead)',
      );
      process.exit(1);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_NODE=1 — node runtime NOT vendored (degraded: runtime; proof seam).');
  } else if (!hostPlatform) {
    console.warn(`nodejs.org publishes no runtime archive Mercury vendors for ${process.platform}/${process.arch} — the artifact ships WITHOUT a bundled Node runtime (degraded: runtime; the launchers run MERCURY_NODE or a PATH node inside the supported range).`);
  } else {
    console.warn('no node vendor cache — the artifact ships WITHOUT the bundled Node runtime (degraded: runtime; the launchers run MERCURY_NODE or a PATH node inside the supported range). Prepare it: bun run scripts/vendor/fetch-node.ts');
  }
}

// Post-build: vendor the VOICE CAPTURE pack beside the bundle — the sixth
// pack, BUILT rather than fetched: a Node-API addon over the platform's
// own audio layer, compiled from native/voice by
// `bun run scripts/vendor/build-voice.ts` (cargo) into vendor/voice/<platform>
// with every linked crate's licence beside it. Same discipline as the
// fetched packs: OPTIONAL (absence ⇒ honest degraded manifest `voice-input`;
// the runtime falls back to a PATH recorder or the no-backend receipt), the
// HOST platform's pack only, consumed only when its manifest agrees with
// its bytes AND with the Rust sources it claims to be built from — a
// PRESENT pack older than native/voice is the re-edited-source-without-a-
// rebuild class and fails the build naming the command.
// `MERCURY_BUILD_NO_VENDOR_VOICE=1` forces the degraded condition.
const { VOICE_PACK_PATH: voiceRelPath, VOICE_NATIVE_PATH: voiceNativePath, voicePackPlatform, checkVoicePackDir, voiceSourceTreeDigest } = await import('./src/services/voice/voicePack.ts');
let voiceVendored = false;
let voiceMeta: { version: string; platform: string; addon: string; addonSha256: string; crates: number } | null = null;
{
  const voiceDest = resolve(OUT, voiceRelPath);
  rmSync(voiceDest, { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_VOICE === '1';
  const hostPlatform = voicePackPlatform();
  const packDir = resolve(ROOT, voiceRelPath, hostPlatform);
  const nativeDir = resolve(ROOT, voiceNativePath);
  if (!forceNo && statSync(resolve(packDir, '.vendor-manifest.json'), { throwIfNoEntry: false })?.isFile()) {
    const check = checkVoicePackDir(packDir, { digest: true, platform: hostPlatform });
    const sourcesNow = statSync(nativeDir, { throwIfNoEntry: false })?.isDirectory() ? voiceSourceTreeDigest(nativeDir) : null;
    if (check.state === 'ok' && sourcesNow !== null && check.manifest.sourceTreeDigest === sourcesNow) {
      const { cpSync } = await import('node:fs');
      cpSync(packDir, resolve(voiceDest, hostPlatform), { recursive: true });
      voiceVendored = true;
      voiceMeta = {
        version: check.manifest.version,
        platform: hostPlatform,
        addon: check.manifest.addon,
        addonSha256: check.manifest.addonSha256,
        crates: check.manifest.crates.length,
      };
      console.log(`VENDORED voice pack ${check.manifest.version} ${hostPlatform} (built from ${voiceNativePath}, ${check.manifest.crates.length} crate licences)\n  -> ${resolve(voiceDest, hostPlatform)}`);
    } else {
      // GUARD (vendor-staleness law): a PRESENT pack that disagrees with
      // its manifest, or was built from other Rust sources than the tree
      // carries, is a stale cache. Mismatch ⇒ FAIL naming the build
      // command; ABSENCE keeps the honest degrade below.
      const why = check.state !== 'ok' ? check.note : sourcesNow === null ? `${voiceNativePath} is absent` : `the pack was built from other sources than ${voiceNativePath} now holds`;
      console.error(
        `BUILD FAILED: vendor/voice/${hostPlatform} pack is present but stale — ${why}.\n` +
          '  remedy: bun run scripts/vendor/build-voice.ts   (then rebuild)\n' +
          '  (a missing pack degrades honestly instead — only a PRESENT-but-wrong pack fails the build)',
      );
      process.exit(1);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_VOICE=1 — voice pack NOT vendored (degraded: voice-input; proof seam).');
  } else {
    console.warn(`no voice pack for ${hostPlatform} — the artifact ships WITHOUT the voice capture addon (degraded: voice-input; the runtime falls back to sox/arecord/ffmpeg on PATH, else the no-backend receipt). Prepare it: bun run scripts/vendor/build-voice.ts (needs cargo)`);
  }
}

// Post-build: vendor the typescript COMPILER beside the bundle (
// — the structural plane's parser facility on projects without
// their own typescript). Sourced from the repo's own pinned devDependency
// (node_modules/typescript — always present at build time), single file
// lib/typescript.js + LICENSE + a version stamp. OPTIONAL: absence ⇒
// honest degraded manifest; the runtime prefers the WORKSPACE typescript
// anyway (the tsFacility resolution order), so a degraded artifact still
// serves any project that carries its own compiler.
// `MERCURY_BUILD_NO_VENDOR_TYPESCRIPT=1` forces the degraded condition.
const typescriptRelPath = 'vendor/typescript';
let typescriptVendored = false;
let typescriptVersion: string | null = null;
{
  const tsDest = resolve(OUT, typescriptRelPath);
  rmSync(tsDest, { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_TYPESCRIPT === '1';
  const tsLib = resolve(ROOT, 'node_modules', 'typescript', 'lib', 'typescript.js');
  const tsPkg = resolve(ROOT, 'node_modules', 'typescript', 'package.json');
  const tsLicense = resolve(ROOT, 'node_modules', 'typescript', 'LICENSE.txt');
  if (!forceNo && statSync(tsLib, { throwIfNoEntry: false })?.isFile()) {
    try {
      const { mkdirSync: mkd, copyFileSync } = await import('node:fs');
      mkd(tsDest, { recursive: true });
      copyFileSync(tsLib, resolve(tsDest, 'typescript.js'));
      if (statSync(tsLicense, { throwIfNoEntry: false })?.isFile()) {
        copyFileSync(tsLicense, resolve(tsDest, 'LICENSE.txt'));
      }
      typescriptVersion = (JSON.parse(readFileSync(tsPkg, 'utf8')) as { version: string }).version;
      writeFileSync(
        resolve(tsDest, 'vendor.json'),
        JSON.stringify({ package: 'typescript', version: typescriptVersion, source: 'repo devDependency' }, null, 2) + '\n',
      );
      // The compiler is CJS. A "type":"module" package.json ABOVE dist (the
      // repo's own, when dist sits in-tree) would make require() evaluate it
      // as ESM (empty namespace / ReferenceError on modern node) — scope the
      // vendor dir to CommonJS explicitly.
      writeFileSync(resolve(tsDest, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
      typescriptVendored = true;
      console.log(`VENDORED typescript ${typescriptVersion} (compiler single-file, from the pinned devDependency)\n  -> ${tsDest}`);
    } catch (e) {
      console.warn(`typescript vendor copy failed — SKIPPED (degraded: structural-intelligence): ${String(e)}`);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_TYPESCRIPT=1 — typescript NOT vendored (degraded: structural-intelligence; proof seam).');
  } else {
    console.warn('node_modules/typescript missing — the artifact ships WITHOUT the vendored compiler (degraded: structural-intelligence; the runtime still uses any WORKSPACE typescript).');
  }
}

// Post-build: vendor the tree-sitter WASM grammar engine beside the bundle
//. Sourced
// from the repo's own pinned devDependency (@vscode/tree-sitter-wasm):
// the web-tree-sitter loader + runtime wasm + exactly the grammar wasms the
// language table (grammarFacility POLYGLOT_LANGUAGES) names. WASM is
// platform-independent — one asset set serves every platform artifact; the
// artifact prover (scripts/structure-tools/prove-structure-tools-artifact.ts)
// fails the gate when a built dist lacks it.
// `MERCURY_BUILD_NO_VENDOR_TREESITTER=1` forces the degraded condition
// (degraded: structure-polyglot; the JS/TS select lane is unaffected).
const treesitterRelPath = 'vendor/treesitter';
let treesitterVendored = false;
let treesitterVersion: string | null = null;
let grammarPackVendored = false;
let grammarPackVersion: string | null = null;
let grammarPackMissing: string[] = [];
{
  const tsitDest = resolve(OUT, treesitterRelPath);
  rmSync(tsitDest, { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_TREESITTER === '1';
  const srcDir = resolve(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm');
  const wasmDir = resolve(srcDir, 'wasm');
  // The engine files come from the ONE declarative registry —
  // the same module the runtime routes with; the old hand-kept copy is dead.
  // Two sources since: 'vscode-pack' wasms from the repo
  // devDependency, 'grammar-pack' wasms from the cherry-picked, lock-pinned
  // tree-sitter-wasms cache (vendor/grammars.lock.json is the truth; the
  // build re-verifies every pack wasm's sha256 — it never trusts cache
  // bytes it did not hash).
  const { GRAMMAR_REGISTRY, GRAMMAR_ENGINE_RUNTIME_FILES } = await import('./src/services/structure/grammarRegistry.ts');
  const vscodeWasms = GRAMMAR_REGISTRY.filter(g => (g.source ?? 'vscode-pack') === 'vscode-pack').map(g => g.wasm);
  const packWasms = GRAMMAR_REGISTRY.filter(g => g.source === 'grammar-pack').map(g => g.wasm);
  const runtimeFiles = [...GRAMMAR_ENGINE_RUNTIME_FILES];
  const packDir = resolve(ROOT, 'vendor', 'grammars', 'extracted');
  const packLockPath = resolve(ROOT, 'vendor', 'grammars.lock.json');
  if (!forceNo && statSync(resolve(wasmDir, 'tree-sitter.js'), { throwIfNoEntry: false })?.isFile()) {
    try {
      const { mkdirSync: mkd, copyFileSync } = await import('node:fs');
      mkd(tsitDest, { recursive: true });
      const missing: string[] = [];
      for (const file of [...runtimeFiles, ...vscodeWasms]) {
        const from = resolve(wasmDir, file);
        if (statSync(from, { throwIfNoEntry: false })?.isFile()) {
          copyFileSync(from, resolve(tsitDest, file));
        } else {
          missing.push(file);
        }
      }
      if (missing.length > 0) {
        throw new Error(`the pinned @vscode/tree-sitter-wasm is missing: ${missing.join(', ')}`);
      }
      // Grammar-pack second source: every file sha256-verified against the
      // checked-in lock; a missing/stale cache degrades HONESTLY (the
      // vscode-pack engine still ships whole) rather than failing the build.
      const shippedPack: string[] = [];
      const forceNoPack = process.env.MERCURY_BUILD_NO_VENDOR_GRAMMARPACK === '1'; // proof seam (debugpy-class)
      const packLock = !forceNoPack && statSync(packLockPath, { throwIfNoEntry: false })?.isFile()
        ? (JSON.parse(readFileSync(packLockPath, 'utf8')) as {
            version: string;
            grammars: Array<{ wasm: string; sha256: string; upstream: Record<string, string> }>;
          })
        : null;
      if (packLock && packWasms.length > 0) {
        grammarPackVersion = packLock.version;
        const lockedSha = new Map(packLock.grammars.map(g => [g.wasm, g.sha256]));
        // GUARD (vendor-staleness law, the debugpy/pyright ratchet applied
        // per-file): a cache file PRESENT with the wrong sha is a re-pinned
        // lock whose fetch never ran — FAIL naming the fetch command; a
        // file simply absent keeps the honest degrade below.
        const stalePack: string[] = [];
        for (const wasm of packWasms) {
          const from = resolve(packDir, wasm);
          const want = lockedSha.get(wasm);
          const bytes = statSync(from, { throwIfNoEntry: false })?.isFile() ? readFileSync(from) : null;
          if (bytes && want && createHash('sha256').update(bytes).digest('hex') === want) {
            writeFileSync(resolve(tsitDest, wasm), bytes);
            shippedPack.push(wasm);
          } else if (bytes && want) {
            stalePack.push(wasm);
          }
        }
        if (stalePack.length > 0) {
          console.error(
            `BUILD FAILED: vendor/grammars cache is STALE against vendor/grammars.lock.json for: ${stalePack.join(', ')} — ` +
              'the lock was re-pinned without refetching.\n' +
              '  remedy: bun run scripts/vendor/fetch-grammars.ts   (then rebuild)\n' +
              '  (a missing cache file degrades honestly instead — only a PRESENT-but-wrong file fails the build)',
          );
          process.exit(1);
        }
        if (shippedPack.length === packWasms.length) {
          const packLicense = resolve(packDir, 'LICENSE');
          if (statSync(packLicense, { throwIfNoEntry: false })?.isFile()) {
            copyFileSync(packLicense, resolve(tsitDest, 'LICENSE.grammar-pack'));
          }
          // Per-grammar upstream licence provenance travels WITH the artifact.
          writeFileSync(
            resolve(tsitDest, 'GRAMMAR-NOTICES.json'),
            JSON.stringify(
              {
                pack: { package: 'tree-sitter-wasms', version: packLock.version, license: 'Unlicense (pack scripts only)' },
                grammars: packLock.grammars.map(g => ({ wasm: g.wasm, ...g.upstream })),
              },
              null,
              2,
            ) + '\n',
          );
          grammarPackVendored = true;
        }
      }
      grammarPackMissing = packWasms.filter(w => !shippedPack.includes(w));
      if (grammarPackMissing.length > 0) {
        console.warn(
          `grammar-pack cache missing/stale for: ${grammarPackMissing.join(', ')} — vendored WITHOUT them ` +
            '(degraded: structure-polyglot-extended; remedy: bun run scripts/vendor/fetch-grammars.ts, then rebuild)',
        );
      }
      const shippedWasms = GRAMMAR_REGISTRY.map(g => g.wasm).filter(
        w => vscodeWasms.includes(w) || shippedPack.includes(w),
      );
      const license = resolve(srcDir, 'LICENSE');
      if (statSync(license, { throwIfNoEntry: false })?.isFile()) {
        copyFileSync(license, resolve(tsitDest, 'LICENSE'));
      }
      treesitterVersion = (JSON.parse(readFileSync(resolve(srcDir, 'package.json'), 'utf8')) as { version: string }).version;
      writeFileSync(
        resolve(tsitDest, 'vendor.json'),
        JSON.stringify(
          {
            package: '@vscode/tree-sitter-wasm',
            version: treesitterVersion,
            source: 'repo devDependency',
            grammars: shippedWasms,
            grammarPack: packWasms.length > 0
              ? {
                  package: 'tree-sitter-wasms',
                  version: grammarPackVersion,
                  vendored: grammarPackVendored,
                  grammars: shippedPack,
                }
              : undefined,
          },
          null,
          2,
        ) + '\n',
      );
      // The loader is UMD/CJS — scope the vendor dir to CommonJS so a
      // "type":"module" package.json above dist can never make require()
      // read it as an empty ESM namespace (bit the typescript vendor too).
      writeFileSync(resolve(tsitDest, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
      treesitterVendored = true;
      console.log(
        `VENDORED tree-sitter engine ${treesitterVersion} (${shippedWasms.length} grammar wasms` +
          `${grammarPackVendored ? `, incl. ${shippedPack.length} from tree-sitter-wasms ${grammarPackVersion}` : ''})\n  -> ${tsitDest}`,
      );
    } catch (e) {
      rmSync(tsitDest, { recursive: true, force: true }); // never a TORN engine dir
      console.warn(`tree-sitter vendor copy failed — SKIPPED (degraded: structure-polyglot): ${String(e)}`);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_TREESITTER=1 — tree-sitter NOT vendored (degraded: structure-polyglot; proof seam).');
  } else {
    console.warn('node_modules/@vscode/tree-sitter-wasm missing — the artifact ships WITHOUT the polyglot grammar engine (degraded: structure-polyglot; the JS/TS select lane is unaffected).');
  }
}

// ---------------------------------------------------------------------------
// The SHIPPED provenance verifier:
// src/services/privateChannel/verifyArtifactStandalone.ts bundles to
// dist/verify-artifact.mjs — the ONE compiled verification implementation the
// release payload ships beside mercury.mjs (splash.mjs precedent). The
// launchers invoke it on interactive boots (warn-only), the packager imports
// it as the signing library, and /health runs the same source in-bundle — no
// twin implementations to drift. Built with the same define/minify seams so
// oracle-mode byte-comparison proofs stay deterministic.
{
  const verifier = await Bun.build({
    entrypoints: [resolve(SRC, 'services/privateChannel/verifyArtifactStandalone.ts')],
    outdir: OUT,
    naming: 'verify-artifact.mjs',
    target: 'node',
    format: 'esm',
    sourcemap: 'none',
    minify:
      process.env.MERCURY_BUILD_MINIFY === 'oracle'
        ? { whitespace: true, syntax: true, identifiers: false }
        : true,
    plugins: [mercuryPlugin],
    define: {
      MACRO: JSON.stringify(MACRO),
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
  });
  if (!verifier.success) {
    console.error('BUILD FAILED: verify-artifact.mjs did not build');
    for (const log of verifier.logs) console.error(log);
    process.exit(1);
  }
  // The verifier runs where the bundle runs (beside NO node_modules) — the
  // same self-containment law as mercury.mjs, with a stricter bar: no bare
  // imports at all, static or dynamic.
  const verifierText = readFileSync(resolve(OUT, 'verify-artifact.mjs'), 'utf8');
  const { builtinModules } = await import('node:module');
  const builtin = new Set(builtinModules);
  const bare = [
    ...new Set(
      new Bun.Transpiler({ loader: 'js' })
        .scanImports(verifierText)
        .filter((i) => !i.path.startsWith('node:') && !i.path.startsWith('./') && !i.path.startsWith('../') && !builtin.has(i.path))
        .map((i) => i.path),
    ),
  ];
  if (bare.length > 0) {
    console.error(`BUILD FAILED: verify-artifact.mjs is not self-contained (bare imports: ${bare.join(', ')})`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// The enter screen ships beside the bundle from the ORDINARY build: a direct
// `node dist/mercury.mjs` start resolves the splash asset beside itself first
// (the release payload's own shape — the packager ships the same pair as
// splash.mjs + splash-core.mjs), so a source build's dist is as self-contained
// as an archive. Plain copies of the canonical pair (assets/splash/): the
// driver imports './splash-core.mjs' beside itself, so both go or neither —
// a missing canonical file fails the build rather than shipping a torn pair.
const SPLASH_PAIR = [
  { src: resolve(ROOT, 'assets', 'splash', 'mercury-splash.mjs'), name: 'splash.mjs' },
  { src: resolve(ROOT, 'assets', 'splash', 'splash-core.mjs'), name: 'splash-core.mjs' },
] as const;
for (const member of SPLASH_PAIR) {
  if (!existsSync(member.src)) {
    console.error(`BUILD FAILED: ${member.src} missing — the enter screen ships as a pair beside mercury.mjs`);
    process.exit(1);
  }
  copyFileSync(member.src, resolve(OUT, member.name));
}

// ---------------------------------------------------------------------------
// The NOTICE stamp: every built JS
// artifact carries the composed NOTICE head — product identity, the
// operator's named text slots (omitted while undrafted; the operator drafts
// all licence wording), and the third-party attribution pointer. Stamped
// BEFORE the manifest is written so bundleBytes/bundleSha256 describe the
// shipped bytes; self-checked here (the build-time gate arm — a build may
// not print BUILD OK with a stale or missing stamp) and gated again by
// scripts/distribution/prove-notice-stamp.ts. Deterministic (version-only, no
// dates), so reproducible-build oracles are unaffected.
{
  const { stampNoticeOnSource, hasCurrentNoticeStamp } = await import('./src/constants/legalNotice.ts');
  for (const artifact of ['mercury.mjs', 'verify-artifact.mjs']) {
    const path = resolve(OUT, artifact);
    writeFileSync(path, stampNoticeOnSource(readFileSync(path, 'utf8'), MACRO_VERSION));
    if (!hasCurrentNoticeStamp(readFileSync(path, 'utf8'), MACRO_VERSION)) {
      console.error(`BUILD FAILED: ${artifact} does not carry the current NOTICE stamp after stamping`);
      process.exit(1);
    }
  }
}

// The bundle-start tree (computed above, BEFORE Bun.build) becomes durable
// only now, on the successful build.
if (buildTree) {
  writeFileSync(resolve(OUT, '.build-tree'), buildTree + '\n');
}

// ARTIFACT MANIFEST (dist/manifest.json) — the machine-readable record of
// what this build actually produced. Written ONLY on a fully successful build
// (a failed build leaves no manifest — absence means "do not ship"). Readers:
// the isolated-artifact proof asserts every claim against the real files, and
// operator tooling reads `search`/`degraded` for provenance. The RUNTIME tool
// catalog does not read this file — it probes the real binary state live
// (searchToolsAvailability), which agrees with the manifest by construction
// since both derive from the same vendored file.
const manifest = {
  // schema 2: the only delta from 1 is `bundle`'s value —
  // 'mercury.mjs'. The bump is deliberate: every manifest reader is forced
  // to be visited rather than silently accepting a renamed bundle under an
  // unchanged schema.
  schema: 2,
  name: 'mercury',
  version: MACRO_VERSION,
  buildTime: MACRO.BUILD_TIME,
  buildTree,
  bundle: 'mercury.mjs',
  bundleBytes: statSync(resolve(OUT, 'mercury.mjs')).size,
  // The candidate-tuple byte bind: the
  // manifest names the exact bundle bytes it describes. Before this,
  // BUNDLE-BYTE drift on a clean tree was unbound — dist/ is gitignored and
  // deploy-runtime trusted buildTree without hashing the bundle, so a
  // tampered/torn mercury.mjs deployed silently. deploy-runtime.sh now
  // recomputes and refuses a mismatch; the freeze record binds this field
  // beside releaseLayout.primary.sha256.
  bundleSha256: createHash('sha256').update(readFileSync(resolve(OUT, 'mercury.mjs'))).digest('hex'),
  node: NODE_SUPPORTED_RANGE,
  // No bare package imports remain in the bundle (zod inlined;
  // enforced above by the self-containment tripwire + the isolated proof).
  selfContained: true,
  search: rgVendored
    ? { vendored: true, path: rgRelPath, source: rgSourceLabel }
    : {
        vendored: false,
        path: rgRelPath,
        remedy:
          'install ripgrep (brew install ripgrep) or `bun add -d @vscode/ripgrep`, then re-run `bun run build.ts`',
      },
  pythonDebugger: debugpyVendored && debugpyMeta
    ? {
        vendored: true,
        path: debugpyRelPath,
        version: debugpyMeta.version,
        wheel: debugpyMeta.wheel,
        sha256: debugpyMeta.sha256,
        adapterEntry: 'debugpy/adapter',
      }
    : {
        vendored: false,
        path: debugpyRelPath,
        remedy:
          'prepare the pinned debugpy cache (`bun run scripts/vendor/fetch-debugpy.ts`), then re-run `bun run build.ts` — the runtime falls back to an installed debugpy module meanwhile',
      },
  pyright: pyrightVendored && pyrightMeta
    ? {
        vendored: true,
        path: pyrightRelPath,
        version: pyrightMeta.version,
        tarball: pyrightMeta.tarball,
        sha512: pyrightMeta.sha512,
        serverEntry: 'langserver.index.js',
      }
    : {
        vendored: false,
        path: pyrightRelPath,
        remedy:
          'prepare the pinned pyright cache (`bun run scripts/vendor/fetch-pyright.ts`), then re-run `bun run build.ts` — the runtime falls back to a PATH pyright-langserver meanwhile',
      },
  jsDebug: jsDebugVendored && jsDebugMeta
    ? {
        vendored: true,
        path: jsDebugRelPath,
        version: jsDebugMeta.version,
        tarball: jsDebugMeta.tarball,
        sha512: jsDebugMeta.sha512,
        serverEntry: 'src/dapDebugServer.js',
      }
    : {
        vendored: false,
        path: jsDebugRelPath,
        remedy:
          'prepare the pinned js-debug cache (`bun run scripts/vendor/fetch-js-debug.ts`), then re-run `bun run build.ts` — the runtime falls back to MERCURY_JS_DEBUG_DAP or the ~/.js-debug unpack meanwhile',
      },
  runtime: nodeVendored && nodeMeta
    ? {
        vendored: true,
        path: nodeRelPath,
        name: 'node',
        ...nodeMeta,
      }
    : {
        vendored: false,
        path: nodeRelPath,
        remedy:
          'prepare the pinned Node runtime cache (`bun run scripts/vendor/fetch-node.ts`), then re-run `bun run build.ts` — the launchers run MERCURY_NODE or a PATH node inside the supported range meanwhile',
      },
  // The enter screen beside the bundle (the pair copied above): a direct
  // `node dist/mercury.mjs` start resolves it here first, and the isolated
  // artifact proof holds the record to the real files.
  splash: {
    path: 'splash.mjs',
    core: 'splash-core.mjs',
    bytes: statSync(resolve(OUT, 'splash.mjs')).size,
    sha256: createHash('sha256').update(readFileSync(resolve(OUT, 'splash.mjs'))).digest('hex'),
  },
  voiceInput: voiceVendored && voiceMeta
    ? {
        vendored: true,
        path: `${voiceRelPath}/${voiceMeta.platform}`,
        version: voiceMeta.version,
        platform: voiceMeta.platform,
        addon: voiceMeta.addon,
        addonSha256: voiceMeta.addonSha256,
        crateLicences: voiceMeta.crates,
      }
    : {
        vendored: false,
        path: voiceRelPath,
        remedy:
          'build the voice capture pack (`bun run scripts/vendor/build-voice.ts`, needs cargo), then re-run `bun run build.ts` — the runtime falls back to sox/arecord/ffmpeg on PATH meanwhile, else /speak says no backend',
      },
  typescript: typescriptVendored && typescriptVersion
    ? {
        vendored: true,
        path: typescriptRelPath,
        version: typescriptVersion,
        compilerEntry: 'typescript.js',
      }
    : {
        vendored: false,
        path: typescriptRelPath,
        remedy:
          'restore node_modules/typescript (bun install), then re-run `bun run build.ts` — the runtime still resolves any WORKSPACE typescript meanwhile',
      },
  treeSitter: treesitterVendored && treesitterVersion
    ? {
        vendored: true,
        path: treesitterRelPath,
        version: treesitterVersion,
        loaderEntry: 'tree-sitter.js',
        grammarPack: grammarPackVendored && grammarPackVersion
          ? { vendored: true, package: 'tree-sitter-wasms', version: grammarPackVersion }
          : {
              vendored: false,
              missing: grammarPackMissing,
              remedy:
                'prepare the pinned grammar-pack cache (`bun run scripts/vendor/fetch-grammars.ts`), then re-run `bun run build.ts` — the vscode-pack grammars still ship; the pack-sourced languages answer unavailable meanwhile',
            },
      }
    : {
        vendored: false,
        path: treesitterRelPath,
        remedy:
          'restore node_modules/@vscode/tree-sitter-wasm (bun install), then re-run `bun run build.ts` — the polyglot pattern lane answers unavailable meanwhile; JS/TS select queries are unaffected',
      },
  // honesty: sharp's NATIVE binding is node_modules-resident
  // (@img/sharp-<platform>), NOT vendored — a clean-machine artifact loses
  // sixel/cells image DECODE at call time with sharp's own named error,
  // while the iterm/kitty native tiers still work (whole-file PNG, no
  // decode). Recorded here so the absence is a stated trade, not a silent
  // surprise; vendoring the binding per-platform is a measured follow-up.
  imageProcessing: {
    binding: 'node_modules-resident (sharp native)',
    selfContained: false,
    degradesTo: 'iterm/kitty native tiers + artifact links (sixel/cells need the binding)',
  },
  degraded: [
    ...(rgVendored ? [] : ['search']),
    ...(debugpyVendored ? [] : ['python-debugger']),
    ...(pyrightVendored ? [] : ['python-intelligence']),
    ...(jsDebugVendored ? [] : ['js-debugger']),
    ...(nodeVendored ? [] : ['runtime']),
    ...(voiceVendored ? [] : ['voice-input']),
    ...(typescriptVendored ? [] : ['structural-intelligence']),
    ...(treesitterVendored ? [] : ['structure-polyglot']),
    ...(treesitterVendored && !grammarPackVendored ? ['structure-polyglot-extended'] : []),
  ],
};
writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('BUILD OK');
for (const out of result.outputs) {
  console.log(`  ${out.path}  (${(out.size / 1024 / 1024).toFixed(2)} MiB)`);
}
console.log(`  ${resolve(OUT, 'manifest.json')}${rgVendored ? '' : '  (DEGRADED: search unavailable)'}`);
if (result.logs.length) {
  console.log(`\n${result.logs.length} warning(s):`);
  for (const log of result.logs) console.log('  ' + String(log).split('\n')[0]);
}
