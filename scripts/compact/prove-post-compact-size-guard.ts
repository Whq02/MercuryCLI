#!/usr/bin/env bun
// ============================================================================
//  prove-post-compact-size-guard — a compaction ends UNDER the threshold
//  that triggered it, or refuses (release-hardening audit rank 26).
//
//  The gap: compactConversation discarded the threshold it was handed
//  (`void recompactionInfo`) and reported success at any size. On a 200k
//  window the reconstruction can add a 20k summary, a 30k verbatim tail,
//  50k of restored files, 25k of skills, an unbounded plan file and hook
//  output on top of a 167k threshold; on a small window it exceeds the whole
//  window. The next iteration was exempt from the blocking preempt because
//  a compaction result existed, the oversized request went out and came
//  back rejected, and three turns later the refill breaker blamed "a single
//  input larger than the window" that never existed. The estimator the
//  result was measured with skipped the string-content summary and every
//  attachment, so the "true" post-compact figure was mostly zero.
//
//   G0 the whole-context estimator counts what the round estimator skips:
//      a string-content summary, an attachment, a system row
//   G1 the fit sheds restored files largest-first and stops as soon as the
//      estimate is under the threshold; the survivors keep their order
//   G2 shedding order across classes: files, then skills, then the plan;
//      with every sheddable gone and the core still over, the fit reports
//      over (the caller refuses) and the core rows stand
//   G3 a result already under the threshold is identity: nothing shed
//   G4 the plan reference has a ceiling: an oversized plan is cut at the
//      head with a marker naming the path; a small plan is byte-identical
//   G5 the turn machine (real loop, scripted deps): a fold that landed over
//      the blocking limit does NOT exempt the iteration — the preempt reads
//      the fold's own estimate and the model is never called; a fold under
//      the limit keeps the exemption and the model runs
//   G6 wiring pins: the compact owner consumes the threshold (no void), the
//      manual /compact and the swarm runner pass theirs, the notes path
//      measures with the whole-context estimator
//
//  PROVE_SRC names another checkout's src (the A/B control: G0–G2, G4, G5's
//  over-limit leg and G6 read red there).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'post-compact-guard-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'post-compact-guard-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'post-compact-guard-teams-'))
for (const k of [
  'MERCURY_SIMPLE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_BLOCKING_LIMIT_OVERRIDE',
  'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_RELEVANT_RECALL', 'CLAUDE_TEAM_NAME', 'CLAUDE_AGENT_NAME',
  'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY', 'MERCURY_TIME_BASED_MC', 'NODE_ENV',
  'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN',
]) {
  delete process.env[k]
}
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const ROOT = join(SRC, '..')

