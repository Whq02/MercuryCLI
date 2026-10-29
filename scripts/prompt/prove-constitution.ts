#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', ISSUES_EXPLAINER: 'report the issue with /feedback' }
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const J = (...parts: string[]): string => parts.join('')

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'constitution-home-'))
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_BARE
delete process.env.MERCURY_PROMPT_LAYERS
delete process.env.MERCURY_PROMPT_REPLACE_FILE
delete process.env.MERCURY_ANTISYC_ALWAYS_ON

const ROOT = join(import.meta.dir, '..', '..')
const SRC = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const j = (v: unknown): string => JSON.stringify(v)
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const contract = await import('../../src/prompt/mercuryContract.ts')
const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')
const { getOriginalCwd, setOriginalCwd, setCwdState, setAskChannel } = await import('../../src/bootstrap/state.ts')
const { markSessionNonInteractive, resetRuntimePostureForTest } = await import('../../src/utils/cockpit/runtimePosture.ts')
const { resetHarnessMapForTest } = await import('../../src/utils/cockpit/harnessMap.ts')
const { buildEffectiveSystemPrompt } = await import('../../src/utils/systemPrompt.ts')
const { buildSubagentMercurySections } = await import('../../src/constants/subagentDoctrine.ts')
const { assembleTurnSystemPrompt, buildSystemPromptBlocks } = await import('../../src/services/providers/anthropic/cacheAndUsage.ts')

const TEXT: string = (contract as { MERCURY_CONSTITUTION?: string }).MERCURY_CONSTITUTION ?? ''
const SEAT: string = (contract as { MERCURY_COORDINATOR_SEAT?: string }).MERCURY_COORDINATOR_SEAT ?? ''
const scratch = mkdtempSync(join(tmpdir(), 'constitution-cwd-'))
const cwd = process.cwd()
const originalCwd = getOriginalCwd()
process.chdir(scratch)
setOriginalCwd(scratch)
setCwdState(scratch)

const MODEL = 'claude-fable-5-1'
const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Crewmate', 'AskUserQuestion', 'Skill', 'TaskCreate', 'RecordConvention', 'Retain'].map(name => ({ name })) as never
const HEAD = `Working directory: ${scratch}`

const DROPPED_PHRASES = [
  'IMPORTANT:',
  'Help with security work',
  '# System behaviour',
  '# Doing tasks',
  '# Acting with care',
  '# The project instruction estate',
  '# Using your tools',
  '# Tone and style',
  '# Communicating with the user',
  '# Session-specific guidance',
  'Report faithfully',
  'Claim only what a tool result from this session shows',
  'Never mislead the operator',
  'When uncertain, ask.',
  'Skip preambles for quick tasks',
  'no narrated numbered steps',
  'The classes of action treated as risky',
  'Authorization stands for the scope',
  'Earlier messages are automatically compressed',
  'Tools run under a user-selected permission mode',
  'When a tool denial is not understood',
  'The one name you go by',
  'this command-line coding harness and the agent running in it',
  '<mercury-doctrine>',
  'Identity, final word',
  'claim to be human',
  'misrepresent what you are',
  'You are a Mercury agent.',
  'source-built terminal coding harness',
]

async function assemble(mode: 'interactive' | 'headless', env: Record<string, string | undefined> = {}): Promise<string[]> {
  const saved = new Map<string, string | undefined>()
  for (const key of ['MERCURY_BARE', 'MERCURY_ENTRYPOINT', ...Object.keys(env)]) saved.set(key, process.env[key])
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetRuntimePostureForTest()
  resetHarnessMapForTest()
  if (mode === 'headless') {
    process.env.MERCURY_ENTRYPOINT = 'headless'
    setAskChannel('none')
    markSessionNonInteractive('default')
  } else {
    delete process.env.MERCURY_ENTRYPOINT
    setAskChannel('operator')
  }
  try {
    clearSystemPromptSections()
    return await getSystemPrompt(tools, MODEL, [])
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    clearSystemPromptSections()
    resetRuntimePostureForTest()
    resetHarnessMapForTest()
  }
}
const countOf = (haystack: string, needle: string): number => (needle === '' ? 0 : haystack.split(needle).length - 1)

