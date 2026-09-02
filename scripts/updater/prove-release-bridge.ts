#!/usr/bin/env bun
// ============================================================================
//  scripts/updater/prove-release-bridge.ts — UPD-14 made real: the PREVIOUS
//  release's REAL shipped reader must consume the CANDIDATE archive through
//  its ordinary `update` verb before that archive may publish.
//
//  Every local prover exercises the current reader against the current
//  archive; only this gate runs the ALREADY-SHIPPED reader (the one actually
//  installed in the field) against the bytes about to publish, so a
//  producer/reader contract drift cannot ship green. This prover:
//
//    1. locates the CANDIDATE archive for this host (release-out/, or
//       MERCURY_BRIDGE_CANDIDATE);
//    2. downloads the PREVIOUS release's real platform asset via gh (or takes
//       MERCURY_BRIDGE_PREVIOUS, e.g. a workflow-predownloaded path) — a
//       channel with NO previous convention-valid release is the candidate's
//       FIRST release: nothing to bridge from, the gate settles NEUTRAL
//       (channelCore.selectBridgePrevious);
//    3. extracts the previous payload and seeds a hermetic managed layout
//       with it (direct copy — the same shape `mercury install` produces);
//    4. drives `node <previous bundle> update` — the OLD reader, the REAL
//       production call — against a fixture channel serving the candidate;
//    5. asserts: clean update, pointer switched, previous retained, stable
//       command runs the candidate, rerun is an honest no-op.
//
//  NETWORK LANE — deliberately NOT in the default pool (gh + a release
//  download). Runs locally pre-tag (MERCURY_UPDATER_NETWORK=1) and per-OS as
//  the release workflow's bridge-gate job between package and release.
//
//  Old shipped readers have no MERCURY_GH_CMD seam, so the fake gh transport
//  is PATH-fronted: a #!/bin/sh wrapper on POSIX; on win32 a tiny C# gh.exe
//  compiled with the runner's Framework csc (Node's execFile spawns only
//  .exe — .cmd/.bat shims die with EINVAL), forwarding to fake-gh.mjs.
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assetNameFor, repoSlugFromUrl, selectBridgePrevious } from '../../src/services/privateChannel/channelCore.js'

const ROOT = resolve(import.meta.dir, '..', '..')
const IS_WIN = process.platform === 'win32'

/** Child env with `binDir` fronting the executable search path as the ONLY
 *  path-spelled key. On win32 the inherited block carries `Path`, so adding a
 *  second `PATH` key produced a duplicate case-insensitive pair — and the
 *  first release-run outing (30620262878) proved the child's `gh` resolution
 *  read the ORIGINAL `Path`: the shipped .2 reader reached the REAL gh and
 *  real GitHub answered "cannot see fixture-owner/fixture-bridge-repo".
 *  Delete every PATH-cased key first, then write exactly one. */
const pathFrontedEnv = (
  binDir: string,
  extra: Record<string, string | undefined>,
): Record<string, string | undefined> => {
  const base: Record<string, string | undefined> = IS_WIN ? { ...process.env } : {}
  const inheritedPath = process.env.PATH ?? process.env.Path ?? ''
  if (IS_WIN) for (const k of Object.keys(base)) if (k.toUpperCase() === 'PATH') delete base[k]
  return {
    ...base,
    [IS_WIN ? 'Path' : 'PATH']: `${binDir}${IS_WIN ? ';' : ':'}${inheritedPath}`,
    ...extra,
  }
}

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const finish = (): never => {
  console.log('')
  if (failures === 0) {
    console.log('PASS prove-release-bridge')
    process.exit(0)
  }
  console.log(`FAIL prove-release-bridge (${failures})`)
  process.exit(1)
}
const die = (msg: string): never => {
  console.log(`  [FAIL] ${msg}`)
  failures++
  return finish()
}

