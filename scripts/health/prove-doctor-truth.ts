#!/usr/bin/env bun
// ============================================================================
//  prove-doctor-truth — the certificate's eleven small lies stay dead.
//
//  Doctor is the support artifact the docs make the bug-report medium and
//  the stranger's minute-nine surface; the lying-gauge census found eleven
//  rows whose feeders were stubbed, vacuous or mis-cast. Each pin below
//  names one and holds its fix:
//   · settings errors composed from the REAL shape (file · path · message),
//     never the phantom .error cast's perpetual 'unreadable'
//   · env-override values name their cut (… marker), and the boot's own
//     MERCURY_ENTRYPOINT self-stamp never counts as an operator override
//   · no 'verbs N' term (nothing ever mints a verb: kind — the counter was
//     a fabricated zero over real verb traffic)
//   · the ROUTER row says 'wired' (architecture), never 'LIVE' (a liveness
//     claim over a signed-out box)
//   · the history row checks the REAL file's shape (a directory fails) and
//     says 'no append attempted this run' instead of vacuous health
//   · themis's evidence splits warn (observing) from enforce (denied)
//   · system-lane ripgrep presence is the PATH lookup, never existsSync of
//     the bare name against the cwd
//   · win32 names its unreadable load instead of 'load 0.00/core'
//   · the mcp gauge reads the checked-in .mcp.json beside the config stores
//   · an unreadable settings file (EISDIR and kin) is a NAMED validation
//     error, never '0 validation errors'
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const health = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
const gauge = readFileSync(join(ROOT, 'src/utils/cockpit/mcpGauge.ts'), 'utf8')
const settings = readFileSync(join(ROOT, 'src/utils/settings/settings.ts'), 'utf8')
const history = readFileSync(join(ROOT, 'src/history.ts'), 'utf8')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

t('settings errors compose file · path · message', health.includes('[first.file, first.path, first.message].filter(Boolean)'))
t("…the phantom .error cast is dead", !health.includes('(first as { error?: unknown })?.error'))
t('env values name their cut', health.includes("value.length > 12 ? `${value.slice(0, 12)}…`"))
t('the boot self-stamp never counts as an override', health.includes('const set = present.filter(f => f.selfStamped !== true)'))
t("no fabricated 'verbs N' term", !health.includes('· verbs ${verbTotal}'))
t("the ROUTER row says configured, never LIVE", health.includes('anthropic configured (') && !health.includes('anthropic LIVE ('))
t('the history row fails a directory-shaped store', health.includes('history.jsonl is a DIRECTORY'))
t('…and says when nothing was tried', health.includes('no append attempted this run') && history.includes('historyEverFlushedThisProcess'))
t('themis splits observing from enforced', health.includes('blocklist OBSERVING at the execution gate') && health.includes('blocklist ENFORCED at the execution gate'))
t('ripgrep presence is the status fact, never existsSync of the bare name', health.includes('const rgPresent = rg.present') && !health.includes("existsSync(rg.path)"))
t('win32 names its unreadable load', health.includes('load n/a (win32 has no loadavg)'))
t('the mcp gauge reads the checked-in project file', gauge.includes('getProjectMcpConfigsFromCwd()'))
t('an unreadable settings file is a NAMED error', settings.includes('settings file unreadable:'))

console.log(failures === 0 ? 'DOCTOR TRUTH: ALL PASS' : 'DOCTOR TRUTH: RED')
process.exit(failures)
