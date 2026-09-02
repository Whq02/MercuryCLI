#!/usr/bin/env bun
// ============================================================================
//  scripts/updater/prove-install-layout.ts — the versioned install layout
//  (PRIVATE BETA RELEASE §9): pointer atomicity + previous recording, the
//  single-update lock incl. stale reclaim, payload validation refusals,
//  staging install (fresh · idempotent · replace · never-partial), shim
//  safety (fresh · current · FOREIGN REFUSAL · force+backup), uninstall
//  preserving the config home, smoke honesty.
//
//  Hermetic by construction (the F6 ambient-state law): every path lives
//  under a mkdtemp outside the repo; MERCURY_VERSIONS_DIR + MERCURY_CONFIG_DIR
//  + HOME are pinned before the module resolves anything.
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// type-only: erased before the module loads, so the env pins below still
// precede every real resolution the layout module performs
import type { LayoutRoots } from '../../src/services/privateChannel/installLayout.js'

const scratch = mkdtempSync(join(tmpdir(), 'updater-layout-'))
process.env.HOME = join(scratch, 'home')
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home', '.mercury')
process.env.MERCURY_VERSIONS_DIR = join(scratch, 'home', '.mercury', 'versions')
delete process.env.MERCURY_HOME
// ambient-state law: a stray operator injection spec must never reach these
// proofs — every fault case sets the seam explicitly and clears it after.
delete process.env.MERCURY_UPDATE_FAULT

const {
  acquireUpdateLock,
  formatUninstallReport,
  installPayload,
  listInstalledVersions,
  pathEntryEquals,
  payloadDigestOf,
  readCurrentVersion,
  readCurrentVersionState,
  readPreviousVersion,
  reconcileManagedShims,
  releaseUpdateLock,
  resolveLayoutRoots,
  restoreCurrent,
  shimContent,
  shimStatus,
  SHIM_MARKER,
  SHIM_MARKER_FAMILY,
  smokeVersion,
  sweepUpdaterResidue,
  switchCurrent,
  uninstallLayout,
  validatePayloadDir,
  versionDirIntact,
  writeShim,
} = await import('../../src/services/privateChannel/installLayout.js')

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

/** A runnable fake payload: stub ESM runtime + manifest + vendor + launcher.
 *  `bundle` names the runtime member — mercury.mjs unless a proof needs a
 *  payload whose only bundle-shaped member is not the recognised name. */
function makePayload(dir: string, version: string, opts: { broken?: boolean; bundle?: string } = {}): void {
  mkdirSync(join(dir, 'vendor', 'ripgrep', 'stub'), { recursive: true })
  writeFileSync(join(dir, 'vendor', 'ripgrep', 'stub', 'rg'), 'stub\n')
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version }) + '\n')
  const bundle = opts.bundle ?? 'mercury.mjs'
  writeFileSync(
    join(dir, bundle),
    opts.broken
      ? `process.exit(1)\n`
      : `import { readFileSync } from 'node:fs'\nconst m = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))\nconsole.log('Mercury ' + m.version)\n`,
  )
  writeFileSync(join(dir, 'mercury'), `#!/bin/sh\nexec node "$(dirname "$0")/${bundle}" "$@"\n`)
  execFileSync('chmod', ['755', join(dir, 'mercury')])
}

// Bun's os.homedir() reads the passwd entry, NOT a runtime HOME override —
// resolveLayoutRoots()'s binDir would point at the OPERATOR'S real
// ~/.local/bin under bun (it caused a real clobber incident;
// the built runtime runs under node, where HOME is honored). This prover
// therefore constructs its LayoutRoots EXPLICITLY inside the scratch and
// only asserts the env-seam arm of the resolver.
check('resolver honors MERCURY_VERSIONS_DIR', resolveLayoutRoots().versionsDir === process.env.MERCURY_VERSIONS_DIR)
const roots = {
  versionsDir: process.env.MERCURY_VERSIONS_DIR!,
  binDir: join(scratch, 'home', '.local', 'bin'),
  shimPath: join(scratch, 'home', '.local', 'bin', 'mercury'),
  isWindows: false,
}
// F6 hard guard: every path this prover writes must live inside the scratch.
for (const p of [roots.versionsDir, roots.binDir, roots.shimPath]) {
  if (!p.startsWith(scratch)) {
    console.log(`  [FAIL] SAFETY: root escapes the scratch: ${p}`)
    process.exit(1)
  }
}

console.log('── §1 payload validation ──')
const goodPayload = join(scratch, 'payload-good')
makePayload(goodPayload, '9.9.0-beta.1')
check('complete payload validates (native bundle)', validatePayloadDir(goodPayload).state === 'ok')
{
  const otherName = join(scratch, 'payload-other-bundle-name')
  makePayload(otherName, '9.9.0-beta.1', { bundle: 'other.mjs' })
  const res = validatePayloadDir(otherName)
  check('a payload whose only bundle-shaped member is not mercury.mjs is refused (one recognised runtime name)', res.state === 'invalid' && res.note.includes('mercury.mjs'))
}
{
  // the installed-dir reader pre-reads no member bytes, so a layout that
  // declares a compatibility member refuses unverified — none is accepted
  const declaredCompat = join(scratch, 'payload-declared-compat')
  makePayload(declaredCompat, '9.9.0-beta.1')
  const compatBytes = "import './mercury.mjs'\n"
  writeFileSync(join(declaredCompat, 'compat.mjs'), compatBytes)
  writeFileSync(
    join(declaredCompat, 'manifest.json'),
    JSON.stringify({
      schema: 2,
      version: '9.9.0-beta.1',
      bundle: 'mercury.mjs',
      releaseLayout: {
        schema: 1,
        primary: { path: 'mercury.mjs', sha256: 'f'.repeat(64) },
        compatibility: [{ path: 'compat.mjs', role: 'forwarder', sha256: createHash('sha256').update(compatBytes).digest('hex') }],
        launcher: 'mercury',
      },
    }) + '\n',
  )
  const res = validatePayloadDir(declaredCompat)
  check('a layout declaring a compatibility member is refused unverified (no forwarder is accepted)', res.state === 'invalid' && res.note.includes('not provided'))
}
{
  const bare = join(scratch, 'payload-bare')
  mkdirSync(bare, { recursive: true })
  writeFileSync(join(bare, 'mercury.mjs'), '')
  check('bare dist refused', validatePayloadDir(bare).state === 'invalid')
}
{
  const noLauncher = join(scratch, 'payload-nolauncher')
  makePayload(noLauncher, '9.9.0-beta.1')
  rmSync(join(noLauncher, 'mercury'))
  const res = validatePayloadDir(noLauncher)
  check('build tree (no launcher) refused by name', res.state === 'invalid' && res.note.includes('not an extracted release archive'))
}

