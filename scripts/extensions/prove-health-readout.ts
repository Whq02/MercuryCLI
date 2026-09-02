#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-health-readout.ts — ONE owner, three outcomes,
//  always a reason.
//
//  §1 every BROKEN probe: folder gone · manifest missing · manifest invalid
//     (field path in the reason) · record/copy version lie · tampered copy
//     (content hash) · Mercury floor unmet · escaping path · `module`.
//  §2 every PARTIAL probe: missing skills dir · empty commands dir · a
//     SKILL.md whose frontmatter fails · a hook whose script is missing /
//     not executable · an unknown hook event · a stdio server not on PATH ·
//     a language server not on PATH · a channel naming no server · a
//     missing binary · an unset env · an unset required option · a
//     keybinding to another extension's command; an agent's ignored
//     privileged fields are NOTES, never defects.
//  §3 the runtime facts (from the managers, live): a failed server, a
//     crashed language server, counted hook failures, dropped channel posts.
//  §4 ONE owner: the row line, the /health row and the readiness rows all
//     derive from the same computation — a renderer handed different facts
//     cannot disagree.
//  §5 `mercury extensions list` carries the word + first reason; `--json`
//     the full reason list.
// ============================================================================
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-health-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(cwd)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const paths = await import('../../src/extensions/paths.ts')
const records = await import('../../src/extensions/records.ts')
const sources = await import('../../src/extensions/sources.ts')
const install = await import('../../src/extensions/install.ts')
const rosterMod = await import('../../src/extensions/roster.ts')
const health = await import('../../src/extensions/health.ts')
const boot = await import('../../src/extensions/boot.ts')
const activeMod = await import('../../src/extensions/active.ts')
const cli = await import('../../src/extensions/cli.ts')
const manifestMod = await import('../../src/extensions/manifest.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'FAIL' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`.replace('[FAIL]', cond ? '[PASS]' : '[FAIL]'))
}
const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')

function entryFor(id: string): NonNullable<ReturnType<typeof rosterMod.computeRoster>['entries'][number]> {
  const entry = rosterMod.computeRoster({ cwd }).entries.find(e => e.id === id)
  if (!entry) throw new Error(`no roster entry ${id}`)
  return entry
}
const probes = { onPath: (b: string) => b === 'node', envSet: () => false, chordTaken: () => false, optionSet: () => false }

console.log('============================================================')
console.log(' health — one owner, three outcomes, always a reason')
console.log('============================================================')

const added = await sources.addSource(FIXTURE, { label: 'fixture-source' })
check('fixture source adds', added.ok)

