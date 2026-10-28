#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { mock } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_RUNTIME_POSTURE', 'MERCURY_KILL', 'MERCURY_MCP_MAX_RISK']) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const knapsack = await import('../../src/mneme/entryKnapsack.ts')
let composed = 0
mock.module('../../src/mneme/entryKnapsack.ts', () => ({
  ...knapsack,
  composeMemoryAtStart: async (input: { task?: { prompt?: string } }) => {
    composed += 1
    return `${knapsack.MEMORY_AT_START_HEADING}\n${input.task?.prompt !== undefined ? `request:${input.task.prompt}` : 'preview'} (composition ${composed})`
  },
}))

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(proofHome)
bootstrap.setProjectRoot(proofHome)
bootstrap.setCwdState(proofHome)
bootstrap.switchSession('00000000-0000-4000-8000-000000000051' as never, proofHome)
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const posture = await import('../../src/utils/cockpit/runtimePosture.ts')
const { getSystemPrompt, resetMemoryAtStartForTest } = await import('../../src/constants/prompts.ts')
const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const MODEL = 'claude-fable-5-1'
const promptOf = async (task?: string): Promise<string> => (await getSystemPrompt([], MODEL, [], 'default', task === undefined ? undefined : { prompt: task })).join('\n\n')
const sectionOf = (prompt: string, heading: string): string => prompt.split('\n\n').find(part => part.startsWith(heading)) ?? ''

console.log('── §1 the posture block: a mode change after it was composed leaves its bytes alone and travels as a user-turn reminder ──')
{
  posture.resetRuntimePostureForTest()
  bootstrap.setAskChannel('sdk')
  bootstrap.setSessionKind('oculus')
  posture.markSessionNonInteractive('default')
  const atBoot = posture.getRuntimePostureSection() ?? ''
  check('the hosted seat states its boot mode', /Permission mode for this run: default\./.test(atBoot), atBoot)
  const reminder = posture.markSessionPermissionMode('sovereign')
  const afterChange = posture.getRuntimePostureSection() ?? ''
  check('the block is byte-identical after the operator changed the mode', afterChange === atBoot, { before: atBoot.slice(0, 200), after: afterChange.slice(0, 200) })
  check('the change travels as a reminder that names the new mode and the boot mode', reminder === 'Permission mode for this run: sovereign (changed by the operator from default after boot; the Runtime posture section states the mode at boot).', reminder)
  check('the same mode again is no reminder', posture.markSessionPermissionMode('sovereign') === null)
  check('a change back names the boot mode as the previous one', posture.markSessionPermissionMode('default') === 'Permission mode for this run: default (changed by the operator from sovereign after boot; the Runtime posture section states the mode at boot).' && (posture.getRuntimePostureSection() ?? '') === atBoot)
  posture.markSessionPermissionModeAtClaim('implement')
  const claimed = posture.getRuntimePostureSection() ?? ''
  check('a warm claim before the first prompt composes the block afresh under the claimed mode', /Permission mode for this run: implement\./.test(claimed) && claimed !== atBoot, claimed)
  posture.resetRuntimePostureForTest()
  bootstrap.setAskChannel('sdk')
  bootstrap.setSessionKind('oculus')
  posture.markSessionNonInteractive()
  check('a mode set before the block is composed is simply the boot mode, no reminder', posture.markSessionPermissionMode('flow') === null && /Permission mode for this run: flow\./.test(posture.getRuntimePostureSection() ?? ''), posture.getRuntimePostureSection())
  posture.resetRuntimePostureForTest()
  bootstrap.setAskChannel('none')
  bootstrap.setSessionKind('headless')
  posture.markSessionNonInteractive('default')
  posture.getRuntimePostureSection()
  check('a seat whose block states no mode gets no reminder either', posture.markSessionPermissionMode('sovereign') === null)
}

console.log('── §2 the whole prompt: byte-identical across a mode change, across turns with different prompts, across a section-cache clear, and beside a prompt-less composition ──')
{
  posture.resetRuntimePostureForTest()
  resetMemoryAtStartForTest()
  clearSystemPromptSections()
  bootstrap.setAskChannel('sdk')
  bootstrap.setSessionKind('oculus')
  posture.markSessionNonInteractive('default')
  const first = await promptOf('first prompt')
  check('the first turn carries the memory block composed from its own prompt', sectionOf(first, knapsack.MEMORY_AT_START_HEADING).includes('request:first prompt'), sectionOf(first, knapsack.MEMORY_AT_START_HEADING))
  check('the first turn carries the posture block with the boot mode', sectionOf(first, '# Runtime posture').includes('Permission mode for this run: default.'))
  const second = await promptOf('second prompt')
  check('the second turn, another prompt: the system prompt is byte-identical', second === first)
  posture.markSessionPermissionMode('sovereign')
  const afterMode = await promptOf('third prompt')
  check('after the operator changed the mode: byte-identical', afterMode === first, sectionOf(afterMode, '# Runtime posture'))
  const preview = await promptOf()
  check('a composition without a prompt (a side question, the local warm) gets its own once-per-session text', sectionOf(preview, knapsack.MEMORY_AT_START_HEADING).includes('preview'))
  const afterPreview = await promptOf('fourth prompt')
  check('…and the next turn is still byte-identical to the first', afterPreview === first)
  check('the memory block was composed twice in all: once for the turns, once for the prompt-less road', composed === 2, composed)
  clearSystemPromptSections()
  const afterClear = await promptOf('fifth prompt')
  check('at the lawful prefix boundary (/compact) the posture block still states the boot mode, byte for byte', sectionOf(afterClear, '# Runtime posture') === sectionOf(first, '# Runtime posture'), sectionOf(afterClear, '# Runtime posture').slice(-120))
  check('…and the memory block recomposes once from the state as it stands then (the memory law the fold keeps)', sectionOf(afterClear, knapsack.MEMORY_AT_START_HEADING).includes('request:fifth prompt') && composed === 3, sectionOf(afterClear, knapsack.MEMORY_AT_START_HEADING))
  const afterClearAgain = await promptOf('sixth prompt')
  check('…and stands again for the turns that follow', afterClearAgain === afterClear && composed === 3)
  bootstrap.switchSession('00000000-0000-4000-8000-000000000052' as never, proofHome)
  clearSystemPromptSections()
  const fresh = await promptOf('a new session')
  check('a new session (/clear) composes the memory block afresh from its own first prompt', sectionOf(fresh, knapsack.MEMORY_AT_START_HEADING).includes('request:a new session') && fresh !== first, sectionOf(fresh, knapsack.MEMORY_AT_START_HEADING))
}

console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