console.log('── §2 pointer files (atomic, previous recorded) ──')
check('no pointer initially', readCurrentVersion(roots) === null)
switchCurrent(roots, '9.9.0-beta.1')
check('current written', readCurrentVersion(roots) === '9.9.0-beta.1')
check('no previous on first switch', readPreviousVersion(roots) === null)
switchCurrent(roots, '9.9.0-beta.2')
check('previous records the displaced version', readPreviousVersion(roots) === '9.9.0-beta.1' && readCurrentVersion(roots) === '9.9.0-beta.2')
switchCurrent(roots, '9.9.0-beta.2')
check('same-version switch does not clobber previous', readPreviousVersion(roots) === '9.9.0-beta.1')
restoreCurrent(roots, '9.9.0-beta.1')
check('restore rewrites current only', readCurrentVersion(roots) === '9.9.0-beta.1' && readPreviousVersion(roots) === '9.9.0-beta.1')
check('no pointer temp files linger', !existsSync(join(roots.versionsDir, 'current.txt.tmp.' + process.pid)))

console.log('── §3 single-update lock ──')
check('first acquire wins', acquireUpdateLock(roots).state === 'acquired')
check('second acquire held (live pid)', acquireUpdateLock(roots).state === 'held')
releaseUpdateLock(roots)
check('release frees', acquireUpdateLock(roots).state === 'acquired')
releaseUpdateLock(roots)
{
  // stale lock: a dead pid is reclaimed
  mkdirSync(join(roots.versionsDir, '.update.lock'), { recursive: true })
  writeFileSync(join(roots.versionsDir, '.update.lock', 'pid'), '999999999')
  check('dead-pid lock reclaimed', acquireUpdateLock(roots).state === 'acquired')
  releaseUpdateLock(roots)
}

console.log('── §4 staged install (fresh · idempotent · replace · never-partial) ──')
{
  const out = installPayload(roots, goodPayload, '9.9.0-beta.1')
  check('fresh install lands', out.state === 'installed' && out.changed && existsSync(join(roots.versionsDir, '9.9.0-beta.1', 'mercury.mjs')))
  const again = installPayload(roots, goodPayload, '9.9.0-beta.1')
  check('identical reinstall is a truthful no-op', again.state === 'already-installed' && !again.changed)
  const p2 = join(scratch, 'payload-v2')
  makePayload(p2, '9.9.0-beta.1')
  writeFileSync(join(p2, 'mercury.mjs'), readFileSync(join(p2, 'mercury.mjs'), 'utf8') + '// differing bytes\n')
  const replaced = installPayload(roots, p2, '9.9.0-beta.1')
  check('differing same-version payload replaces after full staging', replaced.state === 'installed' && replaced.changed)
  // a same-version payload with a differing MEMBER SET is a REAL change —
  // the whole-payload digest law, never a bundle-only identity.
  const pMembers = join(scratch, 'payload-cross-members')
  makePayload(pMembers, '9.9.0-beta.1')
  writeFileSync(join(pMembers, 'NOTICES.md'), '# fixture notices\n')
  const crossed = installPayload(roots, pMembers, '9.9.0-beta.1')
  check('same-version payload with a differing member set replaces (never already-installed)', crossed.state === 'installed' && crossed.changed)
  const back = installPayload(roots, goodPayload, '9.9.0-beta.1')
  check('flip back to the original member set also replaces', back.state === 'installed' && back.changed)
  check('no staging residue', !existsSync(join(roots.versionsDir, `.staging-9.9.0-beta.1-${process.pid}`)))
  check('version listed + intact', listInstalledVersions(roots).includes('9.9.0-beta.1') && versionDirIntact(roots, '9.9.0-beta.1'))
}
{
  // a payload that goes incomplete mid-copy must write NOTHING at the target:
  // simulate by removing the launcher from the source (validation-at-staging
  // catches it after the copy, before promotion).
  const broken = join(scratch, 'payload-broken')
  makePayload(broken, '9.9.0-beta.3')
  rmSync(join(broken, 'manifest.json'))
  const out = installPayload(roots, broken, '9.9.0-beta.3')
  check('incomplete payload never promoted', out.state === 'failed' && !existsSync(join(roots.versionsDir, '9.9.0-beta.3')))
}

console.log('── §5 smoke honesty ──')
check('good payload smokes', smokeVersion(join(roots.versionsDir, '9.9.0-beta.1'), '9.9.0-beta.1').state === 'ok')
check('version mismatch fails the smoke', smokeVersion(join(roots.versionsDir, '9.9.0-beta.1'), '8.0.0-beta.1').state === 'failed')
{
  const crash = join(scratch, 'payload-crash')
  makePayload(crash, '9.9.0-beta.4', { broken: true })
  check('crashing payload fails the smoke', smokeVersion(crash, '9.9.0-beta.4').state === 'failed')
}

