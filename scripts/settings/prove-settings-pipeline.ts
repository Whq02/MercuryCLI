#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync as rfBytes } from 'node:fs'
import { codeOnlyText } from '../lib/codeText.ts'

const HOME = mkdtempSync(join(tmpdir(), 'settings-proof-home-'))
const PROJ = mkdtempSync(join(tmpdir(), 'settings-proof-proj-'))
process.env.MERCURY_CONFIG_DIR = HOME

const state = await import('../../src/bootstrap/state.ts')
state.setOriginalCwd(PROJ)
state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])

const settingsMod = await import('../../src/utils/settings/settings.ts')
const cacheMod = await import('../../src/utils/settings/settingsCache.ts')
const { setMdmSettingsCache, clearMdmSettingsCache } = await import('../../src/utils/settings/mdm/settings.ts')

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

section('(1) precedence and merge shapes across user/project/local')
{
  writeAll({
    user: {
      engine: { model: 'user-model' },
      environment: { values: { FROM_USER: '1', SHARED: 'user' } },
      guardrails: { allow: ['Read(a.txt)'], mode: 'default' },
    },
    proj: {
      engine: { model: 'proj-model' },
      environment: { values: { FROM_PROJ: '1', SHARED: 'proj' } },
      guardrails: { allow: ['Read(b.txt)', 'Read(a.txt)'] },
    },
    local: {
      environment: { values: { SHARED: 'local' } },
      guardrails: { mode: 'implement' },
    },
  })
  const s = getInitialSettings()
  const values = (): Record<string, string> => (s.environment?.values ?? {}) as Record<string, string>
  check('scalar: later source wins (project over user)', s.engine?.model === 'proj-model', j(s.engine?.model))
  check('scalar: local wins over both (nested)', s.guardrails?.mode === 'implement', j(s.guardrails?.mode))
  check(
    'objects deep-merge across sources',
    values().FROM_USER === '1' && values().FROM_PROJ === '1',
    j(values()),
  )
  check('object key: highest source wins', values().SHARED === 'local', j(values()))
  check(
    'arrays concat + dedup in source order',
    j(s.guardrails?.allow) === j(['Read(a.txt)', 'Read(b.txt)']),
    j(s.guardrails?.allow),
  )
}

section('(2) flag settings (file + inline) and policy sit above local')
{
  const flagPath = join(PROJ, 'flag-settings.json')
  writeFileSync(flagPath, JSON.stringify({ engine: { model: 'flag-model' }, environment: { values: { FROM_FLAG: '1' } } }))
  state.setFlagSettingsPath(flagPath)
  state.setFlagSettingsInline({ environment: { values: { FROM_INLINE: '1' } } })
  resetSettingsCache()
  let s = getInitialSettings()
  check('flag file overrides local/project scalars', s.engine?.model === 'flag-model', j(s.engine?.model))
  check(
    'inline SDK settings merge on top of the flag file',
    s.environment?.values?.FROM_FLAG === '1' && s.environment?.values?.FROM_INLINE === '1',
    j(s.environment?.values),
  )

  setMdmSettingsCache({ settings: { engine: { model: 'policy-model' } }, errors: [] }, { settings: {}, errors: [] })
  state.setAllowedSettingSources([
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
  ])
  resetSettingsCache()
  s = getInitialSettings()
  check('policy beats flag settings (default source list)', s.engine?.model === 'policy-model', j(s.engine?.model))
  check("per-source read agrees (getSettingsForSource('policySettings'))", getSettingsForSource('policySettings')?.engine?.model === 'policy-model')

  state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
  resetSettingsCache()
  const restricted = getInitialSettings()
  check(
    'restricted --config-layers keeps POLICY above flag settings',
    restricted.engine?.model === 'policy-model',
    j(restricted.engine?.model),
  )

  clearMdmSettingsCache()
  resetSettingsCache()
  check(
    'with the device tier cleared the policy source reads null',
    getSettingsForSource('policySettings') === null,
    j(getSettingsForSource('policySettings')),
  )
  check('no policy origin is ever "remote"', String(settingsMod.getPolicySettingsOrigin()) !== 'remote')
  state.setFlagSettingsPath(undefined)
  state.setFlagSettingsInline(undefined)
  resetSettingsCache()
}

