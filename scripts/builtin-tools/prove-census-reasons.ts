#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-census-reasons.ts — every gated tool in the
//  census carries a TRUE reason, and the doctor prints it.
//
//  The doctor's TOOL CAPABILITY row read "13 conditional · 11 unavailable"
//  and named none of them: the per-tool reasons never reached the operator,
//  and on this box three shapes had no reason at all — SendUserFile and
//  SendUserMessage (present, isEnabled()=false, no declared condition) and
//  the four Task tools (out of a headless catalog with no gate or condition
//  declared, though every interactive session has them). The declarations
//  now say what each waits on; censusGapLines groups the rows by reason for
//  the doctor's detail; a row with no reason is named as a gap.
//
//    §1 every conditional row declares a condition; every unavailable row
//       declares a gate or a condition (the live census, this box)
//    §2 the grouped lines: shared reasons ride one line, an isEnabled()=false
//       conditional tool wears "(off right now)", a reasonless row is named
//    §3 the specific truths driven on this box
//    §4 the doctor's census check prints the lines (source pin)
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..')
process.chdir(repoRoot)
process.env.MERCURY_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), 'census-reasons-')), 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { buildToolCensus, censusGapLines, CENSUS_NO_REASON } = await import('../../src/utils/capability/census.ts')
type Census = ReturnType<typeof buildToolCensus>

console.log('── census reasons ──')
const census = buildToolCensus()

console.log('[1] every gated row declares its reason')
{
  const conditionalWithout = census.rows.filter(r => r.support === 'conditional' && !(r.declared?.conditions?.length)).map(r => r.name)
  check('every conditional tool declares the condition it waits on', conditionalWithout.length === 0, conditionalWithout.join(', '))
  const unavailableWithout = census.rows.filter(r => r.support === 'unavailable' && r.declared?.gate === undefined && !(r.declared?.conditions?.length)).map(r => r.name)
  check('every gated-out tool declares a gate or a condition', unavailableWithout.length === 0, unavailableWithout.join(', '))
  const lines = censusGapLines(census)
  check('no line reads "no reason declared"', !lines.some(l => l.reason === CENSUS_NO_REASON), lines.filter(l => l.reason === CENSUS_NO_REASON).map(l => l.tools.join(',')).join(' | '))
  const named = new Set(lines.flatMap(l => l.tools.map(tool => tool.replace(' (off right now)', ''))))
  const gated = census.rows.filter(r => r.support !== 'available').map(r => r.name)
  check('every non-available tool is named on exactly one line', gated.every(name => named.has(name)) && lines.reduce((n, l) => n + l.tools.length, 0) === gated.length, `${gated.length} gated, ${named.size} named`)
}

console.log('[2] the grouped lines (pure)')
{
  const row = (name: string, support: 'conditional' | 'unavailable', declared: Record<string, unknown> | null, enabledNow = true): Census['rows'][number] =>
    ({ name, support, enabledNow, inCatalogNow: support === 'conditional', declared }) as never
  const synthetic = {
    rows: [
      row('Glob', 'conditional', { conditions: ['a search binary'] }),
      row('Grep', 'conditional', { conditions: ['a search binary'] }),
      row('LSP', 'conditional', { conditions: ['a connected language server'] }, false),
      row('Retain', 'unavailable', { gate: 'FLAG_OPT' }),
      row('Recall', 'unavailable', { gate: 'FLAG_OPT' }),
      row('Godot', 'unavailable', { gate: 'FLAG_OPT', conditions: ['a project.godot root'] }),
      row('Debug', 'unavailable', { gate: 'FLAG_ON' }),
      row('Mystery', 'unavailable', null),
    ],
  } as unknown as Census
  const kinds: Record<string, string> = { FLAG_OPT: 'opt-in', FLAG_ON: 'default-on' }
  const lines = censusGapLines(synthetic, env => kinds[env])
  const byTools = (tools: string): string | undefined => lines.find(l => l.tools.join(',') === tools)?.reason
  check('tools sharing one condition ride one line', byTools('Glob,Grep') === 'needs a search binary', JSON.stringify(lines))
  check('an isEnabled()=false conditional tool wears "(off right now)"', byTools('LSP (off right now)') === 'needs a connected language server')
  check('an opt-in gate says unset (an opt-in flag)', byTools('Retain,Recall') === 'FLAG_OPT unset (an opt-in flag)')
  check('a gate plus a condition carries both', byTools('Godot') === 'FLAG_OPT unset (an opt-in flag) · needs a project.godot root')
  check('a default-on gate says turned off', byTools('Debug') === 'FLAG_ON turned off')
  check('a row with no reason is named as the gap', byTools('Mystery') === CENSUS_NO_REASON)
  check('conditional lines carry the conditional support word, gated lines the unavailable one', lines.every(l => (l.tools[0]!.startsWith('G') && l.tools[0] !== 'Godot') || l.tools[0] === 'LSP (off right now)' ? l.support === 'conditional' : l.support === 'unavailable'))
}

console.log('[3] the truths driven on this box')
{
  const lines = censusGapLines(census)
  const lineOf = (tool: string) => lines.find(l => l.tools.some(name => name === tool || name === `${tool} (off right now)`))
  const sendFile = lineOf('SendUserFile')
  check('SendUserFile names the missing delivery channel (isEnabled() is a constant false in this build)', sendFile !== undefined && sendFile.reason.includes('delivery channel'), sendFile?.reason)
  const brief = lineOf('SendUserMessage')
  check('SendUserMessage names the away session or the opt-in, and the flag that forces it', brief !== undefined && brief.reason.includes('opt-in') && brief.reason.includes('MERCURY_BRIEF'), brief?.reason)
  for (const tool of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']) {
    const line = lineOf(tool)
    const interactive = census.rows.find(r => r.name === tool)?.inCatalogNow === true
    check(`${tool} ${interactive ? 'is conditional here and' : 'is out of this headless catalog and'} names the interactive session + MERCURY_TASKS`, line !== undefined && line.reason.includes('interactive session') && line.reason.includes('MERCURY_TASKS'), line?.reason)
  }
  const glob = lineOf('Glob')
  check('Glob names the search binary', glob !== undefined && glob.reason.includes('search binary'), glob?.reason)
}

console.log('[4] the doctor prints the lines (source pin)')
{
  const health = readFileSync(join(repoRoot, 'src/utils/healthReport.ts'), 'utf8')
  const at = health.indexOf("id: 'capability-census'")
  const body = at === -1 ? '' : health.slice(at, at + 2400)
  check('the census check reads censusGapLines', body.includes('censusGapLines(c)'))
  check('…and prints every line as the row’s detail', body.includes('{ detail }') && body.includes("g.support === 'conditional' ? 'conditional' : 'off'"))
  check('…and a reasonless row warns the check', body.includes("reasonless.length > 0 ? ('warn' as const)"))
}

console.log(failures === 0 ? '\n ✅ CENSUS REASONS — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
