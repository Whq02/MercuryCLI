#!/usr/bin/env bun
// gate-watch: src/constants/prompts.ts src/utils/cockpit/runtimePosture.ts src/utils/cockpit/harnessMap.ts
// gate-watch: src/mneme/mnemeFrontPage.ts src/services/agentResults/contracts.ts src/constants/subagentDoctrine.ts
// gate-watch: scripts/prompt/fixtures/prompt-ablation/**
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sentences-pinned-home-'))
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_BARE
delete process.env.MERCURY_PROMPT_LAYERS
delete process.env.MERCURY_PROMPT_REPLACE_FILE
delete process.env.MERCURY_ANTISYC_ALWAYS_ON
delete process.env.MERCURY_RUNTIME_POSTURE
delete process.env.MERCURY_HARNESS_MAP
delete process.env.MERCURY_CHANGE_RECEIPTS

const ROOT = join(import.meta.dir, '..', '..')
const FIXTURES = join(import.meta.dir, 'fixtures', 'prompt-ablation')
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
function tsv(name: string): Array<Record<string, string>> {
  const [head, ...rows] = readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(line => line.length > 0)
  const keys = head!.split('\t')
  return rows.map(row => Object.fromEntries(row.split('\t').map((cell, i) => [keys[i]!, cell])))
}

