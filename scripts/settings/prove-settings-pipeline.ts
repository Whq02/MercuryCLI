#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-settings-pipeline.ts — settings load/merge/
//  precedence/validation/persistence characterization.
//
//  Hermetic: temp MERCURY_CONFIG_DIR + temp project cwd via the bootstrap
//  seams; the remote-policy session cache stands in for the policy source
//  (the managed FILE path is a fixed system path with no override seam —
//  deliberately: an env seam would let a user spoof enterprise policy).
//
//  Pins:
//    · precedence user < project < local < flag(file+inline) < policy
//    · array concat+dedup vs object deep-merge vs scalar override
//    · Mercury value acceptance (effortLevel max · defaultMode flow/scribe ·
//      mode autopilot round-trip) — the R1c widening class
//    · invalid-file taxonomy: JSON syntax (null+silent) · schema violation
//      (file/path/expected/suggestion; the file SURVIVES minus the bad key —
//      the FC-004 salvage) · one bad permission rule filtered
//      while the file survives
//    · updateSettingsForSource: merge write, undefined-deletes, ARRAY
//      REPLACE (caller computes final state), invalid-JSON refuses to
//      clobber, cache reset on write
//    · caching: parse-cache clone isolation; session cache single-load;
//      reset restores disk truth
//    · getSettingsWithSources: effective + ordered non-empty sources
//
//  Run:  ~/.bun/bin/bun run scripts/settings/prove-settings-pipeline.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'settings-proof-home-'))
const PROJ = mkdtempSync(join(tmpdir(), 'settings-proof-proj-'))
process.env.MERCURY_CONFIG_DIR = HOME

const state = await import('../../src/bootstrap/state.ts')
state.setOriginalCwd(PROJ)
state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])

const settingsMod = await import('../../src/utils/settings/settings.ts')
const cacheMod = await import('../../src/utils/settings/settingsCache.ts')
const { setSessionCache, setEligibility, resetSyncCache } = await import(
  '../../src/services/remoteManagedSettings/syncCacheState.ts'
)

const {
  getInitialSettings,
  getSettingsWithErrors,
  getSettingsWithSources,
  getSettingsForSource,
  parseSettingsFile,
  updateSettingsForSource,
  settingsMergeCustomizer,
} = settingsMod
const { resetSettingsCache } = cacheMod

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const userPath = join(HOME, 'settings.json')
const projDir = join(PROJ, '.mercury')
mkdirSync(projDir, { recursive: true })
const projPath = join(projDir, 'settings.json')
const localPath = join(projDir, 'settings.local.json')

function writeAll(files: { user?: object; proj?: object; local?: object }): void {
  if (files.user) writeFileSync(userPath, JSON.stringify(files.user))
  if (files.proj) writeFileSync(projPath, JSON.stringify(files.proj))
  if (files.local) writeFileSync(localPath, JSON.stringify(files.local))
  resetSettingsCache()
}

console.log('============================================================')
console.log(' Settings pipeline — precedence · merge · validation · writes')
console.log('============================================================')

//
section('(1) precedence and merge shapes across user/project/local')
{
  writeAll({
    user: {
      model: 'user-model',
      env: { FROM_USER: '1', SHARED: 'user' },
      permissions: { allow: ['Read(a.txt)'], defaultMode: 'default' },
    },
    proj: {
      model: 'proj-model',
      env: { FROM_PROJ: '1', SHARED: 'proj' },
      permissions: { allow: ['Read(b.txt)', 'Read(a.txt)'] },
    },
    local: {
      env: { SHARED: 'local' },
      permissions: { defaultMode: 'implement' },
    },
  })
  const s = getInitialSettings()
  check('scalar: later source wins (project over user)', s.model === 'proj-model', j(s.model))
  check('scalar: local wins over both (nested)', s.permissions?.defaultMode === 'implement', j(s.permissions?.defaultMode))
  check(
    'objects deep-merge across sources',
    (s.env as Record<string, string>)?.FROM_USER === '1' && (s.env as Record<string, string>)?.FROM_PROJ === '1',
    j(s.env),
  )
  check('object key: highest source wins', (s.env as Record<string, string>)?.SHARED === 'local', j(s.env))
  check(
    'arrays concat + dedup in source order',
    j(s.permissions?.allow) === j(['Read(a.txt)', 'Read(b.txt)']),
    j(s.permissions?.allow),
  )
}

