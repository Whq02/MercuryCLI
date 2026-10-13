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
const { getSessionStartDate } = await import('../../src/constants/common.ts')
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
const HEAD = `Mercury — a private terminal software-development harness.\nWorking directory: ${scratch}\nSession date: ${getSessionStartDate()}`

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
    check('byte anchor (sha256 of the constitution)', digest === 'c6f74b3efbac0a1183dbd80103db0f19ab318a7a47ae8fea7590e87fdb711e29', digest)
    check('186 words, 1212 characters, no trailing newline (the owner\'s .34 text)', TEXT.split(/\s+/).length === 186 && TEXT.length === 1212 && !TEXT.endsWith('\n'))
    check('opens on who the seat is', TEXT.startsWith('You are Mercury, an autonomous command-line interface and agent.'))
    check('closes on the note rule', TEXT.endsWith('note summarizing\nessential progress, context, and next steps.'))
    const laws: Array<[string, string]> = [
      ['the engine line', 'Your\nunderlying AI model is your engine.'],
      ['the attribution', 'Mercury was not built by the maker of the model it runs'],
      ['the developer rule', 'Never claim to be built by the developer.'],
      ['read the room', 'Prioritize your\noperator and read the room'],
      ['the preference rule', 'operator preferences over generic defaults'],
      ['the honesty line', 'Never mislead the\noperator; explain what happened plainly and without jargon.'],
      ['the opening rule', 'Start with findings or intended actions.'],
      ['the outcome rule', 'state the\noutcome first, followed by relevant details and a single-line verification\nnote.'],
      ['the assumption rule', 'Act on sufficient information while stating assumptions'],
      ['the stop sentence', 'pausing only\nfor destructive actions, major scope changes, or required operator input.'],
      ['the evidence rule', 'Base\nclaims strictly on tool outputs and state what remains unverified'],
      ['the finishing clause', 'execute planned work immediately before claiming your turn is\nover.'],
      ['the idle rule', 'Conclude turns when work settles or when instructed to idle, standby, or\nexplain, without delays.'],
      ['the note rule', 'At session end, save a 1–2 sentence note summarizing\nessential progress, context, and next steps.'],
    ]
    for (const [name, words] of laws) check(`carries ${name}`, TEXT.includes(words))
    check('exactly one identity statement', (TEXT.match(/^You are /gm) ?? []).length === 1)
    check('names no engine family', !/\b(Claude|Anthropic|GPT|OpenAI|Gemini|Llama|DeepSeek|Kimi|Qwen|Mistral|Grok)\b/i.test(TEXT))
    check('negates nothing about what the seat is', !/claim to be human|misrepresent what you are|not a person|not the model|not human/i.test(TEXT))
    check('the only module that states the identity is the contract module', SRC('src/prompt/mercuryContract.ts').includes('You are Mercury, an autonomous command-line interface and agent.'))
  }

  section('§2 the shipped composition — the head, the constitution as its own segment, then the facts, nothing of the prose')
  for (const mode of ['interactive', 'headless'] as const) {
    const segments = await assemble(mode)
    const text = segments.join('\n\n')
    check(`${mode}: segment 0 is the head (the product line, the working directory, the session date)`, segments[0] === HEAD, j(segments[0]))
    check(`${mode}: segment 1 is the constitution, verbatim, its own segment`, segments[1] === TEXT)
    check(`${mode}: the constitution appears exactly once`, countOf(text, TEXT) === 1)
    check(`${mode}: exactly one "You are" line in the whole prompt`, (text.match(/^You are /gm) ?? []).length === 1)
    const facts = ['# The project estate', '# Memory', '# Environment', 'Model currency:', 'Write down important information from tool results', '# Runtime posture', '# Autonomous runs']
    check(`${mode}: the fact sections follow the constitution, each once`, text.indexOf(TEXT) !== -1 && facts.every(f => countOf(text, f) === 1 && text.indexOf(f) > text.indexOf(TEXT)), facts.filter(f => countOf(text, f) !== 1).join(' · '))
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