const { queryEvents } = await import(join(SRC, 'query.ts'))
const { legacyYieldsOf } = await import(join(SRC, 'run-core/project-legacy.ts'))
const bootstrap = await import(join(SRC, 'bootstrap/state.ts'))
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import(join(SRC, 'utils/config/globalConfig.ts'))
enableConfigs()
const { getDefaultAppState } = await import(join(SRC, 'state/AppStateStore.ts'))
const { createAssistantMessage, createUserMessage } = await import(join(SRC, 'utils/messages.ts'))
const { createCompactBoundaryMessage } = await import(join(SRC, 'utils/messages/systemMessages.ts'))
const { createAttachmentMessage } = await import(join(SRC, 'utils/attachments/orchestrator.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(SRC, 'utils/fileStateCache.ts'))
const { getBlockingLimit } = await import(join(SRC, 'services/compact/autoCompact.ts'))
const micro = await import(join(SRC, 'services/compact/microCompact.ts'))
const compactMod = await import(join(SRC, 'services/compact/compact.ts'))
const plans = await import(join(SRC, 'utils/plans.ts'))

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
  console.log('\nTIMEOUT — post-compact size guard prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const estimateContext: ((m: unknown[]) => number) | undefined = typeof micro.estimateContextTokens === 'function' ? micro.estimateContextTokens : undefined
const fit: ((r: unknown, t: number) => Fit) | undefined = typeof compactMod.fitPostCompactUnderThreshold === 'function' ? compactMod.fitPostCompactUnderThreshold : undefined
const buildPostCompactMessages = compactMod.buildPostCompactMessages as (r: unknown) => unknown[]

// ── fixtures ────────────────────────────────────────────────────────────────
const fileAttachment = (name: string, chars: number): AnyMsg =>
  createAttachmentMessage({
    type: 'file',
    filename: `/rig/${name}`,
    displayPath: name,
    content: { type: 'text', file: { filePath: `/rig/${name}`, content: 'x'.repeat(chars), numLines: 1, startLine: 1, totalLines: 1 } },
  } as never) as unknown as AnyMsg
const skillsAttachment = (chars: number): AnyMsg =>
  createAttachmentMessage({ type: 'invoked_skills', skills: [{ name: 'rig-skill', path: '/rig/SKILL.md', content: 's'.repeat(chars) }] } as never) as unknown as AnyMsg
const planAttachment = (chars: number): AnyMsg =>
  createAttachmentMessage({ type: 'plan_file_reference', planFilePath: '/rig/plan.md', planContent: 'p'.repeat(chars) } as never) as unknown as AnyMsg

function rigResult(attachments: AnyMsg[]): Record<string, unknown> {
  return {
    boundaryMarker: createCompactBoundaryMessage('auto', 150_000),
    summaryMessages: [createUserMessage({ content: `RIG SUMMARY ${'of the folded history. '.repeat(20)}`, isCompactSummary: true, isVisibleInTranscriptOnly: true })],
    attachments,
    hookResults: [],
    preCompactTokenCount: 150_000,
    postCompactTokenCount: 0,
    compactionUsage: undefined,
  }
}
const attachmentNames = (r: { attachments: AnyMsg[] }): string[] =>
  r.attachments.map(a => {
    const att = a.attachment as { type: string; filename?: string }
    return att.type === 'file' ? `file ${att.filename}` : att.type
  })

// ── G0 ──────────────────────────────────────────────────────────────────────
section('G0 the whole-context estimator counts what the round estimator skips')
{
  const summary = createUserMessage({ content: 'a compact summary '.repeat(200), isCompactSummary: true })
  const attachment = fileAttachment('a.txt', 4_000)
  const boundary = createCompactBoundaryMessage('auto', 10)
  const roundEstimate = micro.estimateMessageTokens([summary, attachment, boundary] as never)
  check('the round estimator reads the summary + attachment + boundary as zero (why the guard needs its own)', roundEstimate === 0, String(roundEstimate))
  check('estimateContextTokens exists', estimateContext !== undefined)
  if (estimateContext !== undefined) {
    check('a string-content summary weighs', estimateContext([summary]) > 500, String(estimateContext([summary])))
    check('an attachment weighs', estimateContext([attachment]) > 800, String(estimateContext([attachment])))
    check('a system row weighs its content line', estimateContext([boundary]) > 0 && estimateContext([boundary]) < 50, String(estimateContext([boundary])))
    check('a block-array row agrees with the round estimator', estimateContext([createAssistantMessage({ content: 'hello '.repeat(100) })]) === micro.estimateMessageTokens([createAssistantMessage({ content: 'hello '.repeat(100) })]))
    check('a progress row weighs nothing', estimateContext([{ type: 'progress', uuid: 'p', timestamp: 't', data: { big: 'z'.repeat(10_000) } }]) === 0)
  }
}

// ── G1 ──────────────────────────────────────────────────────────────────────
section('G1 the fit sheds restored files largest-first, stops as soon as it fits, keeps order')
{
  check('fitPostCompactUnderThreshold exists', fit !== undefined)
  if (fit !== undefined && estimateContext !== undefined) {
    const A = fileAttachment('A.txt', 4_000)
    const B = fileAttachment('B.txt', 1_200)
    const C = fileAttachment('C.txt', 2_400)
    const S = skillsAttachment(2_000)
    const P = planAttachment(800)
    const result = rigResult([A, B, C, S, P])
    // The estimator rounds per call, so the band is read off the reduced
    // results themselves: shedding A alone leaves the estimate over;
    // shedding A then C brings it under.
    const afterA = estimateContext(buildPostCompactMessages(rigResult([B, C, S, P])))
    const afterAC = estimateContext(buildPostCompactMessages(rigResult([B, S, P])))
    const threshold = afterAC + 1
    check('the fixture band is real (A alone is not enough)', afterA >= threshold, `${afterA} vs ${threshold}`)
    const out = fit(result, threshold)
    check('two files shed, the largest first', out.shed.length === 2 && out.shed[0] === 'file /rig/A.txt' && out.shed[1] === 'file /rig/C.txt', out.shed.join(' | '))
    check('the estimate is under the threshold', out.estimate < threshold, `${out.estimate} vs ${threshold}`)
    check('the estimate is the whole-context estimate of the fitted result', out.estimate === estimateContext(buildPostCompactMessages(out.result)))
    check('the survivors keep their order: B, skills, plan', attachmentNames(out.result).join(',') === 'file /rig/B.txt,invoked_skills,plan_file_reference', attachmentNames(out.result).join(','))
    check('the boundary and the summary are untouched', out.result.boundaryMarker === result.boundaryMarker && out.result.summaryMessages === result.summaryMessages)
  }
}

// ── G2 ──────────────────────────────────────────────────────────────────────
section('G2 shedding order across classes; an irreducible core reports over')
{
  if (fit !== undefined && estimateContext !== undefined) {
    const A = fileAttachment('A.txt', 4_000)
    const B = fileAttachment('B.txt', 1_200)
    const S = skillsAttachment(2_000)
    const P = planAttachment(800)
    const result = rigResult([P, S, B, A])
    const core = estimateContext(buildPostCompactMessages(rigResult([])))
    const out = fit(result, core)
    check('everything sheddable goes: files largest-first, then skills, then the plan', out.shed.join(',') === 'file /rig/A.txt,file /rig/B.txt,invoked_skills,plan /rig/plan.md', out.shed.join(','))
    check('the fit reports over (the caller refuses)', out.estimate >= core, `${out.estimate} vs ${core}`)
    check('the core rows stand', out.result.attachments.length === 0 && out.result.summaryMessages.length === 1)
  }
}

// ── G3 ──────────────────────────────────────────────────────────────────────
section('G3 already under the threshold: identity')
{
  if (fit !== undefined && estimateContext !== undefined) {
    const result = rigResult([fileAttachment('A.txt', 4_000), skillsAttachment(500)])
    const total = estimateContext(buildPostCompactMessages(result))
    const out = fit(result, total + 1)
    check('nothing shed', out.shed.length === 0)
    check('the same result object', out.result === result)
    check('the estimate is the total', out.estimate === total)
  }
}

// ── G4 ──────────────────────────────────────────────────────────────────────
section('G4 the plan reference has a ceiling')
{
  const ceiling = compactMod.POST_COMPACT_MAX_TOKENS_PER_PLAN as number | undefined
  check('POST_COMPACT_MAX_TOKENS_PER_PLAN exists', typeof ceiling === 'number')
  const planPath = plans.getPlanFilePath()
  mkdirSync(dirname(planPath), { recursive: true })
  const big = `# plan\n${'step: do the thing, then the next thing.\n'.repeat(2_000)}`
  writeFileSync(planPath, big)
  const bigAttachment = compactMod.createPlanAttachmentIfNeeded() as AnyMsg | null
  const bigContent = ((bigAttachment?.attachment as { planContent?: string } | undefined)?.planContent) ?? ''
  check('an oversized plan is cut', bigAttachment !== null && bigContent.length < big.length, `${bigContent.length}/${big.length}`)
  check('…at the head, with a marker naming the plan path', bigContent.startsWith('# plan') && bigContent.includes('[Plan content truncated for compaction'), bigContent.slice(-90))
  if (typeof ceiling === 'number') check('…within the ceiling', bigContent.length <= ceiling * 4, `${bigContent.length} vs ${ceiling * 4}`)
  const small = '# plan\nstep one\n'
  writeFileSync(planPath, small)
  const smallAttachment = compactMod.createPlanAttachmentIfNeeded() as AnyMsg | null
  check('a small plan is byte-identical', ((smallAttachment?.attachment as { planContent?: string } | undefined)?.planContent) === small)
}

// ── G5 ──────────────────────────────────────────────────────────────────────
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
      mainLoopModel: MODEL,
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
function foldResult(truePostCompactTokenCount: number): Record<string, unknown> {
  return {
    wasCompacted: true,
    compactionResult: {
      boundaryMarker: createCompactBoundaryMessage('auto', 900),
      summaryMessages: [createUserMessage({ content: 'RIG SUMMARY of the folded history', isCompactSummary: true })],
      attachments: [],
      hookResults: [],
      preCompactTokenCount: 900,
      postCompactTokenCount: 120,
      truePostCompactTokenCount,
      compactionUsage: undefined,
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
    return compactCalls.length === 1 ? fold : { wasCompacted: false }
  }
  const gen = queryEvents({
    messages: [createUserMessage({ content: 'earlier ask' }), createAssistantMessage({ content: 'earlier reply' }), createUserMessage({ content: 'operator ask' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: makeCtx() as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: autocompact as never,
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
  check('over the limit: the model is never called', over.calls === 0, `calls=${over.calls}`)
  check('over the limit: the run ends at the blocking preempt', over.terminal.reason === 'blocking_limit', JSON.stringify(over.terminal))
  const under = await drive(foldResult(120))
  check('under the limit: the exemption stands and the model runs once', under.calls === 1 && under.terminal.reason !== 'blocking_limit', `calls=${under.calls} terminal=${JSON.stringify(under.terminal)}`)
}

// ── G6 ──────────────────────────────────────────────────────────────────────
section('G6 wiring pins')
{
  const compactSrc = readFileSync(join(ROOT, 'src/services/compact/compact.ts'), 'utf8')
  check('the compact owner consumes the threshold (no void)', !compactSrc.includes('void recompactionInfo') && compactSrc.includes('const ceiling = recompactionInfo?.autoCompactThreshold'))
  check('the owner fits, then refuses when still over', /fitPostCompactUnderThreshold\(partial, ceiling\)[\s\S]{0,700}throw new Error\(postCompactOverThresholdMessage/.test(compactSrc))
  check('the refusal hands the read ledger back first', /for \(const \[path, state\] of ledgerBeforeFold\) context\.readFileState\.set\(path, state\)\s*throw new Error\(postCompactOverThresholdMessage/.test(compactSrc))
  const manual = readFileSync(join(ROOT, 'src/commands/compact/compact.ts'), 'utf8')
  check('the manual /compact passes the auto-compact threshold as its ceiling', manual.includes('autoCompactThreshold: getAutoCompactThreshold(context.options.mainLoopModel)'))
  const swarm = readFileSync(join(ROOT, 'src/utils/swarm/inProcessRunner.ts'), 'utf8')
  check('the swarm runner passes the threshold it compares against', swarm.includes('autoCompactThreshold: compactThreshold'))
  const notes = readFileSync(join(ROOT, 'src/services/compact/sessionMemoryCompact.ts'), 'utf8')
  check('the notes path measures its result with the whole-context estimator', notes.includes('estimateContextTokens(buildPostCompactMessages(result))') && notes.includes('estimateContextTokens([summaryMessage])'))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
