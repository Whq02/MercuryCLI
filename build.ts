
import { resolve } from 'node:path';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = import.meta.dir;
const SRC = resolve(ROOT, 'src');
const OUT = resolve(ROOT, process.env.MERCURY_BUILD_OUTDIR ?? 'dist');

const { RELEASE_TARGETS, buildPlatformOf, isReleaseTarget, platformKey, releaseTargetFor, ripgrepPackageFor } = await import('./src/services/privateChannel/releaseTarget.ts');
const { resolvePlatformPackage } = await import('./scripts/vendor/platformPackages.ts');
const targetFlag = process.argv.indexOf('--target');
const TARGET_ARG = targetFlag === -1 ? null : (process.argv[targetFlag + 1] ?? '');
if (TARGET_ARG !== null && !isReleaseTarget(TARGET_ARG)) {
  console.error(`build.ts: --target wants one of ${RELEASE_TARGETS.join(', ')} (got ${TARGET_ARG || 'nothing'})`);
  process.exit(2);
}
const SHIP = TARGET_ARG === null ? { platform: process.platform, arch: process.arch } : buildPlatformOf(TARGET_ARG);
const SHIP_KEY = platformKey(SHIP.platform, SHIP.arch);
const HOST_KEY = platformKey(process.platform, process.arch);
const SHIP_RELEASE = releaseTargetFor(SHIP.platform, SHIP.arch);
const CROSS = SHIP_KEY !== HOST_KEY;
if (CROSS) console.log(`CROSS BUILD: shipping for ${SHIP_KEY} (${SHIP_RELEASE}) on a ${HOST_KEY} host — every platform-bound pack is the target's`);

const resolveBuildTime = (): string => {
  if (process.env.MERCURY_BUILD_TIME) return process.env.MERCURY_BUILD_TIME;
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (process.env.SOURCE_DATE_EPOCH && Number.isFinite(epoch)) {
    return new Date(epoch * 1000).toISOString();
  }
  return new Date().toISOString();
};

const STUB_MAP: Record<string, string> = {
  'color-diff-napi': resolve(SRC, 'native-ts/color-diff/index.ts'),
};

const PKG_JSON = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string; engines?: { node?: string }; repository?: { url?: string } };
const MACRO_VERSION = PKG_JSON.version;
const NODE_SUPPORTED_RANGE = PKG_JSON.engines?.node;
if (!NODE_SUPPORTED_RANGE) throw new Error('package.json engines.node missing — the manifest cannot record the supported Node range');
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
        }
      }
      return null;
    };
    build.onResolve({ filter: /^src\// }, (args) => {
      const abs = resolve(SRC, args.path.slice('src/'.length));
      const found = probe(abs);
      return found ? { path: found } : undefined;
    });

    const stubKeys = Object.keys(STUB_MAP);
    const stubFilter = new RegExp(
      '^(' + stubKeys.map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|') + ')$',
    );
    build.onResolve({ filter: stubFilter }, (args) => ({ path: STUB_MAP[args.path] }));

    build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));

    build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
      path: resolve(ROOT, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js'),
    }));
  },
};

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
}

