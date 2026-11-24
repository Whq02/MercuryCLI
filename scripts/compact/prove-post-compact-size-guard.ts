#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'post-compact-guard-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'post-compact-guard-daemon-'))
for (const k of [
  'MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE',
  'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_TIME_BASED_MC', 'NODE_ENV',
  'MERCURY_MODEL', 'ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN',
]) {
  delete process.env[k]
}
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

const { turnDoorEvents } = await import(join(SRC, 'engine/turnDoor.ts'))
const { legacyYieldsOf } = await import(join(SRC, 'engine/loop/project-legacy.ts'))
const bootstrap = await import(join(SRC, 'boot/process-state/processState.ts'))
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import(join(SRC, 'platform/config/globalConfig.ts'))
enableConfigs()
const { getDefaultAppState } = await import(join(SRC, 'screen/app-state/AppStateStore.ts'))
const { createAssistantMessage, createUserMessage } = await import(join(SRC, 'engine/messages/messages.ts'))
const { createFoldBoundaryMessage } = await import(join(SRC, 'engine/message-shapes/systemMessages.ts'))
const { createAttachmentMessage } = await import(join(SRC, 'engine/attachments/turnAttachments.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(SRC, 'platform/files/fileStateCache.ts'))
const { getBlockingLimit } = await import(join(SRC, 'engine/compaction/autoFold.ts'))
const micro = await import(join(SRC, 'engine/compaction/pruneToolResults.ts'))
const { roughTokenCountEstimationForMessages } = await import(join(SRC, 'models/facts/tokenEstimation.ts'))
const compactMod = await import(join(SRC, 'engine/compaction/foldConversation.ts'))

type AnyMsg = Record<string, unknown> & { type?: string }
type AnyEvent = Record<string, unknown> & { kind: string }
type Fit = { result: { attachments: AnyMsg[]; boundaryMarker: AnyMsg; summaryMessages: AnyMsg[] }; estimate: number; shed: string[] }

const MODEL = 'claude-opus-4-8'
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
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — post-compact size guard prover exceeded 180s; the G5 drive of turnDoorEvents (src/engine/loop/turn/makeRequest.ts) probably never reached a terminal, so look there for a wait that never ends')
  process.exit(1)
}, 180_000)
guard.unref?.()

const estimateContext: ((m: unknown[]) => number) | undefined = typeof micro.estimateContextTokens === 'function' ? micro.estimateContextTokens : undefined
const fit: ((r: unknown, t: number) => Fit) | undefined = typeof compactMod.fitPostFoldUnderThreshold === 'function' ? compactMod.fitPostFoldUnderThreshold : undefined
const buildPostFoldMessages = compactMod.buildPostFoldMessages as (r: unknown) => unknown[]

const fileAttachment = (name: string, chars: number): AnyMsg =>
  createAttachmentMessage({
    type: 'file',
    filename: `/rig/${name}`,
    displayPath: name,
    content: { type: 'text', file: { filePath: `/rig/${name}`, content: 'x'.repeat(chars), numLines: 1, startLine: 1, totalLines: 1 } },
  } as never) as unknown as AnyMsg
const skillsAttachment = (chars: number): AnyMsg =>
  createAttachmentMessage({ type: 'invoked_skills', skills: [{ name: 'rig-skill', path: '/rig/SKILL.md', content: 's'.repeat(chars) }] } as never) as unknown as AnyMsg

function rigResult(attachments: AnyMsg[]): Record<string, unknown> {
  return {
    boundaryMarker: createFoldBoundaryMessage('auto', 150_000),
    summaryMessages: [createUserMessage({ content: `RIG SUMMARY ${'of the folded history. '.repeat(20)}`, isCompactSummary: true, isVisibleInTranscriptOnly: true })],
    attachments,
    hookResults: [],
    preFoldTokenCount: 150_000,
    postFoldTokenCount: 0,
    foldUsage: undefined,
  }
}
const attachmentNames = (r: { attachments: AnyMsg[] }): string[] =>
  r.attachments.map(a => {
    const att = a.attachment as { type: string; filename?: string }
    return att.type === 'file' ? `file ${att.filename}` : att.type
  })

