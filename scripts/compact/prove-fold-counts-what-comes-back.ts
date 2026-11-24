#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'GOOGLE_API_KEY', 'MERCURY_COMPACT',
  'MERCURY_AUTO_COMPACT', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_SM_COMPACT', 'MERCURY_CONCOURSE_WORKER', 'MERCURY_PROJECT_INTEL',
]) {
  delete process.env[ambient]
}
const scratch = mkdtempSync(join(tmpdir(), 'fold-counts-what-comes-back-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail: string, change: string): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail} — change: ${change}`}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — prove-fold-counts-what-comes-back exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const FOLD = 'Write the running record of this conversation'
const SKILLS = '## Skills'
const WORKING_SET = '# Working set (task-scoped'
const APOLLO = '# Apollo Mode'
const COUNT = 'createFoldMeter in src/engine/compaction/fold/foldMeasure.ts must state the after size as what stands after the fold plus the rows the next turn sends again, on the scale the seated model reads the conversation in, and nothing the fold removed'
const RETURNS = 'the turn after a fold now sends this text again: add it to the rows withoutSkillsList in src/engine/compaction/fold/foldMeasure.ts leaves out of the count before the fold, so the after size counts it'

section('1 the built product, Apollo mode, a project with a working set, a provider that reports no usage: what the request after a fold carries')
{
  const { randomUUID } = await import('node:crypto')
  const { estimateContentTokens } = await import('../../src/engine/context-window/roughTokenEstimation.ts')
  const { recordToEntry } = await import('../../src/sessions/fabric/entryCodec.ts')
  const { historyLines } = await import('../../src/sessions/transcripts/historyParts.ts')
  const { transcriptFiles } = await import('../daemon/dupline-world.ts')
  const { liveFactsOf, withFixtureRunner } = await import('../lib/builtProduct.ts')
  type Turn = import('../lib/fixtureApi.ts').ScriptedTurn
  const runnerHome = join(scratch, 'runner-home')
  const session = randomUUID()
  const seen = { first: [] as string[], after: [] as string[], own: [] as string[], carried: 0, folded: false, receipt: '' }
  const notes = Array.from({ length: 700 }, (_, i) => `Note ${i + 1}: module ${(i * 7919) % 1000} changed and its ${(i * 31) % 97} checks pass.`).join(' ')
  const silent = { input_tokens: 0, output_tokens: 0 }
  const long: Turn = { kind: 'text', text: notes, usage: silent }
  const turns: Turn[] = [long, long, long, { kind: 'text', text: '<summary>The notes of the earlier turns are recorded and nothing is open.</summary>', whenBody: FOLD, usage: silent }, { kind: 'text', text: 'carried on', usage: silent }]
  type Wire = { messages: Array<{ role: string; content: unknown }> }
  const textsOf = (body: Wire): string[] => body.messages.flatMap(row => (typeof row.content === 'string' ? [row.content] : (row.content as Array<{ type?: string; text?: string }>).flatMap(part => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))))
  await withFixtureRunner(turns, async (runner, api) => {
    const cwd = (await liveFactsOf(runner)).workspace.cwd
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'pricing.js'), Array.from({ length: 40 }, (_, i) => `export function price_${i}(a, b) { return Math.round(a * b * 100) / 100 }`).join('\n') + '\n')
    const asks = ['fix the rounding in src/pricing.js', 'now check src/pricing.js once more', 'summarise what src/pricing.js exports']
    for (const [index, ask] of asks.entries()) {
      await runner.prompt(ask)
      await runner.waitFor(`turn ${index + 1}`, row => row.type === 'outcome' && row.turn === index + 1)
    }
    await runner.prompt('/compact')
    const folded = await runner.waitFor('the turn of /compact', row => row.type === 'outcome' && row.turn === 4)
    seen.receipt = String(folded.answer ?? (folded.error as { message?: string } | undefined)?.message ?? '')
    await runner.prompt('carry on with src/pricing.js')
    await runner.waitFor('the turn after the fold', row => row.type === 'outcome' && row.turn === 5)
    const sent = api.messageRequests().filter(request => !request.path.includes('count_tokens'))
    const foldAt = sent.findIndex(request => request.raw.includes(FOLD))
    const next = (sent[foldAt + 1]?.body ?? { messages: [] }) as Wire
    seen.first = textsOf((sent[0]?.body ?? { messages: [] }) as Wire)
    seen.after = textsOf(next)
    seen.own = seen.after.filter(text => text.startsWith('<local-command-caveat>') || text.startsWith('<command-message>') || text.startsWith('<local-command-stdout>') || text === 'carry on with src/pricing.js')
    seen.carried = estimateContentTokens(next.messages) - estimateContentTokens(seen.own)
    seen.folded = folded.status === 'completed' && foldAt > 0 && seen.receipt.startsWith('Compacted — folded ')
    await runner.stop()
  }, { argv: ['--session-id', session, '--mode', 'apollo'], env: { MERCURY_CONFIG_DIR: runnerHome, MERCURY_SESSION_KIND: 'oculus', MERCURY_TRUST_DIALOG_ACCEPTED: '1' } })
  const file = transcriptFiles(join(runnerHome, 'projects')).find(path => path.endsWith(`${session}.jsonl`))
  const entries = file === undefined ? [] : Array.from(historyLines(file), line => recordToEntry(JSON.parse(line.toString('utf8'))))
  const boundary = entries.find(row => row.type === 'system' && row.subtype === 'compact_boundary')
  const recorded = (boundary?.compactMetadata as { postTokens?: number } | undefined)?.postTokens
  const heads = (texts: string[]): string => JSON.stringify(texts.map(text => text.slice(0, 60)))
  check('the first request carries the working set, the Apollo pack and the skills list', seen.first.some(text => text.includes(WORKING_SET)) && seen.first.some(text => text.includes(APOLLO)) && seen.first.some(text => text.includes(SKILLS)), heads(seen.first), 'the fixture of this proof: the project folder, --mode apollo and the Skill tool must make the first turn announce all three')
  check('/compact folds', seen.folded, seen.receipt, COUNT)
  check('the request after the fold carries the skills list again, once', seen.after.filter(text => text.includes(SKILLS)).length === 1, heads(seen.after), RETURNS)
  check('it does not carry the working-set text again', !seen.after.some(text => text.includes(WORKING_SET)), heads(seen.after), RETURNS)
  check('it does not carry the Apollo pack again', !seen.after.some(text => text.includes(APOLLO)), heads(seen.after), RETURNS)
  check("the after size on the fold's record is what that request carries, the command's own rows and the new prompt apart, to 40 tokens", seen.own.length === 4 && recorded !== undefined && Math.abs(seen.carried - recorded) <= 40, JSON.stringify({ receipt: seen.receipt, recorded, carried: seen.carried, own: seen.own.length }), COUNT)
}

