#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'prune-set-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_TIME_BASED_MC = '1'
delete process.env.MERCURY_MC_DIGEST

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const law = await import('../../src/services/compact/pruneProtections.ts')
const { projectTimeBasedMicrocompact, microcompactMessages, TIME_BASED_MC_CLEARED_MESSAGE } = await import('../../src/services/compact/microCompact.ts')
const { MC_DIGEST_PREFIX, isClearedOrDigested } = await import('../../src/services/compact/microCompactDigest.ts')
const { buildLargeToolResultMessage } = await import('../../src/utils/toolResultStorage.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
type Message = import('../../src/types/message.ts').Message

const CLASS = ['Read', 'Bash', 'Grep', 'Agent', 'Eval', 'Workshop', 'Inspect', 'Zzz']
const NEVER = ['AskUserQuestion', 'ToolSearch', 'TeamBrief']
const PROTECTED = ['Skill', 'Brief', 'ExitStrategyMode', 'EnterStrategyMode']
const PERSISTED_PATH = join(home, 'tool-results', 'agent-1.txt')
const PERSISTED_AGENT = buildLargeToolResultMessage({ filepath: PERSISTED_PATH, originalSize: 120_000, preview: 'p'.repeat(1_500) } as never)

const OLD = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
const stamp = (m: Message): Message => ({ ...m, timestamp: OLD }) as Message
const chars = (tokens: number): string => 'x'.repeat(tokens * 4)
type Use = { id: string; name: string; content: string; input?: Record<string, unknown> }
function transcript(uses: Use[]): Message[] {
  return [
    stamp(createUserMessage({ content: 'go' }) as Message),
    stamp(createAssistantMessage({ content: uses.map(u => ({ type: 'tool_use', id: u.id, name: u.name, input: u.input ?? {} })) as never }) as Message),
    stamp(createUserMessage({ content: uses.map(u => ({ type: 'tool_result', tool_use_id: u.id, content: u.content })) as never }) as Message),
    stamp(createAssistantMessage({ content: [{ type: 'text', text: 'done', citations: null }] as never }) as Message),
  ]
}
function resultOf(messages: readonly Message[], id: string): string {
  for (const m of messages) {
    const content = (m as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    const hit = (content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>).find(b => b.type === 'tool_result' && b.tool_use_id === id)
    if (hit) return typeof hit.content === 'string' ? hit.content : JSON.stringify(hit.content)
  }
  return ''
}
const fillers = (tokens: number): Use[] => ['f1', 'f2', 'f3', 'f4', 'f5'].map(id => ({ id, name: 'Bash', content: chars(tokens) }))
const named = (): Use[] => [
  ...CLASS.map(name => ({ id: `use_${name}`, name, content: chars(4_000), input: name === 'Read' ? { file_path: '/repo/src/index.ts' } : {} })),
  ...NEVER.map(name => ({ id: `use_${name}`, name, content: chars(4_000) })),
  ...PROTECTED.map(name => ({ id: `use_${name}`, name, content: chars(4_000) })),
  { id: 'use_agent_persisted', name: 'Agent', content: PERSISTED_AGENT },
]
const history = (): Message[] => transcript([...named(), ...fillers(9_000)])

section('§A the class rule: every result is a candidate unless its class is never pruned')
const projected = projectTimeBasedMicrocompact(history(), 'repl_main_thread')
if (projected === null) {
  check('the clearing pass armed for the fixture', false, 'projection returned null')
} else {
  for (const name of CLASS) check(`${name}: a stale result outside the protected tail is cleared${name === 'Zzz' ? ' — a tool no list ever named' : ''}`, !resultOf(projected.messages, `use_${name}`).includes('xxxx'), resultOf(projected.messages, `use_${name}`).slice(0, 60))
  for (const name of NEVER) check(`${name}: never pruned — its result stays verbatim`, resultOf(projected.messages, `use_${name}`) === chars(4_000))
  for (const name of PROTECTED) check(`${name}: protected — its result stays verbatim`, resultOf(projected.messages, `use_${name}`) === chars(4_000))
  for (const id of ['f1', 'f2', 'f3', 'f4', 'f5']) check(`${id}: inside the recent five — stays`, resultOf(projected.messages, id) === chars(9_000))
  check('the cleared ids are exactly the class results plus the persisted Agent result', JSON.stringify([...projected.clearedIds].sort()) === JSON.stringify([...CLASS.map(n => `use_${n}`), 'use_agent_persisted'].sort()), projected.clearedIds.join(','))
  check('the never-prune set is the protection law\'s own', NEVER.every(name => law.isProtectedFromPruning(name)) && law.PROTECTED_TOOL_NAMES.has('AskUserQuestion') && law.PROTECTED_TOOL_NAMES.has('ToolSearch') && law.PROTECTED_TOOL_NAMES.has('TeamBrief'))
}

section('§B the budget arithmetic: the newest 40k tokens of tool output stay, a pass under 20k clears nothing, never a result under 50 tokens')
{
  check('the three defaults', law.PROTECT_NEWEST_TOOL_OUTPUT_TOKENS === 40_000 && law.PRUNE_MINIMUM_SAVING_TOKENS === 20_000 && law.PLACEHOLDER_COST_FLOOR_TOKENS === 50)
  const sixteen = transcript(Array.from({ length: 16 }, (_, i) => ({ id: `r${i + 1}`, name: 'Bash', content: chars(4_000) })))
  const p16 = projectTimeBasedMicrocompact(sixteen, 'repl_main_thread')
  check('sixteen results of 4k tokens: r7 through r16 (the newest 40k) stay, r1 through r6 are cleared — the budget reaches past the recent five', p16 !== null && JSON.stringify([...p16.clearedIds].sort()) === JSON.stringify(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].sort()) && resultOf(p16.messages, 'r7') === chars(4_000), p16 === null ? 'null' : p16.clearedIds.join(','))
  const ten = transcript(Array.from({ length: 10 }, (_, i) => ({ id: `r${i + 1}`, name: 'Bash', content: chars(3_000) })))
  check('ten results of 3k tokens (30k in all): nothing is cleared — every one sits inside the newest 40k', projectTimeBasedMicrocompact(ten, 'repl_main_thread') === null)
  const eleven = transcript(Array.from({ length: 11 }, (_, i) => ({ id: `r${i + 1}`, name: 'Bash', content: chars(5_000) })))
  check('eleven results of 5k tokens: r1 through r3 sit outside the budget but would save 15k — under the 20k minimum the pass clears nothing', projectTimeBasedMicrocompact(eleven, 'repl_main_thread') === null)
  const twelve = transcript(Array.from({ length: 12 }, (_, i) => ({ id: `r${i + 1}`, name: 'Bash', content: chars(5_000) })))
  const p12 = projectTimeBasedMicrocompact(twelve, 'repl_main_thread')
  check('twelve results of 5k tokens: r1 through r4 save 20k — cleared', p12 !== null && JSON.stringify([...p12.clearedIds].sort()) === JSON.stringify(['r1', 'r2', 'r3', 'r4'].sort()) && p12.tokensSaved === 20_000, p12 === null ? 'null' : `${p12.clearedIds.join(',')} ${p12.tokensSaved}`)
  const p11pressure = projectTimeBasedMicrocompact(eleven, 'repl_main_thread', { pressure: true })
  check('under context pressure the pass keeps its own law: the same eleven clear r1 through r3 (15k) with no 20k minimum', p11pressure !== null && p11pressure.clearedIds.length === 3 && p11pressure.tokensSaved === 15_000, p11pressure === null ? 'null' : `${p11pressure.clearedIds.join(',')} ${p11pressure.tokensSaved}`)
  const floor = transcript([
    { id: 'tiny49', name: 'Bash', content: 'y'.repeat(49 * 4) },
    { id: 'small52', name: 'Bash', content: 'y'.repeat(52 * 4) },
    ...Array.from({ length: 16 }, (_, i) => ({ id: `r${i + 1}`, name: 'Bash', content: chars(4_000) })),
  ])
  const pf = projectTimeBasedMicrocompact(floor, 'repl_main_thread')
  check('a 49-token result outside the budget stays (never under 50), a 52-token one is cleared', pf !== null && resultOf(pf.messages, 'tiny49') === 'y'.repeat(49 * 4) && !resultOf(pf.messages, 'small52').includes('yyyy'), pf === null ? 'null' : pf.clearedIds.join(','))
}

section("§C a pruned Agent result reads the same line every pruned result reads")
{
  const digested = projectTimeBasedMicrocompact(history(), 'repl_main_thread')
  const agent = digested === null ? '' : resultOf(digested.messages, 'use_Agent')
  check('with the digest on, the Agent result wears the digest label', agent.startsWith(MC_DIGEST_PREFIX), agent.slice(0, 80))
  process.env.MERCURY_MC_DIGEST = '0'
  const bare = projectTimeBasedMicrocompact(history(), 'repl_main_thread')
  const agentBare = bare === null ? '' : resultOf(bare.messages, 'use_Agent')
  const bashBare = bare === null ? '' : resultOf(bare.messages, 'use_Bash')
  check(`with the digest off, the Agent result is the placeholder line '${TIME_BASED_MC_CLEARED_MESSAGE}', the same as a Bash result's`, agentBare === TIME_BASED_MC_CLEARED_MESSAGE && bashBare === TIME_BASED_MC_CLEARED_MESSAGE, `${agentBare.slice(0, 60)} | ${bashBare.slice(0, 60)}`)
  delete process.env.MERCURY_MC_DIGEST
}

section('§D a result whose full output was saved to a file keeps the line that names the file')
{
  const cleared = projectTimeBasedMicrocompact(history(), 'repl_main_thread')
  const persisted = cleared === null ? '' : resultOf(cleared.messages, 'use_agent_persisted')
  check('the preview bytes are gone', !persisted.includes('ppppp'), persisted.slice(0, 120))
  check('the digest label leads', persisted.startsWith(MC_DIGEST_PREFIX), persisted.slice(0, 80))
  check("the line naming the saved file rides below it, in the storage module's own words", persisted.includes(`Full output saved to: ${PERSISTED_PATH}`), persisted)
  check('the kept content reads as already cleared (no second clearing)', isClearedOrDigested(persisted))
  const again = cleared === null ? null : projectTimeBasedMicrocompact(cleared.messages, 'repl_main_thread')
  check('a second pass over the cleared history clears nothing more', again === null, again === null ? '' : `${again.cleared} cleared again`)
  process.env.MERCURY_MC_DIGEST = '0'
  const bare = projectTimeBasedMicrocompact(history(), 'repl_main_thread')
  const persistedBare = bare === null ? '' : resultOf(bare.messages, 'use_agent_persisted')
  check('with the digest off, the placeholder leads and the file line follows', persistedBare.startsWith(TIME_BASED_MC_CLEARED_MESSAGE) && persistedBare.includes(`Full output saved to: ${PERSISTED_PATH}`) && isClearedOrDigested(persistedBare), persistedBare.slice(0, 160))
  delete process.env.MERCURY_MC_DIGEST
}

section('§E the live apply and the pure projection agree')
{
  const base = history()
  const pure = projectTimeBasedMicrocompact(base, 'repl_main_thread')
  const applied = await microcompactMessages(base, undefined, 'repl_main_thread')
  check('the applied messages are the projected messages, byte for byte', pure !== null && JSON.stringify(applied.messages) === JSON.stringify(pure.messages))
  check('the applied receipt carries the same count and saving', pure !== null && applied.pruned?.cleared === pure.cleared && applied.pruned?.tokensSaved === pure.tokensSaved, JSON.stringify(applied.pruned))
}

section('§F the seams, by their text')
{
  const micro = readFileSync(join(ROOT, 'src/services/compact/microCompact.ts'), 'utf8')
  const storage = readFileSync(join(ROOT, 'src/utils/toolResultStorage.ts'), 'utf8')
  const protections = readFileSync(join(ROOT, 'src/services/compact/pruneProtections.ts'), 'utf8')
  check('the clearing path carries no list of names to prune: the candidate rule is the protection law alone', !micro.includes('COMPACTABLE_TOOL_NAMES') && micro.includes('if (!isProtectedFromPruning(record.name, record.input)) {'))
  check('the never-prune names live in the protection law through their light name homes', protections.includes("from '../../tools/AskUserQuestionTool/prompt.js'") && protections.includes("from '../../tools/TeamBriefTool/constants.js'") && protections.includes("from '../../tools/ToolSearchTool/constants.js'"))
  check("the file line's phrase in the clearing path equals the storage module's own (drift guard)", micro.includes("const PERSISTED_PATH_PHRASE = 'Full output saved to: '") && storage.includes('Full output saved to: ${result.filepath}'))
  check('the three defaults are named once, in the protection law', micro.includes('PROTECT_NEWEST_TOOL_OUTPUT_TOKENS') && micro.includes('PRUNE_MINIMUM_SAVING_TOKENS') && !/40_000|20_000/.test(micro))
}

rmSync(home, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