//
section('(2) flag settings (file + inline) and remote policy sit above local')
{
  const flagPath = join(PROJ, 'flag-settings.json')
  writeFileSync(flagPath, JSON.stringify({ model: 'flag-model', env: { FROM_FLAG: '1' } }))
  state.setFlagSettingsPath(flagPath)
  state.setFlagSettingsInline({ env: { FROM_INLINE: '1' } })
  resetSettingsCache()
  let s = getInitialSettings()
  check('flag file overrides local/project scalars', s.model === 'flag-model', j(s.model))
  check(
    'inline SDK settings merge on top of the flag file',
    (s.env as Record<string, string>)?.FROM_FLAG === '1' && (s.env as Record<string, string>)?.FROM_INLINE === '1',
    j(s.env),
  )

  // Remote policy (the highest-priority policy source) beats everything.
  // The read is ELIGIBILITY-gated (tri-state; computed once by managedEnv).
  setEligibility(true)
  setSessionCache({ model: 'policy-model' })
  // With the DEFAULT allowed-source list the canonical order holds.
  state.setAllowedSettingSources([
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
  ])
  resetSettingsCache()
  s = getInitialSettings()
  check('policy (remote) beats flag settings (default source list)', s.model === 'policy-model', j(s.model))
  check("per-source read agrees (getSettingsForSource('policySettings'))", getSettingsForSource('policySettings')?.model === 'policy-model')

  // REGRESSION FIXTURE: merge order is
  // the CANONICAL SETTING_SOURCES order regardless of how --setting-sources
  // spelled the allowed subset — enterprise policy can never be overridden
  // by a --settings flag file. (The prior Set-append form inverted flag/
  // policy exactly when the allowed list was restricted.)
  state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
  resetSettingsCache()
  const restricted = getInitialSettings()
  check(
    'restricted --setting-sources keeps POLICY above flag settings',
    restricted.model === 'policy-model',
    j(restricted.model),
  )

  // A MALFORMED remote blob is rejected by schema — falls through to nothing.
  setSessionCache({ model: 123 } as never)
  resetSettingsCache()
  check(
    'malformed remote policy rejected by schema (per-source read null)',
    getSettingsForSource('policySettings') === null,
    j(getSettingsForSource('policySettings')),
  )
  resetSyncCache()
  state.setFlagSettingsPath(undefined)
  state.setFlagSettingsInline(undefined)
  resetSettingsCache()
}

//
section('(3) Mercury value acceptance (the R1c widening class)')
{
  writeAll({ user: { effortLevel: 'max' }, proj: {}, local: {} })
  const { settings, errors } = getSettingsWithErrors()
  check('effortLevel max validates', settings.effortLevel === 'max', j({ e: settings.effortLevel, errors }))

  // REGRESSION FIXTURE: the settings
  // schema accepts the full user-addressable mode set — 'flow'/'scribe'/
  // 'autopilot' validate (shape-only; mode ENTRY stays guarded downstream:
  // canEnterAuto, autopilot's bypass-posture guard, the CCR restriction).
  // Before the correction these values nuked the entire settings file.
  for (const mode of ['flow', 'scribe', 'autopilot'] as const) {
    writeAll({ user: { permissions: { defaultMode: mode } } })
    const r = getSettingsWithErrors()
    check(
      `defaultMode '${mode}' validates (user-addressable set)`,
      r.settings.permissions?.defaultMode === mode && r.errors.length === 0,
      j(r.errors),
    )
  }
  // A genuinely unknown mode still fails with the actionable tip.
  writeAll({ user: { permissions: { defaultMode: 'bogus' } } })
  const bogus = getSettingsWithErrors()
  check(
    'unknown mode still rejected with the defaultMode tip',
    bogus.settings.permissions?.defaultMode === undefined && bogus.errors.some(e => e.path === 'permissions.defaultMode' && /auto/.test(e.suggestion ?? '')),
    j(bogus.errors),
  )
}