section('G0 the whole-context estimator counts what the round estimator skips')
{
  const summary = createUserMessage({ content: 'a compact summary '.repeat(200), isCompactSummary: true })
  const attachment = fileAttachment('a.txt', 4_000)
  const boundary = createFoldBoundaryMessage('auto', 10)
  const roundEstimate = micro.estimateMessageTokens([summary, attachment, boundary] as never)
  check('the round estimator reads the summary + attachment + boundary as zero (why the guard needs its own)', roundEstimate === 0, `${roundEstimate}; estimateMessageTokens in src/engine/compaction/pruneToolResults.ts now counts string, attachment or system rows, so the guard premise changed: confirm that was intended, then update this check, or restore the skip`)
  check('estimateContextTokens exists', estimateContext !== undefined, 'export estimateContextTokens as a function from src/engine/compaction/pruneToolResults.ts')
  if (estimateContext !== undefined) {
    check('a string-content summary weighs', estimateContext([summary]) > 500, `${String(estimateContext([summary]))}; estimateContextTokens in src/engine/compaction/pruneToolResults.ts must count a string-content user message`)
    check('fold 46ao: an attachment weighs its normalized content through the shared estimator', estimateContext([attachment]) > 0 && estimateContext([attachment]) === roughTokenCountEstimationForMessages([attachment]), `${String(estimateContext([attachment]))}; estimateContextTokens in src/engine/compaction/pruneToolResults.ts must return what roughTokenCountEstimationForMessages (src/models/facts/tokenEstimation.ts) returns for an attachment row`)
    check('a system row weighs its content line', estimateContext([boundary]) > 0 && estimateContext([boundary]) < 50, `${String(estimateContext([boundary]))}; estimateContextTokens in src/engine/compaction/pruneToolResults.ts must weigh a system row by its one content line only`)
    check('fold 46ao: a block-array row counts its text once, without the round estimator headroom', estimateContext([createAssistantMessage({ content: 'hello '.repeat(100) })]) === 150, `got ${estimateContext([createAssistantMessage({ content: 'hello '.repeat(100) })])}, wanted 150; estimateContextTokens in src/engine/compaction/pruneToolResults.ts must count block text once, with no 4/3 headroom`)
    check('a progress row weighs nothing', estimateContext([{ type: 'progress', uuid: 'p', timestamp: 't', data: { big: 'z'.repeat(10_000) } }]) === 0, 'estimateContextTokens in src/engine/compaction/pruneToolResults.ts must skip progress rows')
  }
}

section('G1 the fit sheds restored files largest-first, stops as soon as it fits, keeps order')
{
  check('fitPostFoldUnderThreshold exists', fit !== undefined, 'export fitPostFoldUnderThreshold from src/engine/compaction/foldConversation.ts (defined in src/engine/compaction/fold/foldAttachments.ts)')
  if (fit !== undefined && estimateContext !== undefined) {
    const A = fileAttachment('A.txt', 4_000)
    const B = fileAttachment('B.txt', 1_200)
    const C = fileAttachment('C.txt', 2_400)
    const S = skillsAttachment(2_000)
    const result = rigResult([A, B, C, S])
    const afterA = estimateContext(buildPostFoldMessages(rigResult([B, C, S])))
    const afterAC = estimateContext(buildPostFoldMessages(rigResult([B, S])))
    const threshold = afterAC + 1
    check('the fixture band is real (A alone is not enough)', afterA >= threshold, `${afterA} vs ${threshold}; the fixture sizes in G1 no longer give a band where shedding A alone is not enough, so resize the files in this script or check how estimateContextTokens weighs attachments`)
    const out = fit(result, threshold)
    check('two files shed, the largest first', out.shed.length === 2 && out.shed[0] === 'file /rig/A.txt' && out.shed[1] === 'file /rig/C.txt', `${out.shed.join(' | ')}; fitPostFoldUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must shed files largest-first and stop once under the threshold`)
    check('the estimate is under the threshold', out.estimate < threshold, `${out.estimate} vs ${threshold}; fitPostFoldUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must return an estimate under the threshold once it has shed enough`)
    check('the estimate is the whole-context estimate of the fitted result', out.estimate === estimateContext(buildPostFoldMessages(out.result)), `estimate=${out.estimate}; fitPostFoldUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must return the estimateContextTokens figure of buildPostFoldMessages (src/engine/compaction/fold/foldResult.ts) over the fitted result`)
    check('the survivors keep their order: B, skills', attachmentNames(out.result).join(',') === 'file /rig/B.txt,invoked_skills', `${attachmentNames(out.result).join(',')}; fitPostFoldUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must keep the surviving attachments in their original order`)
    check('the boundary and the summary are untouched', out.result.boundaryMarker === result.boundaryMarker && out.result.summaryMessages === result.summaryMessages, 'fitPostFoldUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must shed attachments only and pass boundaryMarker and summaryMessages through as the same objects')
  }
}

