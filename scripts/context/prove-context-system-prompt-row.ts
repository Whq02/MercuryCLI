#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_BARE', 'MERCURY_EFFORT_LEVEL']) {
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

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { analyzeContextUsage } = await import('../../src/engine/context-window/analyzeContext.ts')
const { getSystemPrompt } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { MERCURY_CONSTITUTION } = await import('../../src/engine/system-prompt/mercuryContract.ts')

const MODEL = 'claude-fable-5-1'
const agents = { activeAgents: [], allAgents: [] }
const displayName = (part: string): string => {
  const heading = /^#+\s+(.+)$/m.exec(part)
  if (heading?.[1]) return heading[1]
  const firstLine = part.split('\n').find(line => line.trim().length > 0) ?? ''
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}
const rowsFor = async (options: Record<string, unknown>): Promise<string[]> => {
  const data = await analyzeContextUsage([], MODEL, async () => getEmptyToolPermissionContext(), [], agents, 120, { options } as never)
  return (data.systemPromptSections ?? []).map(s => s.name)
}
const defaultParts = (await getSystemPrompt([], MODEL)).filter(p => p !== '')
const expectedDefault = defaultParts.map(displayName)
const floorName = displayName(MERCURY_CONSTITUTION)
const startsWith = (rows: string[], head: string[]): boolean => head.length <= rows.length && head.every((n, i) => rows[i] === n)
const rowFix = 'fix countSystemPrompt in src/engine/context-window/analyzeContext.ts so the rows match what getSystemPrompt and buildEffectiveSystemPrompt (src/engine/system-prompt/systemPrompt.ts) compose from customSystemPrompt and appendSystemPrompt'

console.log('/context counts the prompt the request path composes')

section('§1 the default session: the row lists every default part, not the floor alone')
{
  check('the default prompt is many parts (the fixture is meaningful)', expectedDefault.length > 1, `${expectedDefault.length}; getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts returned a single part, so the fixture cannot show the row listing every default part`)
  const rows = await rowsFor({})
  check('THE ROW LISTS THE WHOLE DEFAULT PROMPT (the base listed the identity floor alone)', startsWith(rows, expectedDefault), `${rows.length} row(s): ${rows.slice(0, 3).join(' · ')}; ${rowFix}`)
  check('…and not the floor-only composition', !(rows.length <= 2 && rows[0] === floorName), `${rows.join(' · ')}; ${rowFix}`)
  const rowsNoContext = await rowsFor({ customSystemPrompt: undefined, appendSystemPrompt: undefined })
  check('explicitly-undefined options compose the same default', startsWith(rowsNoContext, expectedDefault), `${rowsNoContext.slice(0, 3).join(' · ')}; an explicitly undefined customSystemPrompt or appendSystemPrompt must compose the default prompt, see ${rowFix}`)
}

section('§2 the replacing paths still replace, and the append rides last')
{
  const custom = await rowsFor({ customSystemPrompt: 'CUSTOM PROMPT FOR THE PIN' })
  check('a custom prompt composes floor + custom (the SDK replacement contract stands)', custom[0] === floorName && custom[1] === 'CUSTOM PROMPT FOR THE PIN', `${custom.slice(0, 3).join(' · ')}; ${rowFix}`)
  check('…and never the default parts', !startsWith(custom, expectedDefault), `${custom.slice(0, 3).join(' · ')}; a custom prompt replaces the default parts, ${rowFix}`)
  const appended = await rowsFor({ appendSystemPrompt: 'APPENDED FOR THE PIN' })
  check('an append rides after the whole default', startsWith(appended, expectedDefault) && appended[expectedDefault.length] === 'APPENDED FOR THE PIN', `${appended.slice(expectedDefault.length - 1, expectedDefault.length + 2).join(' · ')}; ${rowFix}`)
  const emptyCustom = await rowsFor({ customSystemPrompt: '' })
  check('an explicit empty custom prompt mirrors the request path (floor alone) — the diagnostic re-interprets nothing', emptyCustom[0] === floorName && !startsWith(emptyCustom, expectedDefault), `${emptyCustom.slice(0, 2).join(' · ')}; ${rowFix}`)
}


console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-context-system-prompt-row${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