console.log('── §6 the stable shim (foreign files are sacred) ──')
{
  const first = writeShim(roots)
  check('fresh shim written', first.state === 'written' && first.replaced === 'nothing' && existsSync(roots.shimPath))
  check('shim carries the managed marker', readFileSync(roots.shimPath, 'utf8').includes(SHIM_MARKER))
  // D-1: the shim doesn't merely CLAIM mirroring in a comment — the full
  // chain ORDER is asserted, cross-checked against envUtils.ts's resolver.
  // A comment claiming a property no code enforces is how the drift survived.
  const CHAIN = [
    'MERCURY_VERSIONS_DIR',
    'MERCURY_CONFIG_DIR',
    'MERCURY_HOME',
    '.mercury',
  ]
  // Ordered first-occurrence of every rung in the COMMENT-STRIPPED body:
  // each rung must appear, strictly after the previous one.
  const chainOrdered = (text: string): boolean => {
    let at = -1
    for (const rung of CHAIN) {
      const i = text.indexOf(rung, at + 1)
      if (i <= at) return false
      at = i
    }
    return true
  }
  const shPosix = shimContent(false)
  const bodyPosix = shPosix.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n')
  check('posix shim resolves the FULL runtime chain in order', chainOrdered(bodyPosix), 'expected MERCURY_VERSIONS_DIR > MERCURY_CONFIG_DIR > MERCURY_HOME > ~/.mercury')
  check('posix shim default lands on ~/.mercury (the native home)', /home="\$HOME\/\.mercury"/.test(shPosix))
  const envChain = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'envUtils.ts'), 'utf8')
  check(
    'the shim chain tracks the runtime resolver (envUtils names every rung)',
    ['MERCURY_CONFIG_DIR', 'MERCURY_HOME', '.mercury'].every(r => envChain.includes(r)),
  )
  const second = writeShim(roots)
  check('identical shim is a no-op', second.state === 'current')
  // D-2: an OLDER managed shim (marker family, different version) is
  // REWRITTEN to current content — never refused as foreign.
  writeFileSync(roots.shimPath, `#!/bin/sh\n# ${SHIM_MARKER_FAMILY} v1 — the stable Mercury command.\nroot="$HOME/.mercury/versions"\nexec "$root/$(cat "$root/current.txt")/mercury" "$@"\n`)
  const upgraded = writeShim(roots)
  check('v1 managed shim is rewritten, not refused (D-2)', upgraded.state === 'written' && upgraded.replaced === 'managed-shim' && !upgraded.backupPath)
  check('rewritten shim carries the current marker', readFileSync(roots.shimPath, 'utf8').includes(SHIM_MARKER))
  // a FOREIGN file (the operator's own launcher) must never be clobbered
  writeFileSync(roots.shimPath, '#!/bin/sh\n# the operator launcher\nexec /somewhere/else "$@"\n')
  const refused = writeShim(roots)
  check('foreign file refused', refused.state === 'refused-foreign' && readFileSync(roots.shimPath, 'utf8').includes('operator launcher'))
  check('status reads foreign', shimStatus(roots) === 'foreign')
  const forced = writeShim(roots, { force: true })
  check('force replaces + keeps a .bak', forced.state === 'written' && forced.replaced === 'foreign-file' && !!forced.backupPath && readFileSync(forced.backupPath!, 'utf8').includes('operator launcher'))
  check('status reads managed again', shimStatus(roots) === 'managed')
}
{
  const win = shimContent(true)
  const winOrder = ['MERCURY_VERSIONS_DIR', 'MERCURY_CONFIG_DIR', 'MERCURY_HOME', '.mercury']
  const winBody = win.split('\r\n').filter(l => !l.trimStart().toLowerCase().startsWith('rem')).join('\r\n')
  let at = -1
  let ordered = true
  for (const rung of winOrder) {
    const i = winBody.indexOf(rung, at + 1)
    if (i <= at) { ordered = false; break }
    at = i
  }
  check('windows shim carries marker + CRLF + the full ordered chain', win.includes(SHIM_MARKER) && win.includes('\r\n') && ordered)
  check('windows shim fresh-default lands on ~/.mercury', winBody.includes('set "MHOME=%USERPROFILE%\\.mercury"'))
}

console.log('── §6b the shim chain is EXACT: each rung once, and the sh shim resolves LIVE in rung order ──')
{
  // The ordered-chain check above pins the rung ORDER; this leg pins the
  // other half of the class — a rung may appear exactly ONCE, and the chain
  // must resolve the way the runtime resolver does when driven for real.
  const envRungs = ['MERCURY_VERSIONS_DIR', 'MERCURY_CONFIG_DIR', 'MERCURY_HOME']
  const countIn = (text: string, needle: string): number => text.split(needle).length - 1
  const shBody = shimContent(false).split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n')
  const shCounts = envRungs.map(r => `${r}=${countIn(shBody, `\${${r}:-}`)}`).join(' ')
  check('posix shim: every env rung is tested exactly once (no duplicated rung)', envRungs.every(r => countIn(shBody, `\${${r}:-}`) === 1), shCounts)
  const cmdBody = shimContent(true).split('\r\n').filter(l => !l.trimStart().toLowerCase().startsWith('rem')).join('\r\n')
  const cmdCounts = envRungs.map(r => `${r}=${countIn(cmdBody, `if defined ${r} `)}`).join(' ')
  check('windows shim: every env rung is tested exactly once (no duplicated rung)', envRungs.every(r => countIn(cmdBody, `if defined ${r} `) === 1), cmdCounts)

  if (process.platform === 'win32') {
    console.log('  [SKIP] live sh drive — POSIX hosts only (the cmd shim executes on the windows-launcher lane)')
  } else {
    const live = mkdtempSync(join(tmpdir(), 'shim-live-'))
    const shim = join(live, 'mercury')
    writeFileSync(shim, shimContent(false))
    chmodSync(shim, 0o755)
    // One fixture versions root per rung; each root's launcher answers with
    // the rung that selected it, so the shim's choice is observable.
    const mkRoot = (root: string, label: string): void => {
      mkdirSync(join(root, '9.9.0-beta.1'), { recursive: true })
      writeFileSync(join(root, 'current.txt'), '9.9.0-beta.1\n')
      const launcher = join(root, '9.9.0-beta.1', 'mercury')
      writeFileSync(launcher, `#!/bin/sh\necho "${label} $*"\n`)
      chmodSync(launcher, 0o755)
    }
    const home = join(live, 'home')
    mkdirSync(home, { recursive: true })
    const r = { MVD: join(live, 'mvd'), MCD: join(live, 'mcd'), MH: join(live, 'mh') }
    mkRoot(r.MVD, 'rung-MERCURY_VERSIONS_DIR')
    mkRoot(join(r.MCD, 'versions'), 'rung-MERCURY_CONFIG_DIR')
    mkRoot(join(r.MH, 'versions'), 'rung-MERCURY_HOME')
    // env -i semantics: ONLY the rungs under test + HOME + PATH reach the shim.
    const run = (env: Record<string, string>): string =>
      spawnSync('sh', [shim, '--version'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env }, encoding: 'utf8' }).stdout.trim()
    const all = { MERCURY_VERSIONS_DIR: r.MVD, MERCURY_CONFIG_DIR: r.MCD, MERCURY_HOME: r.MH }
    check('live: MERCURY_VERSIONS_DIR wins over every lower rung', run(all) === 'rung-MERCURY_VERSIONS_DIR --version')
    check('live: MERCURY_CONFIG_DIR wins over MERCURY_HOME', run({ MERCURY_CONFIG_DIR: r.MCD, MERCURY_HOME: r.MH }) === 'rung-MERCURY_CONFIG_DIR --version')
    check('live: MERCURY_HOME alone resolves the install', run({ MERCURY_HOME: r.MH }) === 'rung-MERCURY_HOME --version')
    check('live: no env rung and no ~/.mercury ⇒ the honest no-install refusal', run({}) === '')
    mkRoot(join(home, '.mercury', 'versions'), 'rung-dot-mercury')
    check('live: ~/.mercury resolves the install when no env rung is set', run({}) === 'rung-dot-mercury --version')
    rmSync(live, { recursive: true, force: true })
  }
}