//
section('(4) invalid-file taxonomy')
{
  // JSON syntax error: settings null + one actionable malformed-JSON error.
  writeFileSync(userPath, '{ not json')
  resetSettingsCache()
  const parsed = parseSettingsFile(userPath)
  check(
    'JSON syntax error → settings null + a malformed-JSON validation error',
    parsed.settings === null && parsed.errors.some(e => /malformed JSON/i.test(e.message)),
    j(parsed),
  )

  // Schema violation: actionable error with file/path/expected. Since the
  // FC-004 salvage, one bad value no longer voids the file — the invalid
  // entry is pruned and the valid remainder survives (here: nothing else, so
  // an empty settings object), while the error still surfaces.
  writeFileSync(userPath, JSON.stringify({ model: 42 }))
  resetSettingsCache()
  const bad = parseSettingsFile(userPath)
  check('schema violation → the file survives minus the bad key (FC-004 salvage)', bad.settings !== null && bad.settings.model === undefined, j(bad.settings))
  const err = bad.errors[0]
  check(
    'error carries file + dot-path + expected shape',
    err !== undefined && err.path === 'model' && typeof err.message === 'string' && err.file !== undefined,
    j(bad.errors),
  )

  // One bad permission rule: filtered with a warning; the file SURVIVES.
  writeFileSync(
    userPath,
    JSON.stringify({ model: 'ok-model', permissions: { allow: ['Read(ok.txt)', 123] } }),
  )
  resetSettingsCache()
  const filtered = parseSettingsFile(userPath)
  check('file with one invalid permission rule still parses', filtered.settings?.model === 'ok-model', j(filtered))
  check('the invalid rule is dropped, valid rule kept', j(filtered.settings?.permissions?.allow) === j(['Read(ok.txt)']), j(filtered.settings?.permissions?.allow))
  check('a warning describes the dropped rule', filtered.errors.length >= 1, j(filtered.errors))
}

//
section('(5) updateSettingsForSource — merge writes, deletion, array replace')
{
  writeAll({ user: { model: 'before', env: { KEEP: '1', DROP: '1' }, permissions: { allow: ['Read(old.txt)'] } } })
  const r1 = updateSettingsForSource('userSettings', {
    model: 'after',
    env: { DROP: undefined } as never,
    permissions: { allow: ['Read(new.txt)'] },
  })
  check('write succeeds', r1.error === null, String(r1.error))
  const s = getSettingsForSource('userSettings')
  check('scalar updated', s?.model === 'after', j(s?.model))
  check('undefined deletes the key', !('DROP' in ((s?.env ?? {}) as object)) && (s?.env as Record<string, string>)?.KEEP === '1', j(s?.env))
  check(
    'arrays REPLACE on write (caller computes final state — no concat)',
    j(s?.permissions?.allow) === j(['Read(new.txt)']),
    j(s?.permissions?.allow),
  )

  // Invalid JSON on disk: refuse to clobber.
  writeFileSync(userPath, '{ broken')
  resetSettingsCache()
  const r2 = updateSettingsForSource('userSettings', { model: 'clobber' })
  check('invalid-JSON file refuses the write (error, not overwrite)', r2.error !== null && String(r2.error).includes('Invalid JSON'), String(r2.error))

  // Read-only sources are silent no-ops.
  const r3 = updateSettingsForSource('policySettings' as never, { model: 'x' })
  check('policy/flag writes are refused silently (as-is)', r3.error === null)
}

//
section('(6) cache behavior — clone isolation, session single-load, reset')
{
  writeAll({ user: { model: 'cache-truth', env: { A: '1' } } })
  const first = parseSettingsFile(userPath)
  ;(first.settings as { model?: string }).model = 'MUTATED'
  const second = parseSettingsFile(userPath)
  check('parse-cache returns clones (caller mutation cannot poison)', second.settings?.model === 'cache-truth', j(second.settings?.model))

  const before = getInitialSettings()
  writeFileSync(userPath, JSON.stringify({ model: 'disk-changed' }))
  const cachedRead = getInitialSettings()
  check('session cache holds without reset (stale by design)', cachedRead.model === before.model, j(cachedRead.model))
  resetSettingsCache()
  check('reset restores disk truth', getInitialSettings().model === 'disk-changed')
}

//
section('(7) getSettingsWithSources — effective + ordered provenance inputs')
{
  writeAll({
    user: { model: 'u' },
    proj: { model: 'p' },
    local: { model: 'l' },
  })
  const { effective, sources } = getSettingsWithSources()
  check('effective reflects the merge', effective.model === 'l', j(effective.model))
  const order = sources.map(s => s.source)
  check(
    'sources listed low→high priority, non-empty only',
    j(order) === j(['userSettings', 'projectSettings', 'localSettings']),
    j(order),
  )
}