const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; repository?: { url?: string } }
const CANDIDATE_VERSION = PKG.version
const HOST_ASSET = (version: string): string | null => assetNameFor(version, process.platform, process.arch)
const candidateAsset = HOST_ASSET(CANDIDATE_VERSION)
if (!candidateAsset) die(`host ${process.platform}/${process.arch} has no channel asset — run on linux-x64/macos-arm64/windows-x64`)

// ── 1. the candidate archive (the exact bytes that would publish) ───────────
const candidatePath = process.env.MERCURY_BRIDGE_CANDIDATE ?? join(ROOT, 'release-out', candidateAsset!)
if (!existsSync(candidatePath)) {
  die(`candidate archive absent: ${candidatePath} — run \`node scripts/release/package.mjs --target <host>\` first (or set MERCURY_BRIDGE_CANDIDATE)`)
}
console.log(`  · candidate: ${candidatePath}`)

const scratch = mkdtempSync(join(tmpdir(), 'mercury-bridge-'))
const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

const extractArchive = (archive: string, dest: string): void => {
  mkdirSync(dest, { recursive: true })
  if (archive.endsWith('.zip')) {
    execFileSync(IS_WIN ? 'pwsh' : 'unzip', IS_WIN ? ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:MB_SRC -DestinationPath $env:MB_DEST -Force'] : ['-q', archive, '-d', dest], {
      stdio: 'pipe',
      timeout: 300_000,
      env: { ...process.env, MB_SRC: archive, MB_DEST: dest },
    })
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', dest], { stdio: 'pipe', timeout: 300_000 })
  }
}