const result = await Bun.build({
  entrypoints: [resolve(ROOT, 'src/entrypoints/cli.tsx')],
  outdir: OUT,
  naming: 'mercury.mjs',
  target: 'node',
  format: 'esm',
  sourcemap: 'none',
  minify:
    process.env.MERCURY_BUILD_MINIFY === 'oracle'
      ? { whitespace: true, syntax: true, identifiers: false }
      : true,
  plugins: [mercuryPlugin],
  loader: {
    '.md': 'text',
    '.txt': 'text',
    '.sh': 'text',
    '.py': 'text',
    '.html': 'text',
    '.xml': 'text',
    '.dot': 'text',
  },
  define: {
    MACRO: JSON.stringify(MACRO),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});

if (!result.success) {
  console.error('BUILD FAILED');
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

rmSync(resolve(OUT, 'manifest.json'), { force: true });
rmSync(resolve(OUT, 'verify-artifact.mjs'), { force: true });
rmSync(resolve(OUT, '.build-tree'), { force: true });

{
  const bundlePath = resolve(OUT, 'mercury.mjs');
  const raw = readFileSync(bundlePath, 'utf8');
  const NEUTRAL_VENDOR = '/mercury/vendor/';
  const rootsToErase = [ROOT, realpathSync(ROOT)].filter((r, i, a) => a.indexOf(r) === i);
  const modulesDir = resolve(ROOT, 'node_modules');
  const vendorDirsToErase = [...rootsToErase.map((root) => `${root}/node_modules`), existsSync(modulesDir) ? realpathSync(modulesDir) : modulesDir]
    .filter((dir, i, a) => a.indexOf(dir) === i);
  const spellingsOf = (prefix: string): string[] => {
    if (process.platform !== 'win32') return [prefix];
    const forward = prefix.replace(/\\/g, '/');
    const backward = prefix.replace(/\//g, '\\');
    const escaped = backward.replace(/\\/g, '\\\\');
    const driveCases = (p: string): string[] => (/^[A-Za-z]:/.test(p) ? [p[0]!.toUpperCase() + p.slice(1), p[0]!.toLowerCase() + p.slice(1)] : [p]);
    return [forward, backward, escaped].flatMap(driveCases).filter((p, i, a) => a.indexOf(p) === i);
  };
  let neutral = raw;
  for (const dir of vendorDirsToErase) {
    for (const spelling of spellingsOf(`${dir}/`)) neutral = neutral.split(spelling).join(NEUTRAL_VENDOR);
  }
  for (const root of rootsToErase) {
    if (neutral.includes(root)) {
      const at = neutral.indexOf(root);
      throw new Error(
        `build root leaked into dist/mercury.mjs beyond the vendored-module __filename seam: …${neutral.slice(Math.max(0, at - 80), at + root.length + 40)}…`,
      );
    }
  }
  for (const seam of neutral.matchAll(/__(filename|dirname)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) {
    if (!seam[2]!.startsWith(NEUTRAL_VENDOR)) {
      throw new Error(
        `a bundled CommonJS module keeps its build-host path in dist/mercury.mjs: __${seam[1]}="${seam[2]}" — the vendored-module seam erases ${vendorDirsToErase.map((dir) => `${dir}/`).join(', ')}; add the prefix this literal carries to the erased set`,
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
    'cli-highlight',
    'image-processor-napi',
    'kerberos',
    'plist',
    'proxy-agent',
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

{
  const { builtinModules } = await import('node:module');
  const builtin = new Set(builtinModules);
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      if (statSync(full).isDirectory()) {
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

const rgRelPath = `vendor/ripgrep/${SHIP.arch}-${SHIP.platform}/${SHIP.platform === 'win32' ? 'rg.exe' : 'rg'}`;
let rgVendored = false;
let rgSourceLabel = '';
{
  const rgDest = resolve(OUT, rgRelPath);
  const rgDestDir = resolve(rgDest, '..');
  rmSync(resolve(OUT, 'vendor', 'ripgrep'), { recursive: true, force: true });

  let rgSource: string | null = null;
  const forceNoRg = process.env.MERCURY_BUILD_NO_VENDOR_RG === '1';
  const rgPackage = ripgrepPackageFor(SHIP.platform, SHIP.arch);

  if (!forceNoRg) {
    const pkg = resolvePlatformPackage(ROOT, SHIP.platform, SHIP.arch, rgPackage);
    const candidate = pkg ? resolve(pkg.dir, 'bin', SHIP.platform === 'win32' ? 'rg.exe' : 'rg') : null;
    if (pkg && candidate && statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      rgSource = candidate;
      rgSourceLabel = pkg.source === 'node_modules' ? '@vscode/ripgrep' : `${rgPackage} (vendor/platform-packages, bun.lock-pinned)`;
    }
  }

  if (!rgSource && !forceNoRg && !CROSS) {
    const systemCandidates: string[] = ['/opt/homebrew/bin/rg'];
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const found = execFileSync(whichCmd, ['rg'], { encoding: 'utf8' })
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      systemCandidates.push(...found);
    } catch {
    }
    for (const c of systemCandidates) {
      try {
        if (statSync(c).isFile()) {
          rgSource = c;
          rgSourceLabel = `system rg (${c})`;
          break;
        }
      } catch {
      }
    }
  }

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
    if (CROSS) {
      console.error(
        'BUILD FAILED: no ripgrep binary could be vendored.\n' +
          `  Expected output: ${rgDest}\n` +
          `  This build ships for ${SHIP_KEY}, so only that platform's package serves (a system rg is the host's). Prepare it:\n` +
          `    bun run scripts/vendor/fetch-platform-packages.ts --target ${TARGET_ARG}\n` +
          `  then re-run bun run build.ts --target ${TARGET_ARG}.`,
      );
      process.exit(1);
    }
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
        writeFileSync(resolve(jsDebugDest, 'package.json'), '{"type":"commonjs"}\n');
        jsDebugVendored = true;
        jsDebugMeta = { version: lock.version, tarball: lock.tarball, sha512: lock.sha512 };
        console.log(`VENDORED js-debug ${lock.version} (pinned release asset, sha512-verified cache; module-class fence written)\n  -> ${jsDebugDest}`);
      } else {
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

const { RUNTIME_PACK_PATH: nodeRelPath, nodePackPlatform, runtimeBinaryFor } = await import('./src/services/privateChannel/vendoredRuntime.ts');
let nodeVendored = false;
let nodeMeta: { version: string; platform: string; license: string; archiveSha256: string; binary: string; binarySha256: string } | null = null;
{
  const nodeDest = resolve(OUT, nodeRelPath);
  rmSync(nodeDest, { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_NODE === '1';
  const packPlatform = nodePackPlatform(SHIP.platform, SHIP.arch);
  const lockPath = resolve(ROOT, 'vendor', 'node.lock.json');
  const extractedDir = packPlatform ? resolve(ROOT, 'vendor', 'node', 'extracted', packPlatform) : null;
  const vendorManifestPath = extractedDir ? resolve(extractedDir, '.vendor-manifest.json') : null;
  if (!forceNo && packPlatform && extractedDir && vendorManifestPath && statSync(lockPath, { throwIfNoEntry: false })?.isFile() && statSync(vendorManifestPath, { throwIfNoEntry: false })?.isFile()) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { version: string; license: string; platforms: Record<string, { sha256: string }> };
      const vman = JSON.parse(readFileSync(vendorManifestPath, 'utf8')) as { version: string; platform: string; archiveSha256: string; binary: string };
      const pinned = lock.platforms[packPlatform];
      const binary = runtimeBinaryFor(packPlatform);
      const binaryPath = resolve(extractedDir, ...binary.split('/'));
      if (pinned && vman.version === lock.version && vman.platform === packPlatform && vman.archiveSha256 === pinned.sha256 && vman.binary === binary && statSync(binaryPath, { throwIfNoEntry: false })?.isFile()) {
        const { cpSync } = await import('node:fs');
        cpSync(extractedDir, nodeDest, { recursive: true });
        const shipped = resolve(nodeDest, ...binary.split('/'));
        if (process.platform !== 'win32') chmodSync(shipped, 0o755);
        nodeVendored = true;
        nodeMeta = {
          version: lock.version,
          platform: packPlatform,
          license: lock.license,
          archiveSha256: pinned.sha256,
          binary,
          binarySha256: createHash('sha256').update(readFileSync(shipped)).digest('hex'),
        };
        console.log(`VENDORED node ${lock.version} ${packPlatform} (pinned nodejs.org archive, sha256-verified cache)\n  -> ${nodeDest}`);
      } else {
        console.error(
          'BUILD FAILED: vendor/node cache does not match vendor/node.lock.json ' +
            `(cache ${vman.version} ${vman.platform}, lock ${lock.version} ${packPlatform}) — the lock was re-pinned without refetching.\n` +
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
  } else if (!packPlatform) {
    console.warn(`nodejs.org publishes no runtime archive Mercury vendors for ${SHIP_KEY} — the artifact ships WITHOUT a bundled Node runtime (degraded: runtime; the launchers run MERCURY_NODE or a PATH node inside the supported range).`);
  } else {
    console.warn(`no node vendor cache for ${packPlatform} — the artifact ships WITHOUT the bundled Node runtime (degraded: runtime; the launchers run MERCURY_NODE or a PATH node inside the supported range). Prepare it: bun run scripts/vendor/fetch-node.ts${CROSS ? ` --platform ${packPlatform}` : ''}`);
  }
}

const { VOICE_PACK_PATH: voiceRelPath, VOICE_NATIVE_PATH: voiceNativePath, voicePackPlatform, checkVoicePackDir, voiceSourceTreeDigest } = await import('./src/services/voice/voicePack.ts');
let voiceVendored = false;
let voiceMeta: { version: string; platform: string; addon: string; addonSha256: string; crates: number } | null = null;
{
  const voiceDest = resolve(OUT, voiceRelPath);
  rmSync(voiceDest, { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_VOICE === '1';
  const packPlatform = voicePackPlatform(SHIP.platform, SHIP.arch);
  const packDir = resolve(ROOT, voiceRelPath, packPlatform);
  const nativeDir = resolve(ROOT, voiceNativePath);
  if (!forceNo && statSync(resolve(packDir, '.vendor-manifest.json'), { throwIfNoEntry: false })?.isFile()) {
    const check = checkVoicePackDir(packDir, { digest: true, platform: packPlatform });
    const sourcesNow = statSync(nativeDir, { throwIfNoEntry: false })?.isDirectory() ? voiceSourceTreeDigest(nativeDir) : null;
    if (check.state === 'ok' && sourcesNow !== null && check.manifest.sourceTreeDigest === sourcesNow) {
      const { cpSync } = await import('node:fs');
      cpSync(packDir, resolve(voiceDest, packPlatform), { recursive: true });
      voiceVendored = true;
      voiceMeta = {
        version: check.manifest.version,
        platform: packPlatform,
        addon: check.manifest.addon,
        addonSha256: check.manifest.addonSha256,
        crates: check.manifest.crates.length,
      };
      console.log(`VENDORED voice pack ${check.manifest.version} ${packPlatform} (built from ${voiceNativePath}, ${check.manifest.crates.length} crate licences)\n  -> ${resolve(voiceDest, packPlatform)}`);
    } else {
      const why = check.state !== 'ok' ? check.note : sourcesNow === null ? `${voiceNativePath} is absent` : `the pack was built from other sources than ${voiceNativePath} now holds`;
      console.error(
        `BUILD FAILED: vendor/voice/${packPlatform} pack is present but stale — ${why}.\n` +
          '  remedy: bun run scripts/vendor/build-voice.ts   (then rebuild)\n' +
          '  (a missing pack degrades honestly instead — only a PRESENT-but-wrong pack fails the build)',
      );
      process.exit(1);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_VOICE=1 — voice pack NOT vendored (degraded: voice-input; proof seam).');
  } else {
    console.warn(`no voice pack for ${packPlatform} — the artifact ships WITHOUT the voice capture addon (degraded: voice-input; the runtime falls back to sox/arecord/ffmpeg on PATH, else the no-backend receipt). Prepare it: bun run scripts/vendor/build-voice.ts${CROSS ? ` --target ${TARGET_ARG}` : ''} (needs cargo${CROSS ? ' and the rustup target it names' : ''})`);
  }
}

const { BRUSH_PACK_PATH: brushRelPath, brushPackPlatform, checkBrushPackDir } = await import('./src/utils/shell/brushPack.ts');
let brushVendored = false;
let brushMeta: { source: string; version: string; platform: string; target: string; binary: string; binarySha256: string; license: string } | null = null;
{
  const brushDest = resolve(OUT, brushRelPath);
  rmSync(brushDest, { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_BRUSH === '1';
  const packPlatform = brushPackPlatform(SHIP.platform, SHIP.arch);
  const packDir = packPlatform ? resolve(ROOT, brushRelPath, packPlatform) : null;
  if (!forceNo && packPlatform && packDir && statSync(resolve(packDir, '.vendor-manifest.json'), { throwIfNoEntry: false })?.isFile()) {
    const check = checkBrushPackDir(packDir, { digest: true, platform: packPlatform });
    let lockWhy: string | null = null;
    if (check.state === 'ok') {
      try {
        const lock = JSON.parse(readFileSync(resolve(ROOT, 'vendor', 'brush.lock.json'), 'utf8')) as {
          version?: string;
          platforms?: Record<string, { kind?: string; sha256?: string }>;
        };
        const pinned = lock.platforms?.[packPlatform];
        if (lock.version !== check.manifest.version) lockWhy = `the pack is ${check.manifest.version}, the lock pins ${String(lock.version)}`;
        else if (check.manifest.source === 'release-archive' && pinned && pinned.sha256 !== check.manifest.archiveSha256) lockWhy = "the pack's archive digest is not the lock's";
        else if (check.manifest.source === 'cargo-build' && (pinned?.kind ?? 'fetch') !== 'build') lockWhy = "the pack was built from the crate with cargo, but the lock fetches this platform's release binary";
      } catch (e) {
        lockWhy = `vendor/brush.lock.json unreadable (${String(e)})`;
      }
    }
    if (check.state === 'ok' && lockWhy === null) {
      const { cpSync } = await import('node:fs');
      cpSync(packDir, resolve(brushDest, packPlatform), { recursive: true });
      brushVendored = true;
      brushMeta = {
        source: check.manifest.source,
        version: check.manifest.version,
        platform: packPlatform,
        target: check.manifest.target,
        binary: check.manifest.binary,
        binarySha256: check.manifest.binarySha256,
        license: check.manifest.license,
      };
      console.log(`VENDORED shell engine brush ${check.manifest.version} ${packPlatform} (${check.manifest.source === 'cargo-build' ? 'built from the published crate with cargo' : 'pinned upstream release binary'}, sha256-verified cache)\n  -> ${resolve(brushDest, packPlatform)}`);
    } else {
      const why = check.state !== 'ok' ? check.note : lockWhy;
      console.error(
        `BUILD FAILED: vendor/brush/${packPlatform} pack is present but stale — ${why}.\n` +
          '  remedy: bun run scripts/vendor/fetch-brush.ts   (then rebuild)\n' +
          '  (a missing pack degrades honestly instead — only a PRESENT-but-wrong pack fails the build)',
      );
      process.exit(1);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_BRUSH=1 — shell engine NOT vendored (degraded: shell-engine; proof seam).');
  } else if (!packPlatform) {
    console.warn(`no shell-engine pack layout for ${SHIP_KEY} — the artifact ships WITHOUT the vendored shell engine (degraded: shell-engine; the Bash tool keeps the system bash).`);
  } else {
    console.warn(`no shell-engine pack for ${packPlatform} — the artifact ships WITHOUT the vendored shell engine (degraded: shell-engine; the Bash tool keeps the system bash and the engine setting refuses to arm). Prepare it: bun run scripts/vendor/fetch-brush.ts${CROSS ? ` --platform ${packPlatform}` : ''}`);
  }
}

const { WHISPER_PACK_PATH: whisperRelPath, WHISPER_NATIVE_PATH: whisperNativePath, checkWhisperPackDir, whisperPackDirFor, whisperSourceTreeDigest } = await import('./src/services/voice/whisperPack.ts');
const { whisperDefaultModel } = await import('./src/services/voice/whisperModels.ts');
let whisperVendored = false;
let whisperMeta: { version: string; platform: string; addon: string; addonSha256: string; crates: number; engine: { name: string; version: string }; cpuFloor: string; gpu: string } | null = null;
{
  const whisperDest = resolve(OUT, whisperRelPath);
  rmSync(whisperDest, { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_WHISPER === '1';
  const packPlatform = voicePackPlatform(SHIP.platform, SHIP.arch);
  const packDir = whisperPackDirFor(ROOT, packPlatform);
  const nativeDir = resolve(ROOT, whisperNativePath);
  if (!forceNo && statSync(resolve(packDir, '.vendor-manifest.json'), { throwIfNoEntry: false })?.isFile()) {
    const check = checkWhisperPackDir(packDir, { digest: true, platform: packPlatform });
    const sourcesNow = statSync(nativeDir, { throwIfNoEntry: false })?.isDirectory() ? whisperSourceTreeDigest(nativeDir) : null;
    if (check.state === 'ok' && sourcesNow !== null && check.manifest.sourceTreeDigest === sourcesNow) {
      const { cpSync } = await import('node:fs');
      cpSync(packDir, resolve(whisperDest, packPlatform), { recursive: true });
      whisperVendored = true;
      whisperMeta = {
        version: check.manifest.version,
        platform: packPlatform,
        addon: check.manifest.addon,
        addonSha256: check.manifest.addonSha256,
        crates: check.manifest.crates.length,
        engine: check.manifest.engine,
        cpuFloor: check.manifest.cpuFloor,
        gpu: check.manifest.gpu,
      };
      console.log(`VENDORED on-device transcriber pack ${check.manifest.version} ${packPlatform} (${check.manifest.engine.name} ${check.manifest.engine.version}, built from ${whisperNativePath}, ${check.manifest.crates.length} crate licences)\n  -> ${resolve(whisperDest, packPlatform)}`);
    } else {
      const why = check.state !== 'ok' ? check.note : sourcesNow === null ? `${whisperNativePath} is absent` : `the pack was built from other sources than ${whisperNativePath} now holds`;
      console.error(
        `BUILD FAILED: vendor/whisper/${packPlatform} pack is present but stale — ${why}.\n` +
          '  remedy: bun run scripts/vendor/build-whisper.ts   (then rebuild)\n' +
          '  (a missing pack degrades honestly instead — only a PRESENT-but-wrong pack fails the build)',
      );
      process.exit(1);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_WHISPER=1 — on-device transcriber pack NOT vendored (degraded: on-device-transcriber; proof seam).');
  } else {
    console.warn(`no on-device transcriber pack for ${packPlatform} — the artifact ships WITHOUT it (degraded: on-device-transcriber; the cloud transcribers serve). Prepare it: bun run scripts/vendor/build-whisper.ts${CROSS ? ` --target ${TARGET_ARG}` : ''} (needs cargo and cmake${CROSS ? ' and the rustup target it names' : ''})`);
  }
}

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

const { IMAGE_PACK_PATH: imagePackRelPath, imagePackPlatform, imagePackPackages } = await import('./src/tools/FileReadTool/imageProcessor.ts');
let imagePackVendored = false;
let imagePackMeta: { platform: string; packages: string[]; sharp: string; libvips: string | null } | null = null;
{
  const packPlatform = imagePackPlatform(SHIP.platform, SHIP.arch);
  const packDest = resolve(OUT, imagePackRelPath, packPlatform);
  rmSync(resolve(OUT, imagePackRelPath), { recursive: true, force: true });
  const forceNo = process.env.MERCURY_BUILD_NO_VENDOR_IMAGE === '1';
  const packages = imagePackPackages(packPlatform);
  const resolved = packages.map((name) => resolvePlatformPackage(ROOT, SHIP.platform, SHIP.arch, name));
  const sources = resolved.map((r) => r?.dir ?? '');
  const present = resolved.every((r) => r !== null);
  const fromModules = resolved.every((r) => r?.source === 'node_modules');
  if (!forceNo && present) {
    try {
      const { cpSync } = await import('node:fs');
      for (const [index, name] of packages.entries()) {
        cpSync(sources[index]!, resolve(packDest, 'node_modules', ...name.split('/')), { recursive: true, dereference: true });
      }
      const versionOf = (dir: string): string => (JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { version: string }).version;
      imagePackMeta = { platform: packPlatform, packages, sharp: versionOf(sources[0]!), libvips: sources[1] ? versionOf(sources[1]) : null };
      writeFileSync(resolve(packDest, 'vendor.json'), JSON.stringify({ ...imagePackMeta, source: fromModules ? 'repo dependency (sharp prebuilt packages)' : 'vendor/platform-packages (sharp prebuilt packages, bun.lock-pinned)' }, null, 2) + '\n');
      imagePackVendored = true;
      console.log(`VENDORED image processor ${packPlatform} (${packages.join(' + ')})\n  -> ${packDest}`);
    } catch (e) {
      console.warn(`image processor vendor copy failed — SKIPPED (degraded: image-processing): ${String(e)}`);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_IMAGE=1 — image processor NOT vendored (degraded: image-processing; proof seam).');
  } else {
    console.warn(`no prebuilt image processor for ${packPlatform} under node_modules/@img${CROSS ? ` or vendor/platform-packages (prepare it: bun run scripts/vendor/fetch-platform-packages.ts --target ${TARGET_ARG})` : ''} — the artifact ships WITHOUT it (degraded: image-processing; the runtime takes the pure-JavaScript image road: PNG/BMP shrink, other formats pass through unshrunk).`);
  }
}

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
      const shippedPack: string[] = [];
      const forceNoPack = process.env.MERCURY_BUILD_NO_VENDOR_GRAMMARPACK === '1';
      const packLock = !forceNoPack && statSync(packLockPath, { throwIfNoEntry: false })?.isFile()
        ? (JSON.parse(readFileSync(packLockPath, 'utf8')) as {
            version: string;
            grammars: Array<{ wasm: string; sha256: string; upstream: Record<string, string> }>;
          })
        : null;
      if (packLock && packWasms.length > 0) {
        grammarPackVersion = packLock.version;
        const lockedSha = new Map(packLock.grammars.map(g => [g.wasm, g.sha256]));
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
      writeFileSync(resolve(tsitDest, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
      treesitterVendored = true;
      console.log(
        `VENDORED tree-sitter engine ${treesitterVersion} (${shippedWasms.length} grammar wasms` +
          `${grammarPackVendored ? `, incl. ${shippedPack.length} from tree-sitter-wasms ${grammarPackVersion}` : ''})\n  -> ${tsitDest}`,
      );
    } catch (e) {
      rmSync(tsitDest, { recursive: true, force: true });
      console.warn(`tree-sitter vendor copy failed — SKIPPED (degraded: structure-polyglot): ${String(e)}`);
    }
  } else if (forceNo) {
    console.warn('MERCURY_BUILD_NO_VENDOR_TREESITTER=1 — tree-sitter NOT vendored (degraded: structure-polyglot; proof seam).');
  } else {
    console.warn('node_modules/@vscode/tree-sitter-wasm missing — the artifact ships WITHOUT the polyglot grammar engine (degraded: structure-polyglot; the JS/TS select lane is unaffected).');
  }
}

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

if (buildTree) {
  writeFileSync(resolve(OUT, '.build-tree'), buildTree + '\n');
}

const manifest = {
  schema: 2,
  name: 'mercury',
  version: MACRO_VERSION,
  buildTime: MACRO.BUILD_TIME,
  buildTree,
  bundle: 'mercury.mjs',
  bundleBytes: statSync(resolve(OUT, 'mercury.mjs')).size,
  bundleSha256: createHash('sha256').update(readFileSync(resolve(OUT, 'mercury.mjs'))).digest('hex'),
  target: { platform: SHIP.platform, arch: SHIP.arch, release: SHIP_RELEASE, host: HOST_KEY },
  node: NODE_SUPPORTED_RANGE,
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
  shellEngine: brushVendored && brushMeta
    ? {
        vendored: true,
        name: 'brush',
        source: brushMeta.source,
        path: `${brushRelPath}/${brushMeta.platform}`,
        version: brushMeta.version,
        platform: brushMeta.platform,
        target: brushMeta.target,
        binary: brushMeta.binary,
        binarySha256: brushMeta.binarySha256,
        license: brushMeta.license,
      }
    : {
        vendored: false,
        name: 'brush',
        path: brushRelPath,
        remedy:
          'fetch the shell engine pack (`bun run scripts/vendor/fetch-brush.ts`), then re-run `bun run build.ts` — the Bash tool keeps the system bash meanwhile, and the engine setting refuses to arm naming this',
      },
  onDeviceTranscriber: whisperVendored && whisperMeta
    ? {
        vendored: true,
        path: `${whisperRelPath}/${whisperMeta.platform}`,
        version: whisperMeta.version,
        platform: whisperMeta.platform,
        engine: whisperMeta.engine,
        addon: whisperMeta.addon,
        addonSha256: whisperMeta.addonSha256,
        cpuFloor: whisperMeta.cpuFloor,
        gpu: whisperMeta.gpu,
        crateLicences: whisperMeta.crates,
        defaultModel: { name: whisperDefaultModel().name, file: whisperDefaultModel().file, bytes: whisperDefaultModel().bytes, sha256: whisperDefaultModel().sha256 },
      }
    : {
        vendored: false,
        path: whisperRelPath,
        remedy:
          'build the on-device transcriber pack (`bun run scripts/vendor/build-whisper.ts`, needs cargo and cmake), then re-run `bun run build.ts` — the cloud transcribers serve meanwhile (an OpenAI or Gemini API key)',
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
  imageProcessing: imagePackVendored && imagePackMeta
    ? {
        vendored: true,
        path: `${imagePackRelPath}/${imagePackMeta.platform}`,
        platform: imagePackMeta.platform,
        packages: imagePackMeta.packages,
        sharp: imagePackMeta.sharp,
        libvips: imagePackMeta.libvips,
        degradesTo: 'the pure-JavaScript image road (PNG/BMP shrink; JPEG/WebP/GIF pass through unshrunk)',
      }
    : {
        vendored: false,
        path: imagePackRelPath,
        remedy:
          'install the platform\'s prebuilt sharp packages (bun install fetches node_modules/@img/*), then re-run `bun run build.ts` — the runtime takes the pure-JavaScript image road meanwhile (PNG/BMP shrink; JPEG/WebP/GIF pass through unshrunk)',
      },
  degraded: [
    ...(rgVendored ? [] : ['search']),
    ...(debugpyVendored ? [] : ['python-debugger']),
    ...(pyrightVendored ? [] : ['python-intelligence']),
    ...(jsDebugVendored ? [] : ['js-debugger']),
    ...(nodeVendored ? [] : ['runtime']),
    ...(voiceVendored ? [] : ['voice-input']),
    ...(whisperVendored ? [] : ['on-device-transcriber']),
    ...(imagePackVendored ? [] : ['image-processing']),
    ...(brushVendored ? [] : ['shell-engine']),
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