//
section('(8) merge customizer unit (the exported seam)')
{
  check('arrays: concat+dedup', j(settingsMergeCustomizer(['a', 'b'], ['b', 'c'])) === j(['a', 'b', 'c']))
  check('non-arrays: defer to lodash (undefined)', settingsMergeCustomizer({ a: 1 }, { b: 2 }) === undefined)
}

console.log('\n============================================================')
// ── FC-102: the pre-rename exclusion key ADOPTS and WARNS ───────────────────
{
  const { mkdtempSync: mkT, writeFileSync: wT, realpathSync: rT } = await import('node:fs')
  const { tmpdir: tT } = await import('node:os')
  const { join: jT } = await import('node:path')
  const dir = rT(mkT(jT(tT(), 'fc102-')))
  const file = jT(dir, 'settings.json')
  wT(file, JSON.stringify({ claudeMdExcludes: ['**/MERCURY.md'], model: 'sonnet5' }))
  const parsed = parseSettingsFile(file)
  check(
    'FC-102: the legacy value is ADOPTED as instructionExcludes',
    JSON.stringify((parsed.settings as { instructionExcludes?: string[] })?.instructionExcludes) === JSON.stringify(['**/MERCURY.md']),
    JSON.stringify(parsed.settings),
  )
  check(
    'FC-102: the rename is NAMED as a validation warning',
    parsed.errors.some(e => e.path === 'claudeMdExcludes' && e.message.includes("renamed 'instructionExcludes'")),
    JSON.stringify(parsed.errors),
  )
  check('FC-102: the sibling keys survive untouched', (parsed.settings as { model?: string })?.model === 'sonnet5')
  // A SECOND file: parseSettingsFile caches by path, so rewriting the first
  // one would answer from the cache.
  const file2 = jT(dir, 'settings-both.json')
  wT(file2, JSON.stringify({ claudeMdExcludes: ['a'], instructionExcludes: ['b'] }))
  const both = parseSettingsFile(file2)
  check(
    'FC-102: an existing canonical key WINS (the legacy one never clobbers)',
    JSON.stringify((both.settings as { instructionExcludes?: string[] })?.instructionExcludes) === JSON.stringify(['b']),
  )
}

// ── FC-146: the managed extension-only lock FAILS CLOSED ────────────────────
{
  const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
  const lockOf = (value: unknown): unknown => {
    const parsed = SettingsSchema().safeParse({ strictExtensionOnlyCustomization: value })
    return parsed.success ? (parsed.data as { strictExtensionOnlyCustomization?: unknown }).strictExtensionOnlyCustomization : 'SCHEMA-REFUSED'
  }
  check('FC-146: the stringified "true" LOCKS everything (was: silently unlocked)', lockOf('true') === true, JSON.stringify(lockOf('true')))
  check('FC-146: "TRUE"/"1" fold to the lock', lockOf('TRUE') === true && lockOf('1') === true)
  check('FC-146: "false"/"0" fold to unlocked', lockOf('false') === false && lockOf('0') === false)
  check('FC-146: a single surface name folds to its list', JSON.stringify(lockOf('agents')) === JSON.stringify(['agents']))
  check('FC-146: junk the admin wrote LOCKS ALL (a garbled lock narrows, never evaporates)', lockOf('yes-lock-it') === true, JSON.stringify(lockOf('yes-lock-it')))
  check('FC-146: a number locks all too (fail closed)', lockOf(1) === true)
  check('FC-146: the clean boolean and array are byte-identical', lockOf(true) === true && JSON.stringify(lockOf(['agents'])) === JSON.stringify(['agents']))
  check('FC-146: absent stays absent (nothing locks by default)', lockOf(undefined) === undefined)
  const { readFileSync: rfHealth } = await import('node:fs')
  const { join: joinHealth } = await import('node:path')
  const healthSrc = rfHealth(joinHealth(import.meta.dir, '..', '..', 'src', 'utils', 'healthReport.ts'), 'utf8')
  check('FC-146: doctor names the armed lock (call-shaped)', healthSrc.includes('managed extension-only lock'))
}

if (failures === 0) {
  console.log(' ✅ SETTINGS PIPELINE CONTRACT GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SETTINGS PIPELINE FAILURE(S)`)
process.exit(1)