console.log('── §7 uninstall preserves the config home ──')
{
  const configMarker = join(scratch, 'home', '.mercury', 'settings.json')
  mkdirSync(join(scratch, 'home', '.mercury'), { recursive: true })
  writeFileSync(configMarker, '{"user":"state"}\n')
  const report = uninstallLayout(roots)
  check('versions dir removed', report.removedVersionsDir && !existsSync(roots.versionsDir))
  check('managed shim removed', report.removedShim && !existsSync(roots.shimPath))
  check('config home untouched', existsSync(configMarker))
  check('uninstall names the preserved home', report.preservedConfigHome === process.env.MERCURY_CONFIG_DIR)
  // uninstall with a FOREIGN shim present leaves it alone
  mkdirSync(roots.binDir, { recursive: true })
  writeFileSync(roots.shimPath, '#!/bin/sh\n# operator launcher again\n')
  const second = uninstallLayout(roots)
  check('foreign shim survives uninstall', !second.removedShim && existsSync(roots.shimPath))
}

console.log('── §7a uninstall removals route the win32 transient-lock law ──')
{
  // Uninstall removals route through the same bounded-retry law as the
  // renames (every activation-path mutation consults the seam). Same shape
  // as §15 SM-I: an unbounded fault throws, EPERM twice then
  // success completes, and a POSIX layout keeps single-attempt semantics.
  const mkLayout = (name: string, isWindows: boolean): LayoutRoots => {
    const bin = join(scratch, `${name}-bin`)
    const versions = join(scratch, `${name}-versions`)
    mkdirSync(join(versions, '9.9.0-beta.1'), { recursive: true })
    writeFileSync(join(versions, '9.9.0-beta.1', 'mercury.mjs'), '// payload\n')
    writeFileSync(join(versions, 'current.txt'), '9.9.0-beta.1\n')
    mkdirSync(bin, { recursive: true })
    const shimPath = join(bin, isWindows ? 'mercury.cmd' : 'mercury')
    const roots: LayoutRoots = isWindows
      ? { versionsDir: versions, binDir: bin, shimPath, shimSetPaths: [shimPath, join(bin, 'mercury')], isWindows }
      : { versionsDir: versions, binDir: bin, shimPath, isWindows }
    for (const p of roots.shimSetPaths ?? [shimPath]) writeFileSync(p, p.endsWith('.cmd') ? shimContent(true) : shimContent(false))
    return roots
  }
  process.env.MERCURY_UPDATE_FAULT = 'uninstall-rm'
  const unbounded = mkLayout('un-unbounded', true)
  let threw = false
  try {
    uninstallLayout(unbounded)
  } catch {
    threw = true
  }
  check('win32 uninstall: an unbounded transient fault surfaces (the seam is consulted)', threw && existsSync(unbounded.versionsDir))
  process.env.MERCURY_UPDATE_FAULT = 'uninstall-rm:2'
  const bounded = mkLayout('un-bounded', true)
  const report = uninstallLayout(bounded)
  check('win32 uninstall: EPERM twice then success — the removal completes through the bounded retry',
    report.removedVersionsDir && !existsSync(bounded.versionsDir) && report.removedSetMembers.length === 2 && !existsSync(bounded.shimPath) && !existsSync(join(bounded.binDir, 'mercury')))
  process.env.MERCURY_UPDATE_FAULT = 'uninstall-rm:1'
  const posix = mkLayout('un-posix', false)
  let posixThrew = false
  try {
    uninstallLayout(posix)
  } catch {
    posixThrew = true
  }
  check('POSIX uninstall keeps single-attempt semantics (a transient code is not retried off win32)', posixThrew && existsSync(posix.versionsDir))
  delete process.env.MERCURY_UPDATE_FAULT
  const clean = uninstallLayout(posix)
  check('with the seam cleared the POSIX uninstall completes', clean.removedVersionsDir && !existsSync(posix.versionsDir) && !existsSync(posix.shimPath))
}

console.log('── §7b the uninstall report names every launcher-set member ──')
{
  // The text report the operator reads (`mercury install --uninstall`) is a
  // pure projection of the layout's report: on win32 BOTH members settle
  // visibly — the façade's fate was silent before (only the primary was
  // named), so a preserved foreign façade or an absent one left the reader
  // guessing what step 5 of an uninstall packet should prove.
  const winBin = join(scratch, 'report-bin')
  const winRoots: LayoutRoots = {
    versionsDir: join(scratch, 'report-versions'),
    binDir: winBin,
    shimPath: join(winBin, 'mercury.cmd'),
    shimSetPaths: [join(winBin, 'mercury.cmd'), join(winBin, 'mercury')],
    isWindows: true,
  }
  const mixed = formatUninstallReport(winRoots, {
    removedVersionsDir: true,
    removedShim: true,
    removedSetMembers: [join(winBin, 'mercury.cmd')],
    preservedForeign: [join(winBin, 'mercury')],
    preservedConfigHome: join(scratch, 'report-home'),
  }).split('\n')
  check('report: versions dir, BOTH members, and the home — one line each (4 lines)', mixed.length === 4, mixed.join(' | '))
  check('report: the removed cmd member is named', mixed[1] === `removed: ${join(winBin, 'mercury.cmd')}`)
  check('report: the preserved foreign façade is named as preserved, never as removed', mixed[2] === `preserved (not a Mercury-managed command — left as found): ${join(winBin, 'mercury')}`)
  check('report: the config home line states the preserve law', mixed[3].startsWith(`preserved: ${join(scratch, 'report-home')} (configuration, sessions, extensions`))
  const nothing = formatUninstallReport(winRoots, { removedVersionsDir: false, removedShim: false, removedSetMembers: [], preservedForeign: [], preservedConfigHome: '/h' }).split('\n')
  check('report: an empty layout says "nothing to remove" for the dir and each absent member', nothing[0].startsWith('nothing to remove at ') && nothing[1].endsWith('mercury.cmd (absent)') && nothing[2].endsWith('mercury (absent)'))
  const posixRoots: LayoutRoots = { versionsDir: join(scratch, 'rp-versions'), binDir: join(scratch, 'rp-bin'), shimPath: join(scratch, 'rp-bin', 'mercury'), isWindows: false }
  const posix = formatUninstallReport(posixRoots, { removedVersionsDir: true, removedShim: true, removedSetMembers: [posixRoots.shimPath], preservedForeign: [], preservedConfigHome: '/h' }).split('\n')
  check('report: the POSIX set is the single sh member (3 lines)', posix.length === 3 && posix[1] === `removed: ${posixRoots.shimPath}`)
}

