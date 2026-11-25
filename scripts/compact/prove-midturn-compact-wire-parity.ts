#!/usr/bin/env bun
import { randomUUID, type UUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'midturn-compact-wire-parity-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.CI

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { createFoldBoundaryMessage, createUserMessage, createAssistantMessage, shouldShowUserMessage } = await import('../../src/engine/messages/messages.ts')
const { requestConversationPlan } = await import('../../src/engine/messages/apiPlan.ts')
const { foldContext } = await import('../../src/engine/loop/turn/makeRequest.ts')
const { createEventMint } = await import('../../src/engine/loop/events.ts')
const { legacyYieldsOf } = await import('../../src/engine/loop/project-legacy.ts')
const { processSlashCommand } = await import('../../src/engine/user-input/processSlashCommand.tsx')
const { manualFoldDisplayText } = await import('../../src/engine/compaction/manualReceipt.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { SendsPart } = await import('../../src/engine/connector/daemon/sends.ts')
const { placeLocalCommandRows } = await import('../../src/engine/connector/localCommandRows.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { createContentReplacementState } = await import('../../src/engine/tool-dispatch/toolResultStorage.ts')
const { BudgetGuard } = await import('../../src/engine/loop/budget-guard.ts')
const { NOTHING_TO_FOLD_KEY } = await import('../../src/engine/compaction/foldConversation.ts')
type Message = import('../../src/engine/message-shapes/message.ts').Message
type FoldResult = import('../../src/engine/compaction/fold/foldResult.ts').FoldResult
type ToolUseContext = import('../../src/tools/kit/tool.ts').ToolUseContext
type Command = import('../../src/commands/catalogue/commands.ts').Command
type RunCtx = Parameters<typeof foldContext>[0]
type TurnState = Parameters<typeof foldContext>[1]
type PlannedContext = Parameters<typeof foldContext>[4]

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const HINT = 'foldContext in src/engine/loop/turn/makeRequest.ts must emit createSyntheticUserCaveatMessage() before consumed mid-turn /compact command rows and emit <local-command-stderr> on mid-turn decline, matching idle /compact in src/engine/user-input/processSlashCommand.tsx'
const MODEL = 'claude-opus-4-8'

function makeToolUseContext(messages: Message[]): ToolUseContext {
  const appState = {
    ...getDefaultAppState(),
    toolPermissionContext: getEmptyToolPermissionContext(),
    verbose: false,
    engineModel: MODEL,
  }
  const base: Partial<ToolUseContext> = {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(20),
    contentReplacementState: createContentReplacementState(),
    loadedNestedMemoryPaths: new Set<string>(),
    messages,
    getAppState: () => appState,
    setAppState: () => {},
    setResponseLength: () => {},
    addNotification: () => {},
    setMessages: () => {},
    options: {
      tools: [],
      mcpClients: [],
      commands: [],
      agentDefinitions: { activeAgents: [], allAgents: [] },
      engineModel: MODEL,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      isNonInteractiveSession: true,
    },
  }
  return base as ToolUseContext
}

function makeFoldResult(kept: Message[], trigger: 'manual' | 'auto'): FoldResult {
  const summary = createUserMessage({ content: 'Summary of the earlier stretch.', isCompactSummary: true })
  return {
    boundaryMarker: createFoldBoundaryMessage(trigger, 12000),
    summaryMessages: [summary],
    messagesToKeep: kept,
    attachments: [],
    hookResults: [],
    preFoldTokenCount: 12000,
    postFoldTokenCount: 4000,
    truePostFoldTokenCount: 4000,
  }
}

function localCommandTextsOf(messages: readonly Message[], geometry: 'anthropic' | 'family'): string[] {
  const planned = requestConversationPlan(messages, [], geometry).messages
  const texts: string[] = []
  for (const row of planned) {
    if (row.type !== 'user') continue
    const content = row.message.content
    const parts = typeof content === 'string'
      ? [content]
      : content.flatMap(block => (block.type === 'text' ? [block.text] : []))
    for (const part of parts) {
      if (
        part.startsWith('<local-command-caveat>') ||
        part.startsWith('<command-message>') ||
        part.startsWith('<command-name>') ||
        part.startsWith('<local-command-stdout>') ||
        part.startsWith('<local-command-stderr>')
      ) {
        texts.push(part)
      }
    }
  }
  return texts
}

async function runIdleCompact(
  input: string,
  uuid: UUID,
  kept: Message[],
  outcome: { kind: 'landed'; foldResult: FoldResult; handedIn: number } | { kind: 'declined'; refusal: string },
): Promise<Message[]> {
  const ctx = makeToolUseContext(kept)
  const stubCommand: Command = {
    name: 'compact',
    type: 'local',
    description: 'Compact conversation',
    isEnabled: () => true,
    isHidden: false,
    supportsNonInteractive: true,
    userFacingName: () => 'compact',
    load: async () => ({
      call: async () => {
        if (outcome.kind === 'declined') throw new Error(outcome.refusal)
        return {
          type: 'compact' as const,
          foldHandoff: outcome.foldResult,
          displayText: manualFoldDisplayText(ctx, outcome.foldResult, outcome.handedIn),
        }
      },
    }),
  }
  const processCtx = { ...ctx, options: { ...ctx.options, commands: [stubCommand] } } as Parameters<typeof processSlashCommand>[3]
  const result = await processSlashCommand(input, [], [], processCtx, () => {}, uuid)
  return result.messages
}

async function runMidturnCompact(
  history: Message[],
  autoFoldAnswer: Awaited<ReturnType<RunCtx['deps']['autoFold']>>,
): Promise<Message[]> {
  const ctx = makeToolUseContext(history)
  const emit = createEventMint()
  const run: RunCtx = {
    params: {
      messages: history,
      systemPrompt: asSystemPrompt(['fixture']),
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      toolUseContext: ctx,
      querySource: 'main_thread',
    },
    deps: {
      uuid: () => randomUUID(),
      callModel: async function* () { return },
      autoFold: async () => autoFoldAnswer,
      prune: async () => ({ messages: history, cleared: 0, tokensSaved: 0 }),
    },
    emit,
    budgetGuard: new BudgetGuard(),
    systemPrompt: asSystemPrompt(['fixture']),
    userContext: {},
    systemContext: {},
    querySource: 'main_thread',
    awaitingReply: [],
    fallbackModel: undefined,
    skipCacheWrite: undefined,
    consumedCommandUuids: [],
    announcedStepNudges: 0,
    checkpointSettleWarned: false,
    pendingMemoryWrites: [],
    holdMemoryWriteRefusals: () => {},
    memoryWriteLostEvent: () => null,
  }
  const state: TurnState = {
    messages: history,
    toolUseContext: ctx,
    autoFoldTracking: undefined,
    maxOutputTokensRecoveryCount: 0,
    lastOutputLimitReply: '',
    maxOutputTokensOverride: undefined,
    streamFaultRecoveryCount: 0,
    toolCallRefusalRecoveryCount: 0,
    stopHookActive: false,
    turnCount: 0,
    overflowEpisode: { pruned: false, folded: false },
    pendingOverflow: undefined,
    transition: undefined,
  }
  const planned: PlannedContext = {
    requestPlan: { messages: history, afterBoundaryCount: history.length, reductions: { pressurePruned: undefined, timeBasedCleared: 0 } } as PlannedContext['requestPlan'],
    messagesForRequest: history,
    prunedTokensFreed: 0,
    thinkingRecords: [],
    fullSystemPrompt: asSystemPrompt(['fixture']),
  }
  const emitted: Message[] = []
  for await (const event of foldContext(run, state, ctx, { tracking: undefined, overflowEpisode: { pruned: false, folded: false } }, planned)) {
    for (const legacy of legacyYieldsOf(event)) {
      if ('uuid' in legacy) emitted.push(legacy as Message)
    }
  }
  return emitted
}

try {
  const priorTime = new Date(Date.now() - 60_000).toISOString()
  const kept: Message[] = [
    createUserMessage({ content: 'seed ask', timestamp: priorTime }),
    createAssistantMessage({ content: [{ type: 'text', text: 'seed answer' }], timestamp: priorTime }),
  ]
  const nextPrompt = createUserMessage({ content: 'next turn ask' })

  for (const scenario of [
    { label: 'instructed /compact landed', input: '/compact keep the silver label', args: 'keep the silver label' },
    { label: 'bare /compact landed', input: '/compact', args: '' },
  ]) {
    const idIdle = randomUUID()
    const idMid = randomUUID()
    const idleFold = makeFoldResult(kept, 'manual')
    const midFold = makeFoldResult(kept, 'manual')
    const idleRows = await runIdleCompact(scenario.input, idIdle, kept, { kind: 'landed', foldResult: idleFold, handedIn: kept.length })
    const midRows = await runMidturnCompact(kept, {
      wasFolded: true,
      foldResult: midFold,
      consumedCommands: [{ uuid: idMid, args: scenario.args }],
    })
    for (const geometry of ['anthropic', 'family'] as const) {
      const idleTexts = localCommandTextsOf([...idleRows, nextPrompt], geometry)
      const midTexts = localCommandTextsOf([...midRows, nextPrompt], geometry)
      check(
        `${scenario.label} (${geometry}): mid-turn local-command rows match idle row-for-row`,
        idleTexts.length === 3 && JSON.stringify(midTexts) === JSON.stringify(idleTexts),
        `idle=${JSON.stringify(idleTexts)} mid=${JSON.stringify(midTexts)} | ${HINT}`,
      )
    }
    const caveatRow = midRows.find(r => r.type === 'user' && r.isMeta === true && typeof r.message.content === 'string' && r.message.content.startsWith('<local-command-caveat>'))
    check(
      `${scenario.label}: caveat row is hidden on screen (isMeta user row)`,
      caveatRow !== undefined && !shouldShowUserMessage(caveatRow as Parameters<typeof shouldShowUserMessage>[0], false),
      `caveatRow=${JSON.stringify(caveatRow)} | ${HINT}`,
    )
    const sends = new SendsPart({
      sessionId: () => 'wire-parity-session',
      rows: () => midRows,
      paint: () => {},
      folding: () => false,
      wakeLive: () => {},
      arrivalSeqFor: () => 1,
      noticeSeqAt: () => 1,
      retireTextRowsWithRunner: () => {},
      noteSendDemoted: () => {},
      noteSendTaken: () => {},
      lostWithRunnerLine: lines => lines.join('\n'),
    })
    sends.echo(idMid, createUserMessage({ uuid: idMid, content: scenario.input, queued: true }))
    sends.enlist({ clientMessageId: idMid, text: scenario.input, sentAtMs: Date.now(), state: 'taken', mode: 'prompt' })
    const retired = sends.reconcileSends()
    check(
      `${scenario.label}: SendsPart retires the optimistic echo by client uuid`,
      retired && sends.echoes(null).held.length === 0,
      `retired=${retired} remaining=${sends.echoes(null).held.length} | ${HINT}`,
    )
    const placed = placeLocalCommandRows(midRows)
    const seedIdx = placed.findIndex(r => r.type === 'assistant')
    const cmdIdx = placed.findIndex(r => r.uuid === idMid)
    const outIdx = placed.findIndex(r => r.type === 'system' && r.subtype === 'local_command' && r.content.startsWith('<local-command-stdout>'))
    check(
      `${scenario.label}: placeLocalCommandRows keeps command after kept history and directly above Compacted —`,
      seedIdx >= 0 && cmdIdx > seedIdx && outIdx === cmdIdx + 1,
      `indices=${JSON.stringify({ seedIdx, cmdIdx, outIdx })} | ${HINT}`,
    )
  }

  {
    const refusal = `${NOTHING_TO_FOLD_KEY}: conversation already compact.`
    const idIdle = randomUUID()
    const idMid = randomUUID()
    const idleRows = await runIdleCompact('/compact keep the silver label', idIdle, kept, { kind: 'declined', refusal })
    const midRows = await runMidturnCompact(kept, {
      wasFolded: false,
      declined: true,
      refusal,
      consumedCommands: [{ uuid: idMid, args: 'keep the silver label' }],
    })
    for (const geometry of ['anthropic', 'family'] as const) {
      const idleTexts = localCommandTextsOf([...kept, ...idleRows, nextPrompt], geometry)
      const midTexts = localCommandTextsOf([...kept, ...midRows, nextPrompt], geometry)
      check(
        `declined /compact (${geometry}): mid-turn local-command rows match idle row-for-row`,
        idleTexts.length === 3 && JSON.stringify(midTexts) === JSON.stringify(idleTexts),
        `idle=${JSON.stringify(idleTexts)} mid=${JSON.stringify(midTexts)} | ${HINT}`,
      )
    }
    const sends = new SendsPart({
      sessionId: () => 'wire-parity-decline',
      rows: () => [...kept, ...midRows],
      paint: () => {},
      folding: () => false,
      wakeLive: () => {},
      arrivalSeqFor: () => 1,
      noticeSeqAt: () => 1,
      retireTextRowsWithRunner: () => {},
      noteSendDemoted: () => {},
      noteSendTaken: () => {},
      lostWithRunnerLine: lines => lines.join('\n'),
    })
    sends.echo(idMid, createUserMessage({ uuid: idMid, content: '/compact keep the silver label', queued: true }))
    sends.enlist({ clientMessageId: idMid, text: '/compact keep the silver label', sentAtMs: Date.now(), state: 'taken', mode: 'prompt' })
    check(
      'declined /compact: SendsPart retires the optimistic echo by client uuid',
      sends.reconcileSends() && sends.echoes(null).held.length === 0,
      `remaining=${sends.echoes(null).held.length} | ${HINT}`,
    )
  }

  {
    const idAuto = randomUUID()
    const autoFold = makeFoldResult(kept, 'auto')
    const autoRows = await runMidturnCompact(kept, {
      wasFolded: true,
      foldResult: autoFold,
      consumedCommands: [{ uuid: idAuto, args: 'focus on tests' }],
    })
    for (const geometry of ['anthropic', 'family'] as const) {
      const texts = localCommandTextsOf([...autoRows, nextPrompt], geometry)
      check(
        `auto-fold consuming queued /compact (${geometry}): caveat precedes command row`,
        texts.length === 2 && texts[0]!.startsWith('<local-command-caveat>') && texts[1]!.includes('<command-args>focus on tests</command-args>'),
        `texts=${JSON.stringify(texts)} | ${HINT}`,
      )
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nmidturn-compact-wire-parity: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