try {
  // ── 2. the previous release's REAL shipped asset ──────────────────────────
  const slug = process.env.MERCURY_BRIDGE_SLUG ?? repoSlugFromUrl(PKG.repository?.url ?? '') ?? 'Whq02/PreRelease'
  let previousPath = process.env.MERCURY_BRIDGE_PREVIOUS ?? ''
  let previousTag = process.env.MERCURY_BRIDGE_PREVIOUS_TAG ?? ''
  if (!previousPath) {
    const listed = execFileSync('gh', ['api', `repos/${slug}/releases?per_page=20`], { encoding: 'utf8', timeout: 120_000 })
    const parsedList = JSON.parse(listed) as Array<{ tag_name?: string; draft?: boolean }>
    const previous = selectBridgePrevious(
      parsedList.filter(r => typeof r.tag_name === 'string').map(r => ({ tagName: r.tag_name!, isDraft: r.draft === true })),
      CANDIDATE_VERSION,
    )
    if (previous.state === 'first-release') {
      // The ONE pure decision (channelCore.selectBridgePrevious, pinned by
      // prove-channel-core): a channel with no convention-valid, non-draft
      // release other than the candidate's own tag has no shipped reader to
      // bridge from — the candidate is the channel's first release. Settling
      // neutral here lets a first release publish; the listing itself
      // succeeded (a gh failure throws above and dies).
      console.log(`  [NEUTRAL] clean channel — ${slug} lists no previous convention-valid release (${parsedList.length} release record(s) seen); the candidate is the channel's FIRST release and there is no shipped reader to bridge from. The bridge law resumes at the next release.`)
      rmSync(scratch, { recursive: true, force: true })
      console.log('')
      console.log('PASS prove-release-bridge (first release — nothing to bridge)')
      process.exit(0)
    }
    previousTag = previous.tag
    const prevVersion = previousTag.slice(1)
    const prevAsset = HOST_ASSET(prevVersion)
    if (!prevAsset) die(`previous release ${previousTag} has no asset name for this host`)
    const dlDir = join(scratch, 'previous-download')
    mkdirSync(dlDir, { recursive: true })
    execFileSync('gh', ['release', 'download', previousTag, '--repo', slug, '--dir', dlDir, '--pattern', prevAsset!], {
      stdio: 'pipe',
      timeout: 15 * 60_000,
    })
    previousPath = join(dlDir, prevAsset!)
  }
  if (!existsSync(previousPath)) die(`previous release asset absent: ${previousPath}`)
  console.log(`  · previous: ${previousTag || '(pinned path)'} — ${previousPath}`)

  const prevExtract = join(scratch, 'previous-extract')
  extractArchive(previousPath, prevExtract)
  const prevPayload = join(prevExtract, 'mercury')
  const prevBundle = 'mercury.mjs'
  if (!existsSync(join(prevPayload, prevBundle))) die('previous payload carries no mercury.mjs runtime bundle')
  const prevManifest = JSON.parse(readFileSync(join(prevPayload, 'manifest.json'), 'utf8')) as { version?: string }
  const prevVersion = prevManifest.version ?? ''
  if (!prevVersion) die('previous payload manifest carries no version')
  check('previous shipped payload extracted', true, `${prevVersion} (${prevBundle})`)

  // ── 3. hermetic managed layout seeded with the PREVIOUS release ───────────
  const home = join(scratch, 'home')
  const configHome = join(home, '.mercury')
  const versionsDir = join(scratch, 'versions')
  const binDir = join(scratch, 'bin')
  for (const p of [home, configHome, versionsDir, binDir]) mkdirSync(p, { recursive: true })
  for (const p of [home, configHome, versionsDir, binDir]) {
    if (!p.startsWith(scratch)) die(`SAFETY: path escapes scratch: ${p}`)
  }
  cpSync(prevPayload, join(versionsDir, prevVersion), { recursive: true })
  writeFileSync(join(versionsDir, 'current.txt'), prevVersion + '\n')

  // ── the fixture channel serving the CANDIDATE ─────────────────────────────
  const fixtures = join(scratch, 'fixtures')
  const tag = `v${CANDIDATE_VERSION}`
  mkdirSync(join(fixtures, 'assets', tag), { recursive: true })
  cpSync(candidatePath, join(fixtures, 'assets', tag, candidateAsset!))
  writeFileSync(join(fixtures, 'assets', tag, 'SHA256SUMS.txt'), `${sha256File(candidatePath)}  ${candidateAsset}\n`)
  writeFileSync(
    join(fixtures, 'releases.json'),
    JSON.stringify([{ tag_name: tag, draft: false, prerelease: true, assets: [{ name: candidateAsset }, { name: 'SHA256SUMS.txt' }] }], null, 1),
  )

  // ── the PATH-front fake gh the OLD reader can spawn ───────────────────────
  const fakeGhJs = join(ROOT, 'scripts', 'updater', 'fake-gh.mjs')
  if (IS_WIN) {
    // csc-compiled forwarder: Node execFile resolves only .exe via CreateProcess.
    const shimSrc = join(scratch, 'ghshim.cs')
    writeFileSync(
      shimSrc,
      [
        'using System;',
        'using System.Diagnostics;',
        'class GhShim {',
        '  static int Main(string[] args) {',
        '    var psi = new ProcessStartInfo();',
        '    psi.FileName = "node";',
        '    psi.UseShellExecute = false;',
        '    var sb = new System.Text.StringBuilder();',
        '    sb.Append(\'"\').Append(Environment.GetEnvironmentVariable("MERCURY_FAKE_GH_JS")).Append(\'"\');',
        '    foreach (var a in args) sb.Append(" \\"").Append(a.Replace("\\"", "\\\\\\"")).Append(\'"\');',
        '    psi.Arguments = sb.ToString();',
        '    var p = Process.Start(psi);',
        '    p.WaitForExit();',
        '    return p.ExitCode;',
        '  }',
        '}',
      ].join('\n'),
    )
    const windir = process.env.WINDIR ?? 'C:\\Windows'
    const csc = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    if (!existsSync(csc)) die(`csc.exe not found at ${csc} — the windows bridge leg needs the Framework compiler`)
    execFileSync(csc, ['/nologo', `/out:${join(binDir, 'gh.exe')}`, shimSrc], { stdio: 'pipe', timeout: 120_000 })
  } else {
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh\nexec node "${fakeGhJs}" "$@"\n`)
    execFileSync('chmod', ['755', join(binDir, 'gh')])
  }

  const ghLog = join(scratch, 'gh.log')
  const runOld = (args: string[]) =>
    spawnSync('node', [join(versionsDir, prevVersion, prevBundle!), ...args], {
      encoding: 'utf8',
      timeout: 600_000,
      env: pathFrontedEnv(binDir, {
        HOME: home,
        MERCURY_CONFIG_DIR: configHome,
        MERCURY_VERSIONS_DIR: versionsDir,
        MERCURY_UPDATE_CHANNEL_REPO: 'fixture-owner/fixture-bridge-repo',
        GH_SHIM_FIXTURES: fixtures,
        GH_SHIM_LOG: ghLog,
        MERCURY_FAKE_GH_JS: fakeGhJs,
        CI: '1',
        TERM: 'dumb',
        ...(IS_WIN ? { LOCALAPPDATA: join(home, 'AppData', 'Local') } : {}),
      }),
    })

  // ── 4. the OLD reader consumes the candidate through ordinary update ──────
  console.log(`── the shipped ${prevVersion} reader updates into the ${CANDIDATE_VERSION} candidate ──`)
  const upd = runOld(['update'])
  const updAll = (upd.stdout ?? '') + (upd.stderr ?? '')
  check('old reader: update exits 0', upd.status === 0, updAll.slice(0, 500))
  check('old reader: reports from → to', updAll.includes(`updated: ${prevVersion} → ${CANDIDATE_VERSION}`), updAll.slice(0, 300))
  const pointer = readFileSync(join(versionsDir, 'current.txt'), 'utf8').trim()
  check('pointer switched to the candidate', pointer === CANDIDATE_VERSION, pointer)
  const prevPointer = existsSync(join(versionsDir, 'previous.txt')) ? readFileSync(join(versionsDir, 'previous.txt'), 'utf8').trim() : null
  check('previous retained for rollback', prevPointer === prevVersion, String(prevPointer))
  check('candidate payload staged (mercury.mjs)', existsSync(join(versionsDir, CANDIDATE_VERSION, 'mercury.mjs')))
  const candidateManifest = JSON.parse(readFileSync(join(versionsDir, CANDIDATE_VERSION, 'manifest.json'), 'utf8')) as { releaseLayout?: { compatibility?: unknown[] } }
  const candidateCompat = candidateManifest.releaseLayout?.compatibility
  check('candidate manifest declares its releaseLayout', candidateManifest.releaseLayout !== undefined)
  check('candidate payload is floor-shaped (its layout declares no compatibility member)', Array.isArray(candidateCompat) && candidateCompat.length === 0)

  // ── 5. the stable command + honest idempotent rerun ───────────────────────
  const shim = IS_WIN ? join(home, 'AppData', 'Local', 'Mercury', 'bin', 'mercury.cmd') : join(home, '.local', 'bin', 'mercury')
  check('stable command exists after the update', existsSync(shim), shim)
  const shimEnv = pathFrontedEnv(binDir, {
    HOME: home,
    MERCURY_CONFIG_DIR: configHome,
    MERCURY_VERSIONS_DIR: versionsDir,
    CI: '1',
    TERM: 'dumb',
    ...(IS_WIN ? { LOCALAPPDATA: join(home, 'AppData', 'Local') } : {}),
  })
  const shimRun = IS_WIN
    ? spawnSync(`"${shim}" --version`, { encoding: 'utf8', timeout: 600_000, env: shimEnv, shell: true })
    : spawnSync(shim, ['--version'], { encoding: 'utf8', timeout: 600_000, env: shimEnv })
  check('stable command runs the CANDIDATE version', (shimRun.stdout ?? '').includes(CANDIDATE_VERSION), (shimRun.stdout ?? shimRun.stderr ?? '').slice(0, 200))

  const rerun = runOld(['update'])
  const rerunAll = (rerun.stdout ?? '') + (rerun.stderr ?? '')
  check('rerun is an honest no-op (current)', rerun.status === 0 && rerunAll.includes('current'), rerunAll.slice(0, 200))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

finish()