console.log('── §8 the whole-payload digest law (runtime twin ≡ payloadContract) ──')
{
  const twin = join(scratch, 'digest-twin')
  makePayload(twin, '9.9.0-beta.5')
  const contract = (await import('../release/payloadContract.mjs')) as { payloadDigestOf: (dir: string) => string }
  check('one digest law, two implementations agree on one fixture tree', payloadDigestOf(twin) === contract.payloadDigestOf(twin), `${payloadDigestOf(twin).slice(0, 12)} vs ${contract.payloadDigestOf(twin).slice(0, 12)}`)
  const before = payloadDigestOf(twin)
  writeFileSync(join(twin, 'manifest.json'), JSON.stringify({ version: '9.9.0-beta.5', extra: true }) + '\n')
  check('top-level manifest.json is excluded (it will carry the digest)', payloadDigestOf(twin) === before)
  writeFileSync(join(twin, 'mercury'), '#!/bin/sh\n# a DIFFERENT launcher\n')
  check('any other member change moves the digest', payloadDigestOf(twin) !== before)
}

console.log('── §9 complete artifact identity (UPD-09 — bundle-sha alone is not equality) ──')
{
  rmSync(process.env.MERCURY_VERSIONS_DIR!, { recursive: true, force: true })
  const base = join(scratch, 'identity-base')
  makePayload(base, '9.9.0-beta.6')
  check('fresh install lands', installPayload(roots, base, '9.9.0-beta.6').state === 'installed')
  check('byte-identical payload is already-installed', installPayload(roots, base, '9.9.0-beta.6').state === 'already-installed')
  const launcherOnly = join(scratch, 'identity-launcher')
  makePayload(launcherOnly, '9.9.0-beta.6')
  writeFileSync(join(launcherOnly, 'mercury'), readFileSync(join(launcherOnly, 'mercury'), 'utf8') + '# changed launcher\n')
  const replaced = installPayload(roots, launcherOnly, '9.9.0-beta.6')
  check('same bundle + DIFFERENT launcher is a real change (replaces)', replaced.state === 'installed' && replaced.changed === true)
  check('the replaced install carries the new launcher bytes', readFileSync(join(roots.versionsDir, '9.9.0-beta.6', 'mercury'), 'utf8').includes('# changed launcher'))
}

console.log('── §10 displaced-restore on promote failure (UPD-08) ──')
{
  const v = '9.9.0-beta.7'
  const orig = join(scratch, 'restore-orig')
  makePayload(orig, v)
  installPayload(roots, orig, v)
  const marker = readFileSync(join(roots.versionsDir, v, 'mercury.mjs'), 'utf8')
  const next = join(scratch, 'restore-next')
  makePayload(next, v)
  writeFileSync(join(next, 'mercury.mjs'), readFileSync(join(next, 'mercury.mjs'), 'utf8') + '// v2\n')
  process.env.MERCURY_UPDATE_FAULT = 'promote-rename'
  const failed = installPayload(roots, next, v)
  delete process.env.MERCURY_UPDATE_FAULT
  check('injected promote failure reports failed + restored wording', failed.state === 'failed' && failed.note.includes('restored'), failed.state === 'failed' ? failed.note : failed.state)
  check('the working copy is BACK at its exact location (not parked)', existsSync(join(roots.versionsDir, v, 'mercury.mjs')) && readFileSync(join(roots.versionsDir, v, 'mercury.mjs'), 'utf8') === marker)
  check('no .replaced-* residue after the restore', !existsSync(join(roots.versionsDir, `.replaced-${v}-${process.pid}`)))
  check('no staging residue after the failure', !existsSync(join(roots.versionsDir, `.staging-${v}-${process.pid}`)))
  const retried = installPayload(roots, next, v)
  check('retry without the fault succeeds (idempotent recovery)', retried.state === 'installed')

  // restore ALSO failing: the error names the parked dir for a human
  process.env.MERCURY_UPDATE_FAULT = 'promote-rename,restore-rename'
  const doubleFail = installPayload(roots, orig, v)
  delete process.env.MERCURY_UPDATE_FAULT
  check('restore-failure names the parked dir', doubleFail.state === 'failed' && doubleFail.note.includes(`.replaced-${v}-${process.pid}`), doubleFail.state === 'failed' ? doubleFail.note : doubleFail.state)
  // put the parked copy back for the next sections
  const parked = join(roots.versionsDir, `.replaced-${v}-${process.pid}`)
  if (existsSync(parked) && !existsSync(join(roots.versionsDir, v))) {
    const { renameSync } = await import('node:fs')
    renameSync(parked, join(roots.versionsDir, v))
  }
}

