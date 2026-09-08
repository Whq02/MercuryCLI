#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { repoSlugFromUrl, selectBridgePrevious } from '../../src/services/privateChannel/channelCore.js'
import { RELEASE_TARGETS, archiveNameFor, isReleaseTarget, releaseTargetFor } from '../../src/services/privateChannel/releaseTarget.js'

const ROOT = resolve(import.meta.dir, '..', '..')
const IS_WIN = process.platform === 'win32'

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
const targetAt = process.argv.indexOf('--target')
const TARGET_ARG = targetAt === -1 ? null : (process.argv[targetAt + 1] ?? '')
if (TARGET_ARG !== null && !isReleaseTarget(TARGET_ARG)) die(`--target wants one of ${RELEASE_TARGETS.join(', ')} (got ${TARGET_ARG || 'nothing'})`)
const TARGET = TARGET_ARG === null ? releaseTargetFor(process.platform, process.arch) : TARGET_ARG
if (!TARGET) die(`host ${process.platform}/${process.arch} has no channel asset — run on ${RELEASE_TARGETS.join('/')}, or name the archive with --target`)
const TARGET_ASSET = (version: string): string => archiveNameFor(version, TARGET)
const candidateAsset: string = TARGET_ASSET(CANDIDATE_VERSION)

const { unsignedArchiveName } = (await import('../release/payloadContract.mjs')) as { unsignedArchiveName: (archiveName: string) => string }
const candidatePath =
  process.env.MERCURY_BRIDGE_CANDIDATE ??
  [candidateAsset, unsignedArchiveName(candidateAsset)].map(a => join(ROOT, 'release-out', a)).find(p => existsSync(p)) ??
  join(ROOT, 'release-out', candidateAsset!)
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
  const slug = process.env.MERCURY_BRIDGE_SLUG ?? repoSlugFromUrl(PKG.repository?.url ?? '')
  if (!slug) die('no release repository: set MERCURY_BRIDGE_SLUG or a GitHub repository.url in package.json')
  let previousPath = process.env.MERCURY_BRIDGE_PREVIOUS ?? ''
  let previousTag = process.env.MERCURY_BRIDGE_PREVIOUS_TAG ?? ''
  if (!previousPath) {
    const listed = execFileSync('gh', ['api', `repos/${slug}/releases?per_page=20`], { encoding: 'utf8', timeout: 120_000 })
    const parsedList = JSON.parse(listed) as Array<{ tag_name?: string; draft?: boolean; assets?: Array<{ name?: string }> }>
    const previous = selectBridgePrevious(
      parsedList.filter(r => typeof r.tag_name === 'string').map(r => ({ tagName: r.tag_name!, isDraft: r.draft === true })),
      CANDIDATE_VERSION,
    )
    if (previous.state === 'first-release') {
      console.log(`  [NEUTRAL] clean channel — ${slug} lists no previous convention-valid release (${parsedList.length} release record(s) seen); the candidate is the channel's FIRST release and there is no shipped reader to bridge from. The bridge law resumes at the next release.`)
      rmSync(scratch, { recursive: true, force: true })
      console.log('')
      console.log('PASS prove-release-bridge (first release — nothing to bridge)')
      process.exit(0)
    }
    previousTag = previous.tag
    const prevVersion = previousTag.slice(1)
    const prevAsset = TARGET_ASSET(prevVersion)
    const prevAssets = (parsedList.find(r => r.tag_name === previousTag)?.assets ?? []).map(a => a.name).filter((n): n is string => typeof n === 'string')
    if (prevAssets.length > 0 && !prevAssets.includes(prevAsset)) {
      console.log(`  [NEUTRAL] ${previousTag} published no ${TARGET} archive (${prevAssets.length} asset(s) listed) — the candidate is this target's FIRST release and there is no shipped reader to bridge from. The bridge law resumes for ${TARGET} at the next release.`)
      rmSync(scratch, { recursive: true, force: true })
      console.log('')
      console.log(`PASS prove-release-bridge (first ${TARGET} release — nothing to bridge)`)
      process.exit(0)
    }
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

  const fixtures = join(scratch, 'fixtures')
  const tag = `v${CANDIDATE_VERSION}`
  mkdirSync(join(fixtures, 'assets', tag), { recursive: true })
  cpSync(candidatePath, join(fixtures, 'assets', tag, candidateAsset!))
  writeFileSync(join(fixtures, 'assets', tag, 'SHA256SUMS.txt'), `${sha256File(candidatePath)}  ${candidateAsset}\n`)
  writeFileSync(
    join(fixtures, 'releases.json'),
    JSON.stringify([{ tag_name: tag, draft: false, prerelease: true, assets: [{ name: candidateAsset }, { name: 'SHA256SUMS.txt' }] }], null, 1),
  )

  const fakeGhJs = join(ROOT, 'scripts', 'updater', 'fake-gh.mjs')
  if (IS_WIN) {
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
  const prevRuntime = join(versionsDir, prevVersion, ...(IS_WIN ? ['vendor', 'node', 'node.exe'] : ['vendor', 'node', 'bin', 'node']))
  const prevNode = existsSync(prevRuntime) ? prevRuntime : 'node'
  console.log(`  · previous reader's runtime: ${prevNode === 'node' ? 'the PATH node (no vendored runtime in the previous archive)' : prevRuntime}`)
  const runOld = (args: string[]) =>
    spawnSync(prevNode, [join(versionsDir, prevVersion, prevBundle!), ...args], {
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
