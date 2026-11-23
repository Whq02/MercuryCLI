#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'settings-salvage-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { parseSettingsFile } = await import('../../src/platform/settings/settings.ts')

let failures = 0
const WHERE = 'parseSettingsFile in src/platform/settings/settings.ts'
const check = (label: string, cond: boolean, detail = '', hint = `change ${WHERE} so that this case reads as the label says`): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${cond ? '' : ` — to fix: ${hint}`}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

let fileCounter = 0
const parseBlob = (blob: unknown): ReturnType<typeof parseSettingsFile> => {
  const path = join(HOME, `case-${fileCounter++}.json`)
  writeFileSync(path, typeof blob === 'string' ? blob : JSON.stringify(blob))
  return parseSettingsFile(path)
}

section('§1 THE CARD REPRO — a quoted number beside a deny list')
{
  const { settings, errors } = parseBlob({ guardrails: { deny: ['Bash'] }, records: { retentionDays: '30' } })
  check('the file is NOT discarded (FC-004)', settings !== null, '', `a file with one invalid leaf must still load: keep the valid settings in ${WHERE} instead of returning null`)
  check(
    'the deny rules the operator wrote still apply',
    JSON.stringify(settings?.guardrails?.deny) === JSON.stringify(['Bash']),
    JSON.stringify(settings?.guardrails),
  )
  check(
    'exactly the invalid leaf is dropped',
    settings !== null && settings.records?.retentionDays === undefined,
    '',
    `${WHERE} must drop the invalid records.retentionDays leaf and keep the rest`,
  )
  check(
    'the validation error still surfaces (names the bad key)',
    errors.length > 0 && errors.some(e => e.path === 'records.retentionDays'),
    JSON.stringify(errors).slice(0, 200),
  )
}

section('§2 A MISTYPED guardrails.mode')
{
  const { settings } = parseBlob({ guardrails: { mode: 'bogus-mode', deny: ['Bash'] } })
  check('the file survives a bad mode', settings !== null, '', `a bad guardrails.mode must not void the file: salvage in ${WHERE}`)
  check(
    'the sibling deny rules survive beside the dropped mode',
    JSON.stringify(settings?.guardrails?.deny) === JSON.stringify(['Bash']),
    JSON.stringify(settings?.guardrails),
  )
  check(
    'the bad mode itself is dropped, not kept',
    settings?.guardrails?.mode === undefined,
    JSON.stringify(settings?.guardrails?.mode),
  )
}

section('§3 ONE MALFORMED HOOK ENTRY')
{
  const { settings } = parseBlob({
    engine: { model: 'claude-sonnet-5' },
    events: { hooks: {
      'session.start': [
        { timeout: 3 },
        { run: 'echo ok' },
      ],
    } },
  })
  check('the file survives one malformed hook entry', settings !== null, '', `one malformed events.hooks entry must not void the file: salvage in ${WHERE}`)
  check('the unrelated model pin survives', settings?.engine?.model === 'claude-sonnet-5', JSON.stringify(settings?.engine?.model))
  const sessionStart = (settings?.events?.hooks as Record<string, unknown[]> | undefined)?.['session.start']
  check(
    'the VALID sibling hook entry survives the prune',
    Array.isArray(sessionStart) &&
      JSON.stringify(sessionStart).includes('echo ok') &&
      !JSON.stringify(sessionStart).includes('"timeout":3'),
    JSON.stringify(sessionStart),
  )
}

section('§4 CONTROL — a fully valid file')
{
  const { settings, errors } = parseBlob({ guardrails: { deny: ['Bash'] }, records: { retentionDays: 30 } })
  check('a valid file parses exactly as before', settings !== null && settings.records?.retentionDays === 30, '', `a valid file must parse unchanged: ${WHERE} altered a valid value or returned null`)
  check('zero errors on a valid file', errors.length === 0, JSON.stringify(errors))
}

section('§5 ROOT-MALFORMED JSON')
{
  const { settings, errors } = parseBlob('{nope')
  check('malformed JSON still fails whole (nothing to salvage)', settings === null, '', `unparseable JSON must give settings null in ${WHERE}; salvage applies only to parsed files`)
  check('and still reports', errors.length > 0, '', `${WHERE} must return an error for unparseable JSON`)
}

section('§6 THE SEVERITY CHANNEL (B9) — the loader grades what it knows')
{
  const salvagedCase = parseBlob({ guardrails: { deny: ['Bash'] }, records: { retentionDays: '30' } })
  check('a salvaged file grades every error warning', salvagedCase.settings !== null && salvagedCase.errors.length > 0 && salvagedCase.errors.every(e => e.severity === 'warning'), JSON.stringify(salvagedCase.errors).slice(0, 200))
  const voided = parseBlob('{nope')
  check('a voided file keeps the hard default', voided.settings === null && voided.errors.length > 0 && voided.errors.every(e => e.severity !== 'warning'), JSON.stringify(voided.errors).slice(0, 200))
  const filtered = parseBlob({ guardrails: { allow: ['Bash', 'Bash(rm -rf *'] } })
  check(
    'a dropped allow rule grades warning (the filter stamp)',
    filtered.settings !== null && filtered.errors.some(e => e.severity === 'warning' && /permission rule/.test(e.message)),
    JSON.stringify(filtered.errors).slice(0, 200),
  )
  const unreadDeny = parseBlob({ guardrails: { deny: ['Bash', 'Bash(rm -rf *'] } })
  check(
    'a deny rule nothing can read grades error, and the rules beside it stay (a protection that is not in force is said loudly)',
    unreadDeny.settings !== null && unreadDeny.errors.some(e => e.severity === 'error' && /permission rule/.test(e.message)) && JSON.stringify(unreadDeny.settings?.guardrails?.deny) === JSON.stringify(['Bash']),
    JSON.stringify(unreadDeny.errors).slice(0, 200),
  )
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-settings-salvage: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-settings-salvage: all green')