console.log('── §11 win32 bounded rename retry (transient-lock class, injection-proved) ──')
{
  const winRoots = { ...roots, isWindows: true }
  const v = '9.9.0-beta.8'
  const p1 = join(scratch, 'retry-p1')
  makePayload(p1, v)
  process.env.MERCURY_UPDATE_FAULT = 'promote-rename:2'
  const transient = installPayload(winRoots, p1, v)
  delete process.env.MERCURY_UPDATE_FAULT
  check('EPERM twice then success: bounded retry completes the install', transient.state === 'installed', transient.state === 'failed' ? transient.note : transient.state)
  const p2 = join(scratch, 'retry-p2')
  makePayload(p2, v)
  writeFileSync(join(p2, 'mercury.mjs'), readFileSync(join(p2, 'mercury.mjs'), 'utf8') + '// retry-v2\n')
  process.env.MERCURY_UPDATE_FAULT = 'promote-rename'
  const exhausted = installPayload(winRoots, p2, v)
  delete process.env.MERCURY_UPDATE_FAULT
  check('exhausted retry reports failed + RETRYABLE', exhausted.state === 'failed' && exhausted.retryable === true, exhausted.state === 'failed' ? exhausted.note : exhausted.state)
  check('exhausted retry restored the working copy', existsSync(join(roots.versionsDir, v, 'mercury.mjs')) && !readFileSync(join(roots.versionsDir, v, 'mercury.mjs'), 'utf8').includes('retry-v2'))
  // POSIX roots never retry: one injected transient error fails immediately
  process.env.MERCURY_UPDATE_FAULT = 'promote-rename:1'
  const posixOnce = installPayload(roots, p2, v)
  delete process.env.MERCURY_UPDATE_FAULT
  check('non-windows roots do NOT retry the transient class', posixOnce.state === 'failed')
}

console.log('── §12 lock release is owner-checked (UPD-10) ──')
{
  const lockDir = join(roots.versionsDir, '.update.lock')
  rmSync(lockDir, { recursive: true, force: true })
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(lockDir, 'pid'), '999999999')
  releaseUpdateLock(roots)
  check('a FOREIGN lock survives releaseUpdateLock', existsSync(lockDir))
  check('the dead foreign lock is reclaimed by the next acquire', acquireUpdateLock(roots).state === 'acquired')
  releaseUpdateLock(roots)
  check('an owned lock releases normally', !existsSync(lockDir))
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(lockDir, 'pid'), String(process.ppid))
  releaseUpdateLock(roots)
  check('a LIVE foreign lock survives release AND blocks acquire', existsSync(lockDir) && acquireUpdateLock(roots).state === 'held')
  rmSync(lockDir, { recursive: true, force: true })
}

console.log('── §13 reconciling sweep (dead-pid residue; parked copies RESTORED) ──')
{
  const dead = '999999999'
  const vGone = '9.8.0-beta.1'
  const vHere = '9.9.0-beta.8'
  mkdirSync(join(roots.versionsDir, `.download-${dead}`), { recursive: true })
  writeFileSync(join(roots.versionsDir, `.download-${dead}`, 'partial'), 'bytes')
  mkdirSync(join(roots.versionsDir, `.staging-${vGone}-${dead}`), { recursive: true })
  makePayload(join(roots.versionsDir, `.replaced-${vGone}-${dead}`), vGone)
  rmSync(join(roots.versionsDir, vGone), { recursive: true, force: true })
  mkdirSync(join(roots.versionsDir, `.replaced-${vHere}-${dead}`), { recursive: true })
  writeFileSync(join(roots.versionsDir, `current.txt.tmp.${dead}`), 'orphan')
  mkdirSync(join(roots.versionsDir, `.download-${process.pid}`), { recursive: true })
  const report = sweepUpdaterResidue(roots)
  check('dead download + staging + pointer-tmp removed', !existsSync(join(roots.versionsDir, `.download-${dead}`)) && !existsSync(join(roots.versionsDir, `.staging-${vGone}-${dead}`)) && !existsSync(join(roots.versionsDir, `current.txt.tmp.${dead}`)))
  check('parked .replaced-* with ABSENT version dir is RESTORED, not deleted', existsSync(join(roots.versionsDir, vGone, 'mercury.mjs')) && report.restored.includes(`.replaced-${vGone}-${dead}`))
  check('parked .replaced-* with PRESENT version dir is garbage (removed)', !existsSync(join(roots.versionsDir, `.replaced-${vHere}-${dead}`)))
  check('OWN-pid residue is untouched (a live transaction owns it)', existsSync(join(roots.versionsDir, `.download-${process.pid}`)))
  rmSync(join(roots.versionsDir, `.download-${process.pid}`), { recursive: true, force: true })
}

console.log('── §14 pointer tri-state (UPD-11 — absent · empty · unreadable are distinct) ──')
{
  rmSync(join(roots.versionsDir, 'current.txt'), { force: true })
  check('absent is its own state', readCurrentVersionState(roots).state === 'absent')
  writeFileSync(join(roots.versionsDir, 'current.txt'), '\n')
  check('empty is its own state', readCurrentVersionState(roots).state === 'empty')
  writeFileSync(join(roots.versionsDir, 'current.txt'), '9.9.0-beta.8\n')
  check('a value reads ok', (() => { const s = readCurrentVersionState(roots); return s.state === 'ok' && s.value === '9.9.0-beta.8' })())
  process.env.MERCURY_UPDATE_FAULT = 'pointer-read'
  check('unreadable is its own state (injected)', readCurrentVersionState(roots).state === 'unreadable')
  delete process.env.MERCURY_UPDATE_FAULT
  if (process.platform !== 'win32') {
    const { chmodSync: chmod } = await import('node:fs')
    chmod(join(roots.versionsDir, 'current.txt'), 0o000)
    check('unreadable is its own state (real EACCES)', readCurrentVersionState(roots).state === 'unreadable')
    chmod(join(roots.versionsDir, 'current.txt'), 0o644)
  }
  check('the compat reader collapses only for legacy callers', readCurrentVersion(roots) === '9.9.0-beta.8')
}