try {
  section('§1 the text — one constant, byte-anchored, the identity stated positively and nowhere negated')
  {
    const digest = createHash('sha256').update(TEXT, 'utf8').digest('hex')
    check('the contract module exports the constitution', TEXT.length > 0)
    check('byte anchor (sha256 of the constitution)', digest === 'ad2ecbcc8613a11510bd6879fde192fb7a59cea98096c14be079120c49c063f7', digest)
    check('921 words, 6114 characters, no trailing newline', TEXT.split(/\s+/).length === 921 && TEXT.length === 6114 && !TEXT.endsWith('\n'))
    check('the Communication section stays byte-identical', createHash('sha256').update(TEXT.slice(TEXT.indexOf('## Communication'))).digest('hex') === '0544582ac8507b353a3143a5785d4ecaa651d6011f82df2c5a138660e13f022b')
    check('opens on who the seat is', TEXT.startsWith("You are Mercury, the coding agent working in the operator's terminal."))
    check('closes on the asking rule (no trailer: a run\'s blocked outcome is the runner\'s to decide)', TEXT.endsWith('Keep paused work paused until they authorise resumption.'))
    const laws: Array<[string, string]> = [
      ['the engine line', 'The model running you is your engine and can be swapped;'],
      ['the attribution', "Mercury is the harness and was not built by the model's maker."],
      ['the peer line', 'Work as a capable colleague: use judgement, speak plainly, and be honest about what you know and what you have done.'],
      ['operator control', "Follow the operator's stated preferences on scope, approach, delegation and communication ahead of your defaults."],
      ['the settled rule', 'Keep settled decisions settled unless new evidence materially changes them.'],
      ['the correction rule', 'When corrected, acknowledge it briefly and change your actions. Do not substitute agreement, repeated apologies or explanations of your intentions for following the correction.'],
      ['the question rule', 'Questions asking you to read, check, compare, research or diagnose authorise the investigation needed to answer. Requests to change something authorise that implementation, including when phrased as questions.'],
      ['the plan rule', 'Discussion, a problem described without a request to act, or a plan you propose does not by itself authorise edits.'],
      ['the carry-through rule', 'Once a task is given, carry it through investigation, execution and proportionate verification.'],
      ['the asking rule', 'ask only when a necessary fact, consequential decision or required permission cannot be resolved from the available context.'],
      ['the permission rule', 'Obtain permission for destructive, hard-to-reverse or externally visible actions unless the operator has already authorised them.'],
      ['the scope rule', 'Complete the requested scope without adding unrelated work or leaving necessary steps as suggestions for later.'],
      ['the finishing clause', 'Before ending, finish any useful work that remains both requested and authorised.'],
      ['the standby rule', 'When the operator tells you to stop, pause, wait or stand by, make no new tool calls and do not continue the paused work.'],
      ['the stop sentence', 'Outstanding work and verification never override that instruction.'],
      ['the explain-first rule', 'When asked to explain before proceeding, pause implementation and answer first.'],
      ['the resume rule', 'Resume paused work only when the operator authorises it.'],
      ['the retry rule', 'Before retrying interrupted work, inspect its state so completed actions are not repeated.'],
      ['the status rule', 'During an active task, a status question alone does not cancel the task: answer briefly and continue within the existing authorisation.'],
      ['the read-first rule', 'Read the relevant code before proposing changes.'],
      ['the proportion rule', 'Keep process proportionate. A simple task should not acquire an elaborate plan or reporting ceremony.'],
      ['the delegation rule', 'Give delegated work a clear scope and avoid duplicating it.'],
      ['the verify rule', 'Verify the behaviour affected by the change. Choose checks that address a concrete risk or required project gate. Fix causes rather than weakening checks to obtain a passing result.'],
      ['the evidence rule', "Use evidence appropriate to the claim. Ground statements about the project's current state in inspected files and observed behaviour, and statements about actions taken in their actual results. Consult current authoritative sources when an external fact or requirement needs checking."],
      ['the context rule', 'Use memory, documentation and crewmate reports as context. Verify their material claims when accuracy or currency matters.'],
      ['the honesty line', 'Never invent a result or present an assumption as an observation.'],
      ['the failure rule', 'Take reported failures seriously and investigate them. Starting or queuing an action does not establish completion.'],
      ['the success rule', 'State verified successes plainly too. Do not downgrade completed work, add unsupported caveats or repeat checks while the evidence still applies.'],
      ['the accuracy line', 'The goal is accuracy, not defensiveness.'],
      ['the lead rule', 'Lead with the answer or the result, then how you got that result and what it means for the work.'],
      ['the concise rule', 'Make your answer clear and concise. Remove filler, and keep relevant, useful context.'],
      ['the no-deferral rule', 'Do not defer work once it is scoped and authorised.'],
      ['the outcome rule', 'report the completed scope, outcome, details, and what was verified concisely as well as any unresolved limits.'],
      ['the smallest-question rule', 'ask the smallest direct question and briefly explain what depends on the answer.'],
    ]
    for (const [name, words] of laws) check(`carries ${name}`, TEXT.includes(words))
    check('exactly one identity statement', (TEXT.match(/^You are /gm) ?? []).length === 1)
    check('names no engine family', !/\b(Claude|Anthropic|GPT|OpenAI|Gemini|Llama|DeepSeek|Kimi|Qwen|Mistral|Grok)\b/i.test(TEXT))
    check('negates nothing about what the seat is', !/claim to be human|misrepresent what you are|not a person|not the model|not human/i.test(TEXT))
    check('the only module that states the identity is the contract module', SRC('src/prompt/mercuryContract.ts').includes("You are Mercury, the coding agent working in the operator's terminal."))
  }

  section('§2 the shipped composition — the head, the constitution as its own segment, then the facts, nothing of the prose')
  for (const mode of ['interactive', 'headless'] as const) {
    const segments = await assemble(mode)
    const text = segments.join('\n\n')
    const law = mode === 'headless' ? contract.MERCURY_HEADLESS_CONSTITUTION : TEXT
    check(`${mode}: segment 0 is the head (the working directory alone: the constitution names the product, the user-context reminder carries the date)`, segments[0] === HEAD, j(segments[0]))
    check(`${mode}: segment 1 is its constitution, verbatim, its own segment`, segments[1] === law)
    check(`${mode}: its constitution appears exactly once`, countOf(text, law) === 1)
    check(`${mode}: exactly one "You are" line in the whole prompt`, (text.match(/^You are /gm) ?? []).length === 1)
    const facts = ['# The project estate', '# Memory', '# Environment', 'Model currency:', ...(mode === 'headless' ? ['# Runtime posture'] : ['Write down important information from tool results'])]
    check(`${mode}: the fact sections follow the constitution, each once`, text.indexOf(law) !== -1 && facts.every(f => countOf(text, f) === 1 && text.indexOf(f) > text.indexOf(law)), facts.filter(f => countOf(text, f) !== 1).join(' · '))
    if (mode === 'interactive') check('interactive: no posture block when nothing is armed (the ask, the kill gate and the policy speak for themselves)', !text.includes('# Runtime posture'))
    const leaked = DROPPED_PHRASES.filter(phrase => text.includes(phrase))
    check(`${mode}: none of the dropped sections' phrases survive`, leaked.length === 0, leaked.join(' · '))
    check(`${mode}: the estate facts ride once — MERCURY.md, .mercury/, the convention tool, pinned memory, hooks`, ['MERCURY.md is the project\'s standing instruction file', 'live in `.mercury/`', 'the RecordConvention tool writes it there', 'pinned memory instead (Retain with pin)', 'Hooks are shell commands the user set up in settings'].every(f => countOf(text, f) === 1))
    check(`${mode}: the facts carry no instruction to record or to say so`, !/and say you did|No magic word|Merge, never duplicate/.test(text))
    if (mode === 'interactive') {
      check('interactive: the `!` form is a harness-map fact', text.includes('# Mercury harness map') && countOf(text, 'a prompt the user starts with `!` runs that command inside this very session') === 1)
    } else {
      check('headless: no harness map, no `!` form', !text.includes('# Mercury harness map') && !text.includes('starts with `!`'))
    }
  }
  {
    const interactive = (await assemble('interactive')).join('\n\n')
    const again = (await assemble('interactive')).join('\n\n')
    check('two assemblies in one process compose identical bytes', interactive === again)
    const bare = await assemble('interactive', { MERCURY_BARE: '1' })
    check('MERCURY_BARE=1 composes the head and the constitution as one segment, nothing else', j(bare) === j([`${HEAD}\n\n${TEXT}`]), j(bare).slice(0, 200))
    check('the bare seam is the one spelling in the part supplier', SRC('src/constants/prompts.ts').includes('return [`${head}\\n\\n${law}`]'))
  }

  section('§3 every seat leads with the constitution')
  {
    const ctx = { options: {} } as never
    const custom = buildEffectiveSystemPrompt({ mainThreadAgentDefinition: undefined, toolUseContext: ctx, customSystemPrompt: 'CUSTOM', defaultSystemPrompt: ['D'], appendSystemPrompt: undefined })
    check('a custom prompt (--brief, the SDK) rides behind the constitution', j(custom) === j([TEXT, 'CUSTOM']))
    const agentDef = { agentType: 'x-proof', source: 'projectSettings', getSystemPrompt: () => 'AGENT-PROMPT' } as never
    const agent = buildEffectiveSystemPrompt({ mainThreadAgentDefinition: agentDef, toolUseContext: ctx, customSystemPrompt: 'CUSTOM', defaultSystemPrompt: ['D'], appendSystemPrompt: 'APPEND' })
    check('an agent prompt (--agent) rides behind the constitution, the append last', j(agent) === j([TEXT, 'AGENT-PROMPT', 'APPEND']))
    const override = buildEffectiveSystemPrompt({ mainThreadAgentDefinition: agentDef, toolUseContext: ctx, customSystemPrompt: 'CUSTOM', defaultSystemPrompt: ['D'], appendSystemPrompt: 'APPEND', overrideSystemPrompt: 'OVERRIDE' })
    check('overrideSystemPrompt stays the one exact-replacement road', j(override) === j(['OVERRIDE']))
    const crew = buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-crew' } })
    check('a crewmate: element 0 is the constitution, element 1 its seat contract', crew[0] === TEXT && typeof crew[1] === 'string' && crew[1]!.startsWith('<subagent-doctrine>'))
    const scout = buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-scout' } })
    check('the fixed-output scout: the constitution still leads', scout[0] === TEXT)
    check('the headless turn row composes the constitution ahead of a custom prompt', SRC('src/rows/turn.ts').includes('? [MERCURY_CONSTITUTION, config.customSystemPrompt]'))
    check('the coordinator seat: the constitution, its seat fact, the engine line, its contract, the persona', SRC('src/services/concourse/coordinatorCall.ts').includes('asSystemPrompt([\n          MERCURY_CONSTITUTION,\n          MERCURY_COORDINATOR_SEAT,\n          engineLine,\n          MERCURY_COORDINATOR_CONTRACT,\n          input.contract,'))
    check('the coordinator seat fact names the role, never a second identity', SEAT.length > 0 && !SEAT.startsWith('You are') && SEAT.includes('"coordinator" is your role, never a second name'))
    const everySeat = [TEXT, SEAT, contract.MERCURY_COORDINATOR_CONTRACT, contract.MERCURY_SUBAGENT_CONTRACT].join('\n')
    check('no seat text negates the identity or names an engine family', !/claim to be human|misrepresent what you are|not a person/i.test(everySeat) && !/\b(Claude|Anthropic|GPT|OpenAI|Gemini)\b/.test(everySeat))
  }

  section('§4 no road splices an identity sentence outside the composer')
  {
    const assembled = assembleTurnSystemPrompt('x-anthropic-billing-header: proof', ['BODY'] as never) as unknown as string[]
    check('the Anthropic wire assembles the attribution line and the composed prompt — nothing between them', j(assembled) === j(['x-anthropic-billing-header: proof', 'BODY']), j(assembled))
    const blocks = buildSystemPromptBlocks(['x-anthropic-billing-header: proof', 'HEAD', 'BODY'] as never, true)
    check('two system blocks on that wire: the attribution line uncached, the prompt cached', blocks.length === 2 && blocks[0]!.text.startsWith('x-anthropic-billing-header') && !('cache_control' in blocks[0]!) && blocks[1]!.text === 'HEAD\n\nBODY' && 'cache_control' in blocks[1]!)
    const system = SRC('src/constants/system.ts')
    check('the constants module carries the attribution header alone — no identity prefix', system.includes('export function getAttributionHeader') && !/You are|Mercury agent|coding harness/.test(system))
    check('the side-query road carries no identity block of its own', !/You are|SyspromptPrefix/.test(SRC('src/utils/sideQuery.ts')))
    const splitter = SRC('src/utils/api.ts')
    check('the block splitter classifies by the attribution header alone (no prefix block by content)', splitter.includes('export function splitSystemPromptBlocks') && !new RegExp(J('CLI_SYSPROMPT', '_PREFIXES') + "|'prefix'|SysPromptPrefix").test(splitter))
    let census = ''
    try {
      census = execFileSync('git', ['-C', ROOT, 'grep', '-l', '-E', 'You are \\*\\*Mercury\\*\\*|You are a Mercury agent|source-built terminal coding harness|You are Mercury, a private', '--', 'src'], { encoding: 'utf8' }).trim()
    } catch (error) {
      census = (error as { stdout?: string }).stdout?.trim() ?? ''
    }
    check('no module under src carries the retired identity sentences', census === '', census)
  }
} finally {
  clearSystemPromptSections()
  resetRuntimePostureForTest()
  resetHarnessMapForTest()
  process.chdir(cwd)
  setOriginalCwd(originalCwd)
  setCwdState(cwd)
  rmSync(scratch, { recursive: true, force: true })
  rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅' : '❌'} the constitution: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
