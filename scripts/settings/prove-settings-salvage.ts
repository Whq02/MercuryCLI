#!/usr/bin/env bun
// prove-settings-salvage — one bad value no longer voids the file (field card
// FC-004, folding E008 71/82/89). A schema-invalid value ANYWHERE in a
// settings file used to discard the ENTIRE file — every unrelated key,
// including every permissions.deny rule, silently stopped applying, and
// doctor then reported "no settings pin" for a pin the operator wrote. The
// parse door now salvages: exactly the invalid entries are pruned (leaf, or
// nearest existing ancestor for a missing-required), every valid sibling
// survives, and the validation errors still surface.
//
//   §1 the card's own repro: a quoted number beside a deny list.
//   §2 a mistyped defaultMode drops alone; sibling deny rules survive.
//   §3 one malformed hook entry drops alone; the valid sibling entry stays.
//   §4 control: a fully valid file parses clean with zero errors.
//   §5 root-malformed JSON still fails whole (nothing to salvage).
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'settings-salvage-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { parseSettingsFile } = await import('../../src/utils/settings/settings.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
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
  const { settings, errors } = parseBlob({ permissions: { deny: ['Bash'] }, cleanupPeriodDays: '30' })
  check('the file is NOT discarded (FC-004)', settings !== null)
  check(
    'the deny rules the operator wrote still apply',
    JSON.stringify(settings?.permissions?.deny) === JSON.stringify(['Bash']),
    JSON.stringify(settings?.permissions),
  )
  check(
    'exactly the invalid key is dropped',
    settings !== null && !('cleanupPeriodDays' in (settings as Record<string, unknown>)),
  )
  check(
    'the validation error still surfaces (names the bad key)',
    errors.length > 0 && errors.some(e => JSON.stringify(e).includes('cleanupPeriodDays')),
    JSON.stringify(errors).slice(0, 200),
  )
}

section('§2 A MISTYPED defaultMode')
{
  const { settings } = parseBlob({ permissions: { defaultMode: 'bogus-mode', deny: ['Bash'] } })
  check('the file survives a bad defaultMode', settings !== null)
  check(
    'the sibling deny rules survive beside the dropped mode',
    JSON.stringify(settings?.permissions?.deny) === JSON.stringify(['Bash']),
    JSON.stringify(settings?.permissions),
  )
  check(
    'the bad mode itself is dropped, not kept',
    settings?.permissions?.defaultMode === undefined,
    JSON.stringify(settings?.permissions?.defaultMode),
  )
}

section('§3 ONE MALFORMED HOOK ENTRY')
{
  const { settings } = parseBlob({
    model: 'claude-sonnet-5',
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command' }] }, // missing required command
        { hooks: [{ type: 'command', command: 'echo ok' }] },
      ],
    },
  })
  check('the file survives one malformed hook entry', settings !== null)
  check('the unrelated model pin survives', settings?.model === 'claude-sonnet-5', JSON.stringify(settings?.model))
  const sessionStart = (settings?.hooks as Record<string, unknown[]> | undefined)?.SessionStart
  check(
    'the VALID sibling hook entry survives the prune',
    Array.isArray(sessionStart) &&
      JSON.stringify(sessionStart).includes('echo ok') &&
      !JSON.stringify(sessionStart).includes('{"type":"command"}'),
    JSON.stringify(sessionStart),
  )
}

section('§4 CONTROL — a fully valid file')
{
  const { settings, errors } = parseBlob({ permissions: { deny: ['Bash'] }, cleanupPeriodDays: 30 })
  check('a valid file parses exactly as before', settings !== null && settings.cleanupPeriodDays === 30)
  check('zero errors on a valid file', errors.length === 0, JSON.stringify(errors))
}

section('§5 ROOT-MALFORMED JSON')
{
  const { settings, errors } = parseBlob('{nope')
  check('malformed JSON still fails whole (nothing to salvage)', settings === null)
  check('and still reports', errors.length > 0)
}

section('§6 THE SEVERITY CHANNEL (B9) — the loader grades what it knows')
{
  // A salvaged file: every zod record is a VALUE-level skip (the remainder
  // applies) — the loader stamps 'warning', and the dialog's warning arm
  // ("values listed above were skipped; the rest of the file is in effect")
  // becomes the truth instead of the whole-file-skip lie.
  const salvagedCase = parseBlob({ permissions: { deny: ['Bash'] }, cleanupPeriodDays: '30' })
  check('a salvaged file grades every error warning', salvagedCase.settings !== null && salvagedCase.errors.length > 0 && salvagedCase.errors.every(e => e.severity === 'warning'), JSON.stringify(salvagedCase.errors).slice(0, 200))
  // A voided file (root-shape failure): the hard default stands — the file
  // IS skipped whole and the dialog's error arm speaks truly.
  const voided = parseBlob('{nope')
  check('a voided file keeps the hard default', voided.settings === null && voided.errors.length > 0 && voided.errors.every(e => e.severity !== 'warning'), JSON.stringify(voided.errors).slice(0, 200))
  // The permission-rule filter's drops are value-level by construction.
  const filtered = parseBlob({ permissions: { deny: ['Bash', 'Bash(rm -rf *'] } })
  check(
    'a dropped permission rule grades warning (the filter stamp)',
    filtered.settings !== null && filtered.errors.some(e => e.severity === 'warning' && /permission rule/.test(e.message)),
    JSON.stringify(filtered.errors).slice(0, 200),
  )
  // The dialog folds BOTH channels (structural: the first-class field wins
  // soft; MCP metadata keeps its say).
  const { readFileSync } = await import('node:fs')
  const dialog = readFileSync(new URL('../../src/components/InvalidSettingsDialog.tsx', import.meta.url), 'utf8')
  check("the dialog reads the first-class channel (severity === 'warning' ⇒ soft)", dialog.includes("error.severity === 'warning'"))
  check('…and keeps the MCP metadata channel beside it', dialog.includes("error.mcpErrorMetadata?.severity !== 'warning'"))
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-settings-salvage: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-settings-salvage: all green')