console.log('── §15 seamark SM-I: activation renames + PATH identity + hostile roots ──')
{
  // Both activation renames (shim swap, pointer swap) must route the win32
  // transient-lock law. Expect-red history: at pre-fix HEAD neither consulted
  // its seam, so the unbounded-fault legs FAILED (the calls succeeded).
  const winBin = join(scratch, 'win-bin')
  const winRoots = { versionsDir: join(scratch, 'win-versions'), binDir: winBin, shimPath: join(winBin, 'mercury.cmd'), isWindows: true }
  process.env.MERCURY_UPDATE_FAULT = 'shim-rename'
  let shimThrew = false
  try {
    writeShim(winRoots)
  } catch {
    shimThrew = true
  }
  check('SM-I: the shim swap consults the transient-lock seam (unbounded fault throws)', shimThrew)
  process.env.MERCURY_UPDATE_FAULT = 'shim-rename:2'
  const healed = writeShim(winRoots)
  check('SM-I: EPERM twice then success — the shim swap completes through the bounded retry', healed.state === 'written')
  process.env.MERCURY_UPDATE_FAULT = 'pointer-rename-current'
  let ptrThrew = false
  try {
    switchCurrent(winRoots, '9.9.1-beta.1')
  } catch {
    ptrThrew = true
  }
  check('SM-I: the pointer swap consults the transient-lock seam (unbounded fault throws)', ptrThrew)
  process.env.MERCURY_UPDATE_FAULT = 'pointer-rename-current:2'
  switchCurrent(winRoots, '9.9.1-beta.2')
  check('SM-I: pointer swap completes through the bounded retry', readCurrentVersion(winRoots) === '9.9.1-beta.2')
  delete process.env.MERCURY_UPDATE_FAULT
}
{
  // PATH membership is an identity question, not a string question:
  // trailing separators stripped, win32 case-folded, aliases equated only
  // when the filesystem verifies them.
  const real = join(scratch, 'path-target')
  mkdirSync(real, { recursive: true })
  const alias = join(scratch, 'path-alias')
  symlinkSync(real, alias)
  check('PATH identity: exact match', pathEntryEquals(real, real, false))
  check('PATH identity: trailing slash is spelling, not identity', pathEntryEquals(`${real}/`, real, false))
  check('PATH identity: a verified symlink alias equates (realpath-verified)', pathEntryEquals(alias, real, false))
  check('PATH identity: win32 folds case + trailing backslash (lexical on absent roots)', pathEntryEquals('X:\\Ghost\\BIN\\', 'x:\\ghost\\bin', true))
  check('PATH identity: POSIX stays case-sensitive (absent roots compare lexically)', !pathEntryEquals('/nonexistent-smi/BIN', '/nonexistent-smi/bin', false))
  check('PATH identity: different dirs never equate', !pathEntryEquals(join(scratch, 'other'), real, false))
  check('PATH identity: empty entry never matches', !pathEntryEquals('', real, false))
}
{
  // Install/activate/shim/smoke inside a spaced + Unicode root.
  const uniHome = join(scratch, 'Inställ Röot with spaces')
  const uniBin = join(uniHome, '.local', 'bin')
  const uniRoots = { versionsDir: join(uniHome, 'versions'), binDir: uniBin, shimPath: join(uniBin, 'mercury'), isWindows: false }
  const uniPayload = join(scratch, 'payload-uni')
  makePayload(uniPayload, '9.9.2-beta.1')
  const inst = installPayload(uniRoots, uniPayload, '9.9.2-beta.1')
  check('SM-I: install into a spaced+Unicode root succeeds', inst.state === 'installed')
  switchCurrent(uniRoots, '9.9.2-beta.1')
  check('SM-I: pointer swap in the spaced+Unicode root', readCurrentVersion(uniRoots) === '9.9.2-beta.1')
  const uniShim = writeShim(uniRoots)
  check('SM-I: shim written in the spaced+Unicode root', uniShim.state === 'written')
  const uniSmoke = smokeVersion(join(uniRoots.versionsDir, '9.9.2-beta.1'), '9.9.2-beta.1')
  check('SM-I: installed copy smokes from the spaced+Unicode root', uniSmoke.state === 'ok', uniSmoke.state === 'failed' ? uniSmoke.note : '')
}