// ── §1 broken ───────────────────────────────────────────────────────────────
console.log('[1] broken: each probe with its reason')
{
  const installed = await install.installFromSource('fixture-source', 'kitchen-sink')
  check('install lands', installed.ok)
  check('approve lands', install.approve('kitchen-sink@fixture-source').ok)
  const id = 'kitchen-sink@fixture-source'
  const root = installed.ok ? installed.root : ''

  // folder gone
  const record = records.installedOrEmpty()[id]!
  rmSync(root, { recursive: true, force: true })
  let h = health.computeHealth(entryFor(id), {}, { probes })
  check('folder gone ⇒ broken with the path', h.health.outcome === 'broken' && h.health.reasons[0]!.includes('folder missing'), h.health.reasons.join('; '))

  // restore, then a version lie (record says 1.0.0, copy says 9.9.9)
  cpSync(join(FIXTURE, 'kitchen-sink'), root, { recursive: true })
  const manifestPath = join(root, 'mercury-extension.json')
  const manifest = JSON.parse(require('node:fs').readFileSync(manifestPath, 'utf8'))
  manifest.version = '9.9.9'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  h = health.computeHealth(entryFor(id), {}, { probes })
  check('a version lie ⇒ broken naming both', h.health.outcome === 'broken' && h.health.reasons[0] === 'record says 1.0.0, copy says 9.9.9', h.health.reasons.join('; '))

  // tampered content (version right, bytes differ from the recorded hash)
  manifest.version = '1.0.0'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  writeFileSync(join(root, 'README.md'), 'tampered\n')
  h = health.computeHealth(entryFor(id), {}, { probes })
  check('a tampered copy ⇒ broken "changed since install"', h.health.outcome === 'broken' && h.health.reasons[0]!.includes('changed since install'), h.health.reasons.join('; '))
  // The session's truth across the swap: a broken-but-WANTED copy (approved,
  // switched on, nothing loads) stays ✕ broken on every roster read after a
  // reload — never ◐ reload. The published snapshot must carry every entry
  // the swap considered, loading or not; a snapshot of the loaded set alone
  // made the next read see "wanted, not live" and paint pending forever.
  // The broken shape here is a VERSION LIE (record vs copy) with the
  // delivered bytes restored: the approval hash covers every delivered
  // byte but not the manifest's own, so this stays approved-and-on while
  // health reads broken — the tampered-content shape above now flips the
  // approval itself (E008-52) and is no longer "wanted".
  cpSync(join(FIXTURE, 'kitchen-sink', 'README.md'), join(root, 'README.md'))
  manifest.version = '9.9.9'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  {
    const reloadMod = await import('../../src/extensions/reload.ts')
    await reloadMod.reloadExtensions({ cwd })
    const afterSwap = entryFor(id)
    const state = rosterMod.trustStateOf(afterSwap)
    const outcome = health.computeHealth(afterSwap, {}, { probes }).health.outcome
    check(
      'a broken-but-wanted copy reads ✕ broken after the swap, never ◐ reload',
      afterSwap.pending === null && state === 'on' && outcome === 'broken',
      `pending=${String(afterSwap.pending)} state=${state} outcome=${outcome}`,
    )
    check('the swap counted it broken', (await reloadMod.reloadExtensions({ cwd })).counts.broken >= 1)
    rosterMod.setActiveSnapshot(null)
    activeMod.publishActiveSet(null)
  }
  // repair by reinstalling cleanly
  rmSync(paths.getInstalledIdDir(id), { recursive: true, force: true })
  records.updateInstalled(current => { const next = { ...current }; delete next[id]; return next })
  const again = await install.installFromSource('fixture-source', 'kitchen-sink')
  check('reinstall repairs', again.ok && install.approve(id).ok)

  // manifest invalid (field path), floor unmet, escaping path, module — via scratch folders
  const scratchExt = (name: string, m: Record<string, unknown>): ReturnType<typeof health.computeHealth> => {
    const dir = join(scratch, `probe-${name}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mercury-extension.json'), JSON.stringify(m))
    const entry = {
      ...entryFor(id),
      id: `${name}@probe`,
      record: null,
      home: 'installed' as const,
      root: dir,
      ...(() => {
        const read = manifestMod.readManifest(dir)
        return read.status === 'ok'
          ? { manifest: read.manifest, manifestErrors: [], contributionsHash: manifestMod.contributionsHash(read.manifest, dir) }
          : { manifest: null, manifestErrors: read.status === 'invalid' ? read.errors : ['manifest missing'], contributionsHash: null }
      })(),
    }
    return health.computeHealth(entry, {}, { probes })
  }
  let probe = scratchExt('invalid', { name: 'invalid' })
  check('manifest invalid ⇒ broken with the first field path', probe.health.outcome === 'broken' && probe.health.reasons[0]!.includes('version'), probe.health.reasons.join('; '))
  probe = scratchExt('floor', { name: 'floor', version: '1.0.0', description: 'x', mercury: '>=99.0.0' })
  check('floor unmet ⇒ broken "needs Mercury ≥ 99.0.0"', probe.health.outcome === 'broken' && probe.health.reasons[0]!.includes('needs Mercury ≥ 99.0.0'), probe.health.reasons.join('; '))
  probe = scratchExt('escape', { name: 'escape', version: '1.0.0', description: 'x', contributes: { skills: ['../outside'] } })
  check('an escaping path ⇒ broken naming the containment', probe.health.outcome === 'broken' && probe.health.reasons[0]!.includes('outside the extension root'), probe.health.reasons.join('; '))
  probe = scratchExt('module', { name: 'module-probe', version: '1.0.0', description: 'x', module: './x.mjs' })
  check('`module` ⇒ broken with the honest line', probe.health.outcome === 'broken' && probe.health.reasons[0] === manifestMod.RESERVED_MODULE_REASON, probe.health.reasons.join('; '))
}

// ── §2 partial ──────────────────────────────────────────────────────────────
console.log('[2] partial: each probe is one line naming the piece')
{
  check('partial-one installs + approves', (await install.installFromSource('fixture-source', 'partial-one')).ok && install.approve('partial-one@fixture-source').ok)
  const h = health.computeHealth(entryFor('partial-one@fixture-source'), {}, { probes: { ...probes, onPath: () => false } })
  const reasons = h.health.reasons
  check('the outcome is partial (it loads; pieces are dead)', h.health.outcome === 'partial')
  check('the missing skills dir is named', reasons.some(r => r.includes('missing-skills') && r.includes('folder missing')), reasons.join(' | '))
  check('the unknown hook event is named', reasons.some(r => r.includes('NotAnEvent') && r.includes('not a hook event')), reasons.join(' | '))
  check('the channel naming no server is named', reasons.some(r => r.includes('names no server "nope"')))
  check('the missing binary is named', reasons.some(r => r === 'fixture-binary-that-does-not-exist not on PATH'))
  check('the unset env is named', reasons.some(r => r === 'FIXTURE_UNSET_ENV unset'))
  check('the foreign keybinding target is named', reasons.some(r => r.includes('ctrl+x p') && r.includes('not this extension')))

  // an unset required option
  check('needs-node installs + approves', (await install.installFromSource('fixture-source', 'needs-node')).ok && install.approve('needs-node@fixture-source').ok)
  const hn = health.computeHealth(entryFor('needs-node@fixture-source'), {}, { probes: { ...probes, envSet: () => false } })
  check('the unset required option is named with its fix key', hn.health.reasons.some(r => r.includes('option MUST_SET not set')), hn.health.reasons.join(' | '))
  check('the unset needs.env is named', hn.health.reasons.some(r => r === 'NEEDS_NODE_TOKEN unset'))

  // a hook whose script is missing / not executable
  const ks = records.installedOrEmpty()['kitchen-sink@fixture-source']!
  const script = join(ks.path, 'bin', 'fixture-hook.sh')
  rmSync(script)
  let hk = health.computeHealth(entryFor('kitchen-sink@fixture-source'), {}, { probes, skipTamperHash: true })
  check('a missing hook script ⇒ partial naming the file and event', hk.health.outcome === 'partial' && hk.health.reasons.some(r => r.includes('fixture-hook.sh') && r.includes('file missing')), hk.health.reasons.join(' | '))
  writeFileSync(script, '#!/bin/sh\nexit 0\n')
  chmodSync(script, 0o644)
  // The fixture invokes it via `sh …`, so the exec bit is not required; a DIRECT hook path is:
  const direct = join(scratch, 'probe-direct')
  mkdirSync(join(direct, 'bin'), { recursive: true })
  writeFileSync(join(direct, 'mercury-extension.json'), JSON.stringify({ name: 'direct-hook', version: '1.0.0', description: 'x', contributes: { hooks: { Stop: [{ hooks: [{ type: 'command', command: '${MERCURY_EXTENSION_ROOT}/bin/run.sh' }] }] } } }))
  writeFileSync(join(direct, 'bin', 'run.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(direct, 'bin', 'run.sh'), 0o644)
  const read = manifestMod.readManifest(direct)
  const directEntry = { ...entryFor('kitchen-sink@fixture-source'), id: 'direct-hook@probe', record: null, root: direct, manifest: read.status === 'ok' ? read.manifest : null, manifestErrors: [], contributionsHash: 'x' }
  hk = health.computeHealth(directEntry, {}, { probes })
  check('a direct hook script without the exec bit ⇒ partial with the chmod fix', process.platform === 'win32' || hk.health.reasons.some(r => r.includes('not executable') && r.includes('chmod +x')), hk.health.reasons.join(' | '))
}

// ── §3 runtime facts ────────────────────────────────────────────────────────
console.log('[3] the managers\' live facts join the readout')
{
  const facts = {
    servers: new Map([['ext:kitchen-sink:fixture', { state: 'failed' as const, detail: 'exit 1' }]]),
    language: new Map([['ext:kitchen-sink:fixture-ls', { state: 'error' as const, detail: 'crashed' }]]),
  }
  // The language server resolves only when its binary probes present — the
  // runtime fact then rides the RESOLVED item.
  const probes3 = { ...probes, onPath: (b: string) => b === 'node' || b === 'fixture-language-server' }
  health.resetRuntimeCounters()
  health.recordHookFailure('kitchen-sink@fixture-source', 'fixture-hook.sh', 'timeout')
  health.recordHookFailure('kitchen-sink@fixture-source', 'fixture-hook.sh', 'timeout')
  health.recordDroppedChannelPost('kitchen-sink@fixture-source', 'ext:kitchen-sink:other')
  const h = health.computeHealth(entryFor('kitchen-sink@fixture-source'), facts, { probes: probes3, skipTamperHash: true })
  check('a failed server reads `server fixture: failed (exit 1)`', h.health.reasons.some(r => r === 'server fixture: failed (exit 1)'), h.health.reasons.join(' | '))
  check('a crashed language server is named', h.health.reasons.some(r => r === 'language fixture-ls: crashed'))
  check('hook failures are counted with the last reason', h.health.reasons.some(r => r.includes('fixture-hook.sh: 2 failures this session · last: timeout')))
  check('dropped channel posts are counted', h.health.reasons.some(r => r.includes('1 post dropped')))
  health.resetRuntimeCounters()
}

// ── §4 one owner ────────────────────────────────────────────────────────────
console.log('[4] one owner: the row, /health and readiness derive from the same computation')
{
  activeMod.publishActiveSet(null)
  const row = boot.extensionsHealthRow()
  check('/health row: the four counts and pass/warn/fail derive together', typeof row.evidence === 'string' && /\d+ on · \d+ partial · \d+ broken · \d+ off/.test(row.evidence), row.evidence)
  check('/health warns while a partial extension is on', row.status === 'warn' || row.status === 'fail', row.status)
  const readiness = boot.extensionReadinessRows()
  check('readiness paints the SAME evidence string', readiness[0]!.detail === row.evidence, `${readiness[0]!.detail} vs ${row.evidence}`)
  const { rows } = cli.listRows()
  const partial = rows.find(r => r.id === 'partial-one@fixture-source')
  check('the CLI row carries the word and the first reason', partial !== undefined && partial.state.includes('partial') && partial.state.includes('·'), partial?.state)
  check('the CLI --json carries the FULL reason list', partial !== undefined && (partial.health?.reasons.length ?? 0) >= 3, String(partial?.health?.reasons.length))
  // a corrupt installed.json degrades to empty + a problem row; the session boots
  writeFileSync(paths.getInstalledFile(), '{ not json')
  const degraded = rosterMod.computeRoster({ cwd })
  check('a corrupt installed.json ⇒ empty roster + a problem line', degraded.entries.filter(e => e.home === 'installed').length === 0 && degraded.problems.length === 1, degraded.problems.join(' | '))
  const failRow = boot.extensionsHealthRow()
  check('/health fails naming the file', failRow.problems.length === 1 && failRow.problems[0]!.includes('installed.json'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ HEALTH READOUT — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