const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createAttachmentMessage } = await import('../../src/engine/attachment-shapes/attachmentMessage.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { contextFill } = await import('../../src/engine/context-window/contextTokenCount.ts')
const { primeOpenaiCatalogue } = await import('../../src/models/roads/openai/openaiCatalogue.ts')
const { buildPostFoldMessages } = await import('../../src/engine/compaction/foldConversation.ts')
const { estimateContextTokens } = await import('../../src/engine/compaction/pruneToolResults.ts')
const { call } = await import('../../src/commands/compact/compact.ts')

const SOURCE = 'claude-opus-4-8'
const SEATED = 'gpt-5.6-sol'
if (!primeOpenaiCatalogue({
  sourceKind: 'api-key',
  models: [{ id: SEATED, displayName: 'GPT-5.6 Sol', supportedReasoningEfforts: ['low', 'high'], reasoningEffortsStated: true, defaultReasoningEffort: 'low', visibility: 'list', supportedInApi: true, priority: 1, contextWindow: 65_536, inputModalities: ['text', 'image'] }],
  fetchedAtMs: Date.now() + 1,
})) throw new Error('the catalogue prime was refused')

type AnyMsg = Record<string, unknown> & { type?: string }
type Folded = { type: string; displayText?: string; compactionResult: Parameters<typeof buildPostFoldMessages>[0] }

function makeContext(model: string, messages: AnyMsg[]): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: model, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (update: (prev: never) => never): void => {
      appState = update(appState as never) as unknown as Record<string, unknown>
    },
    messages,
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

const listing = `The skills this session offers, run by name through the Skill tool:\n\n${Array.from({ length: 30 }, (_, i) => `- skill-${i}: Use when the task names module ${i}; not for anything else in the project.`).join('\n')}`
const capsule = (withSkills: boolean): AnyMsg => createAttachmentMessage({
  type: 'context_capsule',
  markdown: `# Working set (task-scoped, generation a422f947f665)\n${Array.from({ length: 12 }, (_, i) => `- src/module-${i}.js — named by the task`).join('\n')}`,
  digest: 'a422f947f665',
  refs: [],
  delta: null,
  sections: withSkills ? [{ name: 'Skills', kinds: ['skill_listing'], content: [{ type: 'text', text: listing }] }] : [],
} as never) as AnyMsg
const pack = (): AnyMsg => createAttachmentMessage({ type: 'mode_pack', mode: 'apollo', text: `# Apollo Mode — the pre-flight interview\n\n${'Ask before you build, one question at a time. '.repeat(60)}` } as never) as AnyMsg

function noteText(n: number): string {
  let out = ''
  for (let line = 0; out.length < 40_000; line++) out += `Note ${n}, section ${line} records a module boundary: ${(n * 7919 + line * 104729).toString(16).padStart(64, 'a')}. Check the indexed observations before changing it.\n`
  return out
}

function sixNotes(withSkills: boolean, silent = false): AnyMsg[] {
  const rows: AnyMsg[] = [capsule(withSkills), pack()]
  let sent = 31_900
  for (let n = 1; n <= 6; n++) {
    rows.push(createUserMessage({ content: `write design note ${n}` }) as AnyMsg)
    const text = noteText(n)
    sent += 6
    rows.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`,
      timestamp: new Date().toISOString(),
      requestId: `req_${n}`,
      message: {
        id: `msg_${n}`,
        type: 'message',
        role: 'assistant',
        model: SOURCE,
        content: [...(silent ? [{ type: 'thinking', thinking: 'weighing each module boundary before writing the note. '.repeat(80), signature: 'sig' }] : []), { type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: silent ? 0 : sent, output_tokens: silent ? 0 : Math.round(text.length / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
    sent += Math.round(text.length / 4)
  }
  return rows
}

async function fold(seated: string, silent = false): Promise<{ messages: AnyMsg[]; folded: Folded | undefined; threw: string }> {
  fixture.script([{ text: 'SUMMARY BY OPUS: the design notes were written one by one and the operator asked to carry on from them.' }, { text: 'never reached' }])
  const messages = sixNotes(true, silent)
  try {
    return { messages, folded: (await call('', makeContext(seated, messages) as never)) as Folded, threw: '' }
  } catch (error) {
    return { messages, folded: undefined, threw: error instanceof Error ? error.message : String(error) }
  }
}
const standingAfter = (folded: Folded | undefined, model: string): number => (folded === undefined ? Number.NaN : estimateContextTokens(buildPostFoldMessages(folded.compactionResult) as never, model))

section('2 the measure: a conversation that holds a working set with a skills list and an Apollo pack, folded on a model that has no measure of it and on one that has')
{
  const skills = estimateContextTokens(sixNotes(true) as never, SEATED) - estimateContextTokens(sixNotes(false) as never, SEATED)
  check('the fixture holds a skills list of some size', skills > 500, String(skills), 'the fixture of this proof: the capsule row must carry a Skills section')
  const switched = await fold(SEATED)
  check('after a switch: the fold lands', switched.folded?.type === 'compact', switched.threw, COUNT)
  check("after a switch: the after size is the seated model's count of what stands after the fold plus the skills list that comes back, and nothing else", switched.folded?.compactionResult.truePostCompactTokenCount === standingAfter(switched.folded, SEATED) + skills, JSON.stringify({ after: switched.folded?.compactionResult.truePostCompactTokenCount, standing: standingAfter(switched.folded, SEATED), skills }), COUNT)
  const unmeasured = await fold(SOURCE, true)
  check('a provider that reports no usage, the replies holding thinking: the fold lands', unmeasured.folded?.type === 'compact' && contextFill(unmeasured.messages as never, SOURCE).source === 'estimate', unmeasured.threw, COUNT)
  check('a provider that reports no usage: the after size is what stands after the fold plus the skills list, without the thinking the fold removed', unmeasured.folded?.compactionResult.truePostCompactTokenCount === standingAfter(unmeasured.folded, SOURCE) + skills, JSON.stringify({ after: unmeasured.folded?.compactionResult.truePostCompactTokenCount, standing: standingAfter(unmeasured.folded, SOURCE), skills }), COUNT)
  const measured = await fold(SOURCE)
  const before = contextFill(measured.messages as never).tokens
  const saved = estimateContextTokens(sixNotes(false) as never, SOURCE) - standingAfter(measured.folded, SOURCE)
  check('a measured conversation, no switch: the after size is the measured before figure less what the fold saved, the skills list not among the savings', measured.folded?.compactionResult.truePostCompactTokenCount === before - saved, JSON.stringify({ after: measured.folded?.compactionResult.truePostCompactTokenCount, before, saved, threw: measured.threw }), COUNT)
}

await fixture.close()
clearTimeout(guard)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