// ── 5.1b (LN-01..21): the managed LAUNCHER SET ──────────────────────────────
{
  console.log('\n── LN · the launcher set (git-bash facade + one lifecycle) ──')
  const setScratch = mkdtempSync(join(tmpdir(), 'ln-set-'))
  const winBin = join(setScratch, 'bin')
  const winRoots2 = {
    versionsDir: join(setScratch, 'versions'),
    binDir: winBin,
    shimPath: join(winBin, 'mercury.cmd'),
    shimSetPaths: [join(winBin, 'mercury.cmd'), join(winBin, 'mercury')],
    isWindows: true,
  }
  const setOut = writeShim(winRoots2)
  check('LN-01/03: the win32 set writes BOTH members (cmd + extensionless sh facade), complete', setOut.set.complete && setOut.set.members.length === 2)
  const facade = readFileSync(join(winBin, 'mercury'), 'utf8')
  check('LN-21: the facade is LF + shebang (no CRLF anywhere)', facade.startsWith('#!/bin/sh\n') && !facade.includes('\r'))
  check('LN-07: ONE delegation — the facade probes the versioned mercury.cmd first, else the POSIX launcher (no second version selection)',
    facade.includes('if [ -f "$root/$ver/mercury.cmd" ]; then exec "$root/$ver/mercury.cmd" "$@"; fi') &&
    facade.includes('exec "$root/$ver/mercury" "$@"') &&
    facade.includes('current.txt'))
  check('LN-02: both members carry the managed marker family', facade.includes(SHIM_MARKER_FAMILY) && readFileSync(winRoots2.shimPath, 'utf8').includes(SHIM_MARKER_FAMILY))
  // LN-19/20: a foreign file at ONE member path ⇒ the set never reports complete.
  writeFileSync(join(winBin, 'mercury'), '#!/bin/sh\n# operator-owned launcher\n')
  const partial = writeShim(winRoots2)
  check('LN-19/20: a foreign member refuses and the set reports INCOMPLETE (never a false complete)',
    !partial.set.complete && partial.set.members.some(m => m.state === 'refused-foreign'))
  // LN-08..12: uninstall removes managed members, PRESERVES the foreign one.
  const un = uninstallLayout(winRoots2)
  check('LN-08..12: uninstall removes the managed cmd member and PRESERVES (names) the foreign facade',
    un.removedSetMembers.includes(winRoots2.shimPath) && un.preservedForeign.includes(join(winBin, 'mercury')) && existsSync(join(winBin, 'mercury')))
  // POSIX roots: the set is the single sh member — byte-identical behavior.
  const posixBin = join(setScratch, 'pbin')
  const posixRoots = {
    versionsDir: join(setScratch, 'pversions'),
    binDir: posixBin,
    shimPath: join(posixBin, 'mercury'),
    shimSetPaths: [join(posixBin, 'mercury')],
    isWindows: false,
  }
  const pOut = writeShim(posixRoots)
  check('LN: the POSIX set is the single sh member (unchanged single-launcher behavior)', pOut.set.members.length === 1 && pOut.set.complete)
  // LN-15/16 local half: the hermetic shadowed-PATH fixture — the facade
  // resolves through a PATH whose bin dir fronts a shadowing mingw64-style
  // entry (content-level: the facade text has no PATH dependence at all —
  // it execs ABSOLUTE versioned paths, so shadowing cannot re-route it).
  check('LN-15/16 (hermetic half): the facade delegates by ABSOLUTE versioned path — PATH shadowing cannot re-route the exec',
    !/exec (?!")/.test(facade.split('current.txt')[1] ?? '') && facade.includes('exec "$root/$ver/'))
  rmSync(setScratch, { recursive: true, force: true })
}

// ── VP-01: the stable cmd shim survives its own pointer file ───
// current.txt is the ONE hand-editable recovery file, and the old shim read
// it with `set /p` — the class (a product/operator-written file
// crossing into cmd command construction). The shim now reads FIRST LINE
// ONLY via for /f (an embedded newline can never reach %MVER%) and refuses
// a pointer that names no installed version, without ever echoing pointer
// content back through a parsed line.
{
  console.log('\n── VP-01 · the cmd shim pointer read (first-line law) ──')
  const cmdShim = shimContent(true)
  check('VP-01: current.txt is read first-line-only (for /f; no functional set /p line)',
    cmdShim.includes('for /f "usebackq delims=" %%v in ("%MROOT%\\current.txt")') &&
      !cmdShim.split('\r\n').some(l => !l.trim().startsWith('rem') && l.includes('set /p')))
  check('VP-01: an empty pointer refuses plainly (exit 1, named remedy)', cmdShim.includes('if not defined MVER ('))
  check('VP-01: a pointer naming no installed version refuses BEFORE the call', cmdShim.includes('if not exist "%MROOT%\\%MVER%\\mercury.cmd" (') && cmdShim.indexOf('if not exist "%MROOT%\\%MVER%\\mercury.cmd"') !== -1 && cmdShim.indexOf('if not exist "%MROOT%\\%MVER%\\mercury.cmd"') < cmdShim.indexOf('call "%MROOT%\\%MVER%\\mercury.cmd"'))
  check('VP-01: the refusal never echoes pointer content into a parsed line', !cmdShim.split('\r\n').some(l => l.includes('echo') && l.includes('%MVER%')))
  // parity: the sh members (POSIX shim + win32 git-bash facade share ONE
  // text) read the pointer with cmd's EXACT semantics — `for /f` skips blank
  // lines, so the sh read is a first-NON-BLANK-line `read -r` loop (
  // D4); one hand-edited pointer file resolves identically in both families.
  const shShim = shimContent(false)
  check('VP-01 parity: the sh shim reads current.txt first-non-blank-line (IFS= read -r loop, no cat)',
    shShim.includes('while IFS= read -r ver; do [ -n "$ver" ] && break; done < "$root/current.txt"') &&
      !shShim.includes('$(cat "$root/current.txt")'))
  check('VP-01 parity: the sh shim refuses an empty pointer plainly', shShim.includes('[ -z "$ver" ]'))
}

// ──: the runtime reconciles its OWN launcher set ─────────
// The update flow publishes shims with the PREVIOUS version's member list
// (the updater that installs N is N-1's code), so the win32 git-bash facade
// never reached updated installs — the field box's bin dir was
// last written by `install` and every later update found the primary shim
// byte-current. reconcileManagedShims is the self-heal: managed installs
// complete their member set at verb entry / post-activation; portable use
// and foreign files stay untouched.
{
  console.log('\n── BM-31 · reconcileManagedShims (the runtime self-heal) ──')
  const bmScratch = mkdtempSync(join(tmpdir(), 'bm31-'))
  const bmBin = join(bmScratch, 'bin')
  const bmRoots = {
    versionsDir: join(bmScratch, 'versions'),
    binDir: bmBin,
    shimPath: join(bmBin, 'mercury.cmd'),
    shimSetPaths: [join(bmBin, 'mercury.cmd'), join(bmBin, 'mercury')],
    isWindows: true,
  }
  // portable (no managed install): a strict no-op — nothing is planted
  check('BM-31: no managed install ⇒ null, nothing written', reconcileManagedShims(bmRoots) === null && !existsSync(bmBin))
  // the FIELD SHAPE: a managed install whose bin dir predates the facade —
  // primary shim current, facade member absent
  const bmPayload = join(bmScratch, 'payload')
  makePayload(bmPayload, '9.9.3-beta.1')
  installPayload(bmRoots, bmPayload, '9.9.3-beta.1')
  switchCurrent(bmRoots, '9.9.3-beta.1')
  mkdirSync(bmBin, { recursive: true })
  writeFileSync(bmRoots.shimPath, shimContent(true))
  check('BM-31 fixture: facade absent before the heal (the updated-install field shape)', !existsSync(join(bmBin, 'mercury')))
  const healed = reconcileManagedShims(bmRoots)
  check('BM-31: the heal completes the member set (facade written, primary kept current)',
    healed !== null && healed.complete && existsSync(join(bmBin, 'mercury')) &&
    healed.members.some(m => m.state === 'written') && healed.members.some(m => m.state === 'current'))
  const healedAgain = reconcileManagedShims(bmRoots)
  check('BM-31: idempotent — a second heal writes nothing (both members current)',
    healedAgain !== null && healedAgain.complete && healedAgain.members.every(m => m.state === 'current'))
  // foreign discipline unchanged: an operator-owned file is refused, never clobbered
  writeFileSync(join(bmBin, 'mercury'), '#!/bin/sh\n# operator-owned launcher\n')
  const refusedHeal = reconcileManagedShims(bmRoots)
  check('BM-31: a foreign member refuses (never clobbered, set reports incomplete)',
    refusedHeal !== null && !refusedHeal.complete && readFileSync(join(bmBin, 'mercury'), 'utf8').includes('operator-owned'))
  rmSync(bmScratch, { recursive: true, force: true })
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
if (failures === 0) {
  console.log('PASS prove-install-layout')
  process.exit(0)
}
console.log(`FAIL prove-install-layout (${failures})`)
process.exit(1)