section('G2 shedding order across classes; an irreducible core reports over')
{
  if (fit !== undefined && estimateContext !== undefined) {
    const A = fileAttachment('A.txt', 4_000)
    const B = fileAttachment('B.txt', 1_200)
    const S = skillsAttachment(2_000)
    const result = rigResult([S, B, A])
    const core = estimateContext(buildPostFoldMessages(rigResult([])))
    const out = fit(result, core)
    check('everything sheddable goes: files largest-first, then skills', out.shed.join(',') === 'file /rig/A.txt,file /rig/B.txt,invoked_skills', `${out.shed.join(',')}; fitPostFoldUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must shed files largest-first and then the skills attachment`)
    check('the fit reports over (the caller refuses)', out.estimate >= core, `${out.estimate} vs ${core}; fitPostFoldUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must report an estimate at or above the core when nothing more can be shed, not an invented smaller one`)
    check('the core rows stand', out.result.attachments.length === 0 && out.result.summaryMessages.length === 1, `attachments=${out.result.attachments.length} summaries=${out.result.summaryMessages.length}; fitPostFoldUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must never drop the summary or the boundary`)
  }
}

section('G3 already under the threshold: identity')
{
  if (fit !== undefined && estimateContext !== undefined) {
    const result = rigResult([fileAttachment('A.txt', 4_000), skillsAttachment(500)])
    const total = estimateContext(buildPostFoldMessages(result))
    const out = fit(result, total + 1)
    check('nothing shed', out.shed.length === 0, `shed ${out.shed.join(',')}; fitPostFoldUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must shed nothing when the estimate is already under the threshold`)
    check('the same result object', out.result === result, 'fitPostFoldUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must return the input result itself when nothing is shed')
    check('the estimate is the total', out.estimate === total, `estimate=${out.estimate} total=${total}; fitPostFoldUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must return the whole-context estimate when nothing is shed`)
  }
}

section('G5 the turn machine: an over-limit fold never exempts the iteration')
function makeTool(name: string): never {
  return {
    name,
    async description() {
      return 'rig tool'
    },
    async prompt() {
      return 'rig tool'
    },
    inputSchema: z.object({ text: z.string().optional() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    call: async (input: Record<string, unknown>) => ({ data: `echo:${String(input?.text ?? '')}` }),
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}
const allowAll = async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never
function makeCtx(): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [makeTool('EchoTool')],
      engineModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}
function foldResult(truePostFoldTokenCount: number): Record<string, unknown> {
  return {
    wasFolded: true,
    foldResult: {
      boundaryMarker: createFoldBoundaryMessage('auto', 900),
      summaryMessages: [createUserMessage({ content: 'RIG SUMMARY of the folded history', isCompactSummary: true })],
      attachments: [],
      hookResults: [],
      preFoldTokenCount: 900,
      postFoldTokenCount: 120,
      truePostFoldTokenCount,
      foldUsage: undefined,
    },
  }
}
async function drive(fold: Record<string, unknown>): Promise<{ calls: number; terminal: Record<string, unknown>; yields: AnyMsg[] }> {
  let calls = 0
  async function* callModel(): AsyncGenerator<never, void> {
    calls++
    yield createAssistantMessage({ content: 'rig answer' }) as never
  }
  const compactCalls: number[] = []
  const autocompact = async () => {
    compactCalls.push(1)
    return compactCalls.length === 1 ? fold : { wasFolded: false }
  }
  const gen = turnDoorEvents({
    messages: [createUserMessage({ content: 'earlier ask' }), createAssistantMessage({ content: 'earlier reply' }), createUserMessage({ content: 'operator ask' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: makeCtx() as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autoFold: autocompact as never,
      uuid: (() => {
        let n = 0
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      })(),
    } as never,
  })
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    for (const y of legacyYieldsOf(r.value as never)) yields.push(y as AnyMsg)
    r = await gen.next()
  }
  return { calls, terminal: r.value as Record<string, unknown>, yields }
}
{
  const limit = getBlockingLimit(MODEL) as number
  const over = await drive(foldResult(limit + 5_000))
  check('over the limit: the model is never called', over.calls === 0, `calls=${over.calls}; the blocking preempt in src/engine/loop/turn/makeRequest.ts must stop the turn before the model call when truePostFoldTokenCount is over getBlockingLimit`)
  check('over the limit: the run ends at the blocking preempt', over.terminal.reason === 'blocking_limit', `${JSON.stringify(over.terminal)}; the blocking preempt in src/engine/loop/turn/makeRequest.ts must end the run with reason blocking_limit when the fold lands over the limit`)
  const under = await drive(foldResult(120))
  check('under the limit: the exemption stands and the model runs once', under.calls === 1 && under.terminal.reason !== 'blocking_limit', `calls=${under.calls} terminal=${JSON.stringify(under.terminal)}; justCompactedUnderLimit in src/engine/loop/turn/makeRequest.ts must let a fold under the blocking limit through to one model call`)
}


console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