section('(3) Mercury value acceptance (the R1c widening class)')
{
  writeAll({ user: { engine: { effort: 'max' } }, proj: {}, local: {} })
  const { settings, errors } = getSettingsWithErrors()
  check('engine.effort max validates', settings.engine?.effort === 'max', j({ e: settings.engine?.effort, errors }))

  for (const mode of ['flow', 'apollo'] as const) {
    writeAll({ user: { guardrails: { mode } } })
    const r = getSettingsWithErrors()
    check(
      `guardrails.mode '${mode}' validates (user-addressable set)`,
      r.settings.guardrails?.mode === mode && r.errors.length === 0,
      j(r.errors),
    )
  }
  writeAll({ user: { guardrails: { mode: 'bogus' } } })
  const bogus = getSettingsWithErrors()
  check(
    'unknown mode still rejected with the mode tip',
    bogus.settings.guardrails?.mode === undefined && bogus.errors.some(e => e.path === 'guardrails.mode' && /sovereign/.test(e.suggestion ?? '')),
    j(bogus.errors),
  )
}

section('(4) invalid-file taxonomy')
{
  writeFileSync(userPath, '{ not json')
  resetSettingsCache()
  const parsed = parseSettingsFile(userPath)
  check(
    'JSON syntax error → settings null + a malformed-JSON validation error',
    parsed.settings === null && parsed.errors.some(e => /malformed JSON/i.test(e.message)),
    j(parsed),
  )

  writeFileSync(userPath, JSON.stringify({ engine: { model: 42 } }))
  resetSettingsCache()
  const bad = parseSettingsFile(userPath)
  check('schema violation → the file survives minus the bad leaf (FC-004 salvage)', bad.settings !== null && bad.settings.engine?.model === undefined, j(bad.settings))
  const err = bad.errors[0]
  check(
    'error carries file + dot-path + expected shape',
    err !== undefined && err.path === 'engine.model' && typeof err.message === 'string' && err.file !== undefined,
    j(bad.errors),
  )

  writeFileSync(
    userPath,
    JSON.stringify({ engine: { model: 'ok-model' }, guardrails: { allow: ['Read(ok.txt)', 123] } }),
  )
  resetSettingsCache()
  const filtered = parseSettingsFile(userPath)
  check('file with one invalid permission rule still parses', filtered.settings?.engine?.model === 'ok-model', j(filtered))
  check('the invalid rule is dropped, valid rule kept', j(filtered.settings?.guardrails?.allow) === j(['Read(ok.txt)']), j(filtered.settings?.guardrails?.allow))
  check('a warning describes the dropped rule', filtered.errors.length >= 1, j(filtered.errors))
}

section('(5) updateSettingsForSource — merge writes, deletion, array replace')
{
  writeAll({ user: { engine: { model: 'before' }, environment: { values: { KEEP: '1', DROP: '1' } }, guardrails: { allow: ['Read(old.txt)'] } } })
  const r1 = updateSettingsForSource('userSettings', {
    engine: { model: 'after' },
    environment: { values: { DROP: undefined } as never },
    guardrails: { allow: ['Read(new.txt)'] },
  })
  check('write succeeds', r1.error === null, String(r1.error))
  const s = getSettingsForSource('userSettings')
  check('scalar updated', s?.engine?.model === 'after', j(s?.engine?.model))
  check('undefined deletes the key', !('DROP' in ((s?.environment?.values ?? {}) as object)) && s?.environment?.values?.KEEP === '1', j(s?.environment?.values))
  check(
    'arrays REPLACE on write (caller computes final state — no concat)',
    j(s?.guardrails?.allow) === j(['Read(new.txt)']),
    j(s?.guardrails?.allow),
  )

  writeFileSync(userPath, '{ broken')
  resetSettingsCache()
  const r2 = updateSettingsForSource('userSettings', { engine: { model: 'clobber' } })
  check('invalid-JSON file refuses the write (error, not overwrite)', r2.error !== null && String(r2.error).includes('Invalid JSON'), String(r2.error))
  check('…and the broken bytes are preserved on disk byte-for-byte (nothing clobbered, no backup swap)', rfBytes(userPath, 'utf8') === '{ broken', JSON.stringify(rfBytes(userPath, 'utf8')))

  const flagFile = join(PROJ, 'flag-settings.json')
  state.setFlagSettingsPath(flagFile)
  resetSettingsCache()
  const flagPathBefore = rfBytes(flagFile, 'utf8')
  check('fixture: the flag source is ARMED on its file for the refusal test (a write has a real target to refuse)', getSettingsForSource('flagSettings')?.engine?.model === 'flag-model', j(getSettingsForSource('flagSettings')))
  const policyBefore = j(getSettingsForSource('policySettings'))
  const r3 = updateSettingsForSource('policySettings' as never, { engine: { model: 'x' } })
  check('policy/flag writes are refused silently (as-is)', r3.error === null)
  check('…the policy source reads back unchanged after the refused write', j(getSettingsForSource('policySettings')) === policyBefore && getSettingsForSource('policySettings')?.engine?.model !== 'x', j(getSettingsForSource('policySettings')))
  const r4 = updateSettingsForSource('flagSettings' as never, { engine: { model: 'x' } })
  resetSettingsCache()
  check('the flag source is the SECOND read-only target: refused silently too', r4.error === null)
  check('…and the flag file bytes are untouched, its read unchanged', rfBytes(flagFile, 'utf8') === flagPathBefore && getSettingsForSource('flagSettings')?.engine?.model === 'flag-model', rfBytes(flagFile, 'utf8'))
  state.setFlagSettingsPath(undefined)
  resetSettingsCache()
}

