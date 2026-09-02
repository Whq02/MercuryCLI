#!/usr/bin/env bun
// ============================================================================
//  scripts/context/prove-context-system-prompt-row.ts — /context's "System
//  prompt" row counts the WHOLE composed prompt the request path sends
//  (FN-017 R3, S2: /context omitted the entire default system prompt from
//  its own accounting).
//
//  countSystemPrompt (utils/analyzeContext) composes the effective prompt
//  through the same composer the request path uses, but it handed an ABSENT
//  custom prompt over as '' — and the composer's custom slot takes '' as a
//  replacement (the append slot below it guards !== ''; the custom slot
//  tests !== undefined only, the SDK's exact-replacement contract). So on
//  every default session — no custom prompt, no main-thread agent — the row
//  counted the identity floor alone, tens of thousands of characters short
//  of the prompt on the wire, and Free space was overstated by the
//  difference: the surface an operator reads to decide when to compact was
//  wrong on the default configuration. The options now ride through
//  UNCOERCED: the diagnostic composes exactly what the request path
//  composes (undefined stays undefined; an explicit '' stays '' — the
//  request path's own reading of it, never re-interpreted here).
//
//   §1 DRIVEN: the default session's row lists every default part
//   §2 DRIVEN: the replacing paths still replace (custom · append · the
//      explicit-empty mirror)
//   §3 the shape: no coercion at the call site; the composer's slot unchanged
//
//  Counting itself needs a first-party credential (both counters answer
//  null here and the sizes read 0 — countsAvailable says so); the SECTION
//  LIST is the composition, and that is what this prover pins.
//
//  Run:  ~/.bun/bin/bun run scripts/context/prove-context-system-prompt-row.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_MODEL', 'MERCURY_SIMPLE', 'MERCURY_EFFORT_LEVEL', 'CLAUDE_EFFORT']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-ctx-sysprompt-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { analyzeContextUsage } = await import('../../src/utils/analyzeContext.ts')
const { getSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } = await import('../../src/constants/prompts.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { MERCURY_IDENTITY_FLOOR } = await import('../../src/prompt/mercuryContract.ts')

const MODEL = 'claude-fable-5-1'
const agents = { activeAgents: [], allAgents: [] }
/** The display name the row gives a part — the analyzer's own rule
 *  (a markdown heading, else the first non-empty line clipped at 40). */
const displayName = (part: string): string => {
  const heading = /^#+\s+(.+)$/m.exec(part)
  if (heading?.[1]) return heading[1]
  const firstLine = part.split('\n').find(line => line.trim().length > 0) ?? ''
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}
/** /context's own analysis over an empty transcript with the given
 *  session options — the surface, not a re-derivation. */
const rowsFor = async (options: Record<string, unknown>): Promise<string[]> => {
  const data = await analyzeContextUsage([], MODEL, async () => getEmptyToolPermissionContext(), [], agents, 120, { options } as never)
  return (data.systemPromptSections ?? []).map(s => s.name)
}
const defaultParts = (await getSystemPrompt([], MODEL)).filter(p => p !== '' && p !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
const expectedDefault = defaultParts.map(displayName)
const floorName = displayName(MERCURY_IDENTITY_FLOOR)
const startsWith = (rows: string[], head: string[]): boolean => head.length <= rows.length && head.every((n, i) => rows[i] === n)

console.log('/context counts the prompt the request path composes')

// ── §1 the default session ──────────────────────────────────────────────────
section('§1 the default session: the row lists every default part, not the floor alone')
{
  check('the default prompt is many parts (the fixture is meaningful)', expectedDefault.length > 1, String(expectedDefault.length))
  const rows = await rowsFor({})
  check('THE ROW LISTS THE WHOLE DEFAULT PROMPT (the base listed the identity floor alone)', startsWith(rows, expectedDefault), `${rows.length} row(s): ${rows.slice(0, 3).join(' · ')}`)
  check('…and not the floor-only composition', !(rows.length <= 2 && rows[0] === floorName), rows.join(' · '))
  const rowsNoContext = await rowsFor({ customSystemPrompt: undefined, appendSystemPrompt: undefined })
  check('explicitly-undefined options compose the same default', startsWith(rowsNoContext, expectedDefault))
}

// ── §2 the replacing paths ──────────────────────────────────────────────────
section('§2 the replacing paths still replace, and the append rides last')
{
  const custom = await rowsFor({ customSystemPrompt: 'CUSTOM PROMPT FOR THE PIN' })
  check('a custom prompt composes floor + custom (the SDK replacement contract stands)', custom[0] === floorName && custom[1] === 'CUSTOM PROMPT FOR THE PIN', custom.slice(0, 3).join(' · '))
  check('…and never the default parts', !startsWith(custom, expectedDefault))
  const appended = await rowsFor({ appendSystemPrompt: 'APPENDED FOR THE PIN' })
  check('an append rides after the whole default', startsWith(appended, expectedDefault) && appended[expectedDefault.length] === 'APPENDED FOR THE PIN', appended.slice(expectedDefault.length - 1, expectedDefault.length + 2).join(' · '))
  // The mirror law: an EXPLICIT empty custom prompt is what the request
  // path reads it as (a replacement — QueryEngine tests !== undefined),
  // so the diagnostic must not re-interpret it either way.
  const emptyCustom = await rowsFor({ customSystemPrompt: '' })
  check('an explicit empty custom prompt mirrors the request path (floor alone) — the diagnostic re-interprets nothing', emptyCustom[0] === floorName && !startsWith(emptyCustom, expectedDefault), emptyCustom.slice(0, 2).join(' · '))
}

// ── §3 the shape ────────────────────────────────────────────────────────────
section('§3 the shape: the options ride through uncoerced; the composer is untouched')
{
  const analyzer = readFileSync(join(ROOT, 'src/utils/analyzeContext.ts'), 'utf8')
  const call = analyzer.slice(analyzer.indexOf('buildEffectiveSystemPrompt({'), analyzer.indexOf('})', analyzer.indexOf('buildEffectiveSystemPrompt({')))
  check("the call site passes customSystemPrompt through (no `?? ''`)", /customSystemPrompt: options\?\.customSystemPrompt as string \| undefined,/.test(call) && !/customSystemPrompt:[^\n]*\?\? ''/.test(call), call.slice(0, 200))
  check("…and appendSystemPrompt through (no `?? ''`)", /appendSystemPrompt: options\?\.appendSystemPrompt as string \| undefined,/.test(call) && !/appendSystemPrompt:[^\n]*\?\? ''/.test(call))
  check('no other call site in src coerces an absent prompt to the empty string', !/(customSystemPrompt|appendSystemPrompt)[^\n]*\?\? ''/.test(analyzer))
  const composer = readFileSync(join(ROOT, 'src/utils/systemPrompt.ts'), 'utf8')
  check('the composer\'s custom slot keeps the request path\'s reading (!== undefined — the SDK contract, shared with QueryEngine)', /else if \(customSystemPrompt !== undefined\) \{/.test(composer))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-context-system-prompt-row${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