const { getSystemPrompt, enhanceSystemPromptWithEnvDetails } = await import('../../src/constants/prompts.ts')
const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')
const { getOriginalCwd, setOriginalCwd, setCwdState, setAskChannel } = await import('../../src/bootstrap/state.ts')
const { markSessionNonInteractive, resetRuntimePostureForTest } = await import('../../src/utils/cockpit/runtimePosture.ts')
const { resetHarnessMapForTest } = await import('../../src/utils/cockpit/harnessMap.ts')
const { getLocalISODate } = await import('../../src/constants/common.ts')
const { buildSubagentMercurySections } = await import('../../src/constants/subagentDoctrine.ts')
const { MERCURY_CREW_AGENT } = await import('../../src/tools/AgentTool/built-in/mercuryCrewAgent.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { retainItems } = await import('../../src/mneme/memoryVerbs.ts')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
const { renderFrontPage } = await import('../../src/mneme/mnemeFrontPage.ts')

const scratch = mkdtempSync(join(tmpdir(), 'sentences-pinned-cwd-'))
const cwd = process.cwd()
const originalCwd = getOriginalCwd()
process.chdir(scratch)
setOriginalCwd(scratch)
setCwdState(scratch)

const MODEL = 'claude-fable-5-1'
const TOOL_NAMES = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Crewmate', 'AskUserQuestion', 'Skill', 'RecordConvention', 'Retain', 'Recall', 'Correct', 'ToolSearch']
const tools = TOOL_NAMES.map(name => ({ name })) as never
const M026 = 'The index below names each topic; Recall searches the pages (query) or reads one whole (read:"doc:<slug>").'

async function assemble(mode: 'interactive' | 'headless'): Promise<string> {
  resetRuntimePostureForTest()
  resetHarnessMapForTest()
  clearSystemPromptSections()
  if (mode === 'headless') {
    process.env.MERCURY_ENTRYPOINT = 'headless'
    setAskChannel('none')
    markSessionNonInteractive('default')
  } else {
    delete process.env.MERCURY_ENTRYPOINT
    setAskChannel('operator')
  }
  try {
    return (await getSystemPrompt(tools, MODEL, [])).join('\n\n')
  } finally {
    clearSystemPromptSections()
    resetRuntimePostureForTest()
    resetHarnessMapForTest()
    delete process.env.MERCURY_ENTRYPOINT
    setAskChannel('operator')
  }
}
async function crewmate(): Promise<string> {
  resetRuntimePostureForTest()
  const doctrine = buildSubagentMercurySections({ agentDefinition: MERCURY_CREW_AGENT, toolNames: new Set(TOOL_NAMES), seat: 'a crewmate' })
  const prompt = await enhanceSystemPromptWithEnvDetails([...doctrine, MERCURY_CREW_AGENT.getSystemPrompt()], MODEL, undefined, 'agent-sentences-pinned')
  return prompt.join('\n\n')
}
const fill = (sentence: string): string => sentence.split('<project>').join(scratch).split('<date>').join(getLocalISODate())

try {
  section('§1 the one sentence the replay reached stays: the memory index sentence rides every seat once the library holds a fact')
  const library = mnemeLibraryDir()
  retainItems([{ content: 'the proof home holds one fact so the index renders', topic: 'proof' }], { session: 'sentences-pinned' }, library)
  const landed = maybeConsolidate({ force: true, dir: library, now: new Date('2026-10-16T12:00:00.000Z') })
  check('the scratch library holds one consolidated fact', landed.consolidated && landed.entries === 1, landed.reason)
  const seats: Record<string, string> = { main: await assemble('interactive'), headless: await assemble('headless'), crewmate: await crewmate() }
  for (const [seat, text] of Object.entries(seats)) {
    check(`${seat}: the memory index sentence is present, verbatim, once`, text.split(M026).length === 2, text.includes('# Memory') ? 'the memory page rides without the sentence' : 'no memory page in the render')
  }
  check('the sentence is the front page\'s own text (one owner)', readFileSync(join(ROOT, 'src/mneme/mnemeFrontPage.ts'), 'utf8').includes(M026))
  const pinsOnly = renderFrontPage({ dir: library, topics: [], archives: [], pins: [{ seq: 1, at: '2026-10-16T12:00:00.000Z' }], usage: {}, now: new Date('2026-10-16T12:00:00.000Z') }).text
  check('a pins-only library (pins, no topics, no archives) renders the sentence and its referent: the ## Index heading, the empty-index line beneath it', pinsOnly.includes(M026) && pinsOnly.includes('\n## Index\n(nothing saved yet — memory is written only when the user asks for something to be remembered)\n'), pinsOnly)

  section('§2 every sentence the study cut is absent from the seats it rode in')
  const rows = tsv('cut-rows.tsv')
  check('the fixture names the twenty cut rows', rows.length === 20 && rows.every(r => r.id && r.seats && r.sentence && r.carrier), j(rows.map(r => r.id)))
  for (const row of rows) {
    const sentence = fill(row.sentence!)
    const present = row.seats!.split(' ').filter(seat => seats[seat]!.includes(sentence))
    check(`${row.id} is absent from ${row.seats} (carrier: ${row.carrier})`, present.length === 0, `still rides the ${present.join(' and ')} seat`)
  }

  section('§3 the source census: no module under src spells a cut sentence')
  for (const row of rows) {
    if (!row.census) continue
    let hits = ''
    try {
      hits = execFileSync('git', ['-C', ROOT, 'grep', '-l', '-F', row.census, '--', 'src'], { encoding: 'utf8' }).trim()
    } catch (error) {
      hits = (error as { stdout?: string }).stdout?.trim() ?? ''
    }
    check(`${row.id}: no source file carries ${j(row.census)}`, hits === '', hits.split('\n').join(' · '))
  }

  section('§4 the replay fixture: the flip is a recorded fact, read, never re-run')
  const flips = tsv('replay-flip.tsv')
  const questions = tsv('questions.tsv')
  check('two closed questions, one per turn, each judged by a grep', questions.length === 2 && questions.every(q => q.judge === 'grep' && q.grep_yes) && j(questions.map(q => q.turn)) === j(['T05', 'T10']))
  check('four recorded replies: the whole prompt and the one-row confirm arm, per turn', flips.length === 4 && j(flips.map(f => `${f.turn}.${f.arm}`)) === j(['T05.A0', 'T05.CT05-A2', 'T10.A0', 'T10.CT10-A2']))
  for (const turn of ['T05', 'T10']) {
    const question = questions.find(q => q.turn === turn)!
    const whole = flips.find(f => f.turn === turn && f.arm === 'A0')!
    const confirm = flips.find(f => f.turn === turn && f.arm !== 'A0')!
    const re = new RegExp(question.grep_yes!, 'i')
    check(`${turn}: the fixture's pattern is the question's judge`, whole.pattern === question.grep_yes && confirm.pattern === question.grep_yes)
    check(`${turn}: the whole-prompt arm removed no row and the judge matched nothing in it`, whole.rows_removed === '' && whole.matched_excerpt === '' && whole.answer === 'no')
    check(`${turn}: with M026 alone removed the judged answer differs from the whole-prompt answer, and the recorded excerpt is what the judge matched`, confirm.rows_removed === 'M026' && confirm.answer !== whole.answer && confirm.answer === 'yes' && re.test(confirm.matched_excerpt!), j(confirm.matched_excerpt))
    for (const f of [whole, confirm]) check(`${turn}.${f.arm}: the recorded reply is pinned by digest and size`, /^[0-9a-f]{64}$/.test(f.reply_sha256!) && Number(f.reply_bytes) > 0)
  }
  const t05 = questions.find(q => q.turn === 'T05')!
  check('T05: the recorded whole-prompt answer is the expected one (no stale plan adopted); the study\'s resamples found that baseline itself unstable, so the pair carries no signal of its own', t05.expected_A0 === 'no' && flips.find(f => f.turn === 'T05' && f.arm === 'A0')!.answer === 'no')
  const t10 = questions.find(q => q.turn === 'T10')!
  check('T10: the recorded whole-prompt answer differs from the expected one (its reply grades its claims in words the grep does not match); the study\'s resamples held the one-row difference, 3 of 4 against 0 of 5', t10.expected_A0 === 'yes' && flips.find(f => f.turn === 'T10' && f.arm === 'A0')!.answer === 'no')
  const readme = readFileSync(join(FIXTURES, 'README.md'), 'utf8')
  check('the README names the study and the door (thinking off)', readme.includes('prompt-ablation study') && readme.includes('thinking off') && readme.includes('M026'))
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

console.log(`\n${failures === 0 ? '✅' : '❌'} behaviour sentences pinned: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