section('(6) cache behavior — clone isolation, session single-load, reset')
{
  writeAll({ user: { engine: { model: 'cache-truth' }, environment: { values: { A: '1' } } } })
  const first = parseSettingsFile(userPath)
  ;(first.settings?.engine as { model?: string }).model = 'MUTATED'
  const second = parseSettingsFile(userPath)
  check('parse-cache returns clones (caller mutation cannot poison)', second.settings?.engine?.model === 'cache-truth', j(second.settings?.engine?.model))

  const before = getInitialSettings()
  writeFileSync(userPath, JSON.stringify({ engine: { model: 'disk-changed' } }))
  const cachedRead = getInitialSettings()
  check('session cache holds without reset (stale by design)', cachedRead.engine?.model === before.engine?.model, j(cachedRead.engine?.model))
  resetSettingsCache()
  check('reset restores disk truth', getInitialSettings().engine?.model === 'disk-changed')
}

section('(7) getSettingsWithSources — effective + ordered provenance inputs')
{
  writeAll({
    user: { engine: { model: 'u' } },
    proj: { engine: { model: 'p' } },
    local: { engine: { model: 'l' } },
  })
  const { effective, sources } = getSettingsWithSources()
  check('effective reflects the merge', effective.engine?.model === 'l', j(effective.engine?.model))
  const order = sources.map(s => s.source)
  check(
    'sources listed low→high priority, non-empty only',
    j(order) === j(['userSettings', 'projectSettings', 'localSettings']),
    j(order),
  )
}

section('(8) merge customizer unit (the exported seam)')
{
  check('arrays: concat+dedup', j(settingsMergeCustomizer(['a', 'b'], ['b', 'c'])) === j(['a', 'b', 'c']))
  check('non-arrays: defer to lodash (undefined)', settingsMergeCustomizer({ a: 1 }, { b: 2 }) === undefined)
}

console.log('\n============================================================')
{
  const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
  const lockOf = (value: unknown): unknown => {
    const parsed = SettingsSchema().safeParse({ extensions: { exclusive: value } })
    return parsed.success ? (parsed.data as { extensions?: { exclusive?: unknown } }).extensions?.exclusive : 'SCHEMA-REFUSED'
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
  const healthPath = joinHealth(import.meta.dir, '..', '..', 'src', 'utils', 'healthReport.ts')
  const healthSrc = codeOnlyText(healthPath, rfHealth(healthPath, 'utf8'))
  const lockRead = healthSrc.indexOf("getSettingsForSource('policySettings')?.extensions?.exclusive")
  check('FC-146: health reads the lock from the policy source (code, not comment)', lockRead >= 0)
  const lockBlock = lockRead >= 0 ? healthSrc.slice(lockRead, healthSrc.indexOf('getSettingsWithAllErrors', lockRead)) : ''
  check('FC-146: health names the armed lock (call-shaped)', /if \(lock === true\) lockLine = ' · managed extension-only lock: ALL surfaces'/.test(lockBlock) && /Array\.isArray\(lock\) && lock\.length > 0\) lockLine = ` · managed extension-only lock: \$\{lock\.join\(', '\)\}`/.test(lockBlock), lockBlock.replace(/\s+/g, ' ').slice(0, 200))
  check('FC-146: …and the lock line reaches the evidence string', /evidence: `\$\{sourcesLine\}\$\{lockLine\}/.test(lockBlock), lockBlock.replace(/\s+/g, ' ').slice(-160))
  const lookalike = "// managed extension-only lock: ALL surfaces\n/* lockLine = ' · managed extension-only lock: x' */\nlet lockLine = ''\n"
  check('FC-146: a comment-only mention of the lock line does NOT satisfy the code read', !codeOnlyText('lookalike.ts', lookalike).includes('managed extension-only lock') && lookalike.includes('managed extension-only lock'))
}

if (failures === 0) {
  console.log(' ✅ SETTINGS PIPELINE CONTRACT GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SETTINGS PIPELINE FAILURE(S)`)
process.exit(1)
