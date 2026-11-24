#!/usr/bin/env bun
import React from 'react'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('question-declined-row')
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}${ok ? '' : ' — Hint: the recorded result comes from decisionOfAnswer in src/daemon/runner/runnerAsks.ts with the texts in src/engine/message-shapes/rejectionText.ts; the row the operator reads comes from src/screen/messages/user-tool-result/UserToolErrorMessage.tsx.'}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { turnDoor } = await import('../../src/engine/turnDoor.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { Box } = await import('../../src/screen/themedRenderer.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { decisionOfAnswer } = await import('../../src/daemon/runner/runnerAsks.ts')
const { REJECT_MESSAGE, REJECT_MESSAGE_WITH_REASON_PREFIX, CREWMATE_REJECT_MESSAGE, DENIAL_WORKAROUND_GUIDANCE } = await import('../../src/engine/message-shapes/rejectionText.ts')
const { AskUserQuestionTool } = await import('../../src/tools/ask-question/AskUserQuestionTool.tsx')
const { UserToolErrorMessage } = await import('../../src/screen/messages/user-tool-result/UserToolErrorMessage.tsx')

const h = React.createElement
const MODEL = 'claude-opus-4-8'
const QUESTIONS = { questions: [{ question: 'Which road should it take?', header: 'Road', multiSelect: false, options: [{ label: 'North', description: 'Over the pass.' }, { label: 'South', description: 'Along the coast.' }] }] }

async function declinedOnTheRunnersRoad(words: string | undefined): Promise<{ content: unknown; isError: unknown; requests: number }> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const context: Record<string, unknown> = {
    abortController: new AbortController(),
    options: { commands: [], tools: [AskUserQuestionTool], engineModel: MODEL, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (update: (previous: never) => never): void => { appState = update(appState as never) as unknown as Record<string, unknown> },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }
  const canUseTool = async (tool: never, input: Record<string, unknown>, toolUseContext: never) =>
    decisionOfAnswer({ outcome: 'deny', message: words === undefined ? REJECT_MESSAGE : REJECT_MESSAGE_WITH_REASON_PREFIX + words } as never, tool, input, toolUseContext)
  let requests = 0
  async function* callModel(): AsyncGenerator<never, void> {
    requests++
    if (requests > 1) {
      const done = createAssistantMessage({ content: 'Understood.' })
      done.message.stop_reason = 'end_turn'
      yield done as never
      return
    }
    const ask = createAssistantMessage({ content: [{ type: 'tool_use', id: 'tu_question_1', name: AskUserQuestionTool.name, input: QUESTIONS }] as never })
    ask.message.stop_reason = 'tool_use'
    yield ask as never
  }
  const turn = turnDoor({
    messages: [createUserMessage({ content: 'go on' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: canUseTool as never,
    toolUseContext: context as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autoFold: (async () => ({ wasCompacted: false })) as never,
      prune: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` })(),
    },
  }) as AsyncGenerator<Record<string, unknown>, unknown>
  let content: unknown
  let isError: unknown
  for (let step = await turn.next(); !step.done; step = await turn.next()) {
    const message = step.value as { type?: string; message?: { content?: unknown } }
    if (message.type !== 'user' || !Array.isArray(message.message?.content)) continue
    for (const block of message.message.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && block.tool_use_id === 'tu_question_1') {
        content = block.content
        isError = block.is_error
      }
    }
  }
  return { content, isError, requests }
}

async function rowOf(content: unknown): Promise<string[]> {
  const view: Mounted = await mountOffscreen(
    h(AppStateProvider, null, h(ThemeProvider, null, h(Box, { width: 100, height: 12, flexDirection: 'column' },
      h(UserToolErrorMessage, { progressMessagesForMessage: [], tool: AskUserQuestionTool, tools: [AskUserQuestionTool], param: { type: 'tool_result', tool_use_id: 'tu_question_1', content, is_error: true }, verbose: false } as never)))),
    100, 12,
  )
  try {
    await waitFor(() => view.lines().some(line => line.trim() !== ''), 5_000)
    await settle(80)
    return view.lines().map(line => line.trim()).filter(line => line !== '')
  } finally {
    view.unmount()
  }
}

section("a question declined in the window: what the record holds for the model is what it held")
const plain = await declinedOnTheRunnersRoad(undefined)
const worded = await declinedOnTheRunnersRoad('ask me later')
check('the wordless decline is recorded as the refusal with its guidance, to the byte, as an error result', plain.content === `<tool_use_error>${REJECT_MESSAGE}</tool_use_error>` && plain.isError === true && REJECT_MESSAGE.endsWith(DENIAL_WORKAROUND_GUIDANCE), JSON.stringify(plain))
check("a decline with words is recorded with the operator's words", worded.content === `<tool_use_error>${REJECT_MESSAGE_WITH_REASON_PREFIX}ask me later</tool_use_error>` && worded.isError === true, JSON.stringify(worded))
check('the model is told and the turn goes on, as on every card in the window', plain.requests === 2 && worded.requests === 2, `${plain.requests} and ${worded.requests} requests`)

section('the row the operator reads for it is the decline, not an error')
{
  const row = await rowOf(plain.content)
  check('the row reads "User declined to answer" and nothing else', row.length === 1 && row[0] === 'User declined to answer', JSON.stringify(row))
  check('no error head and none of the guidance written for the model', !row.some(line => /Error|Do not try to reach|stop and say plainly|wait for the operator/.test(line)), JSON.stringify(row))
  const wordedRow = await rowOf(worded.content)
  check('a decline with words reads the same line', wordedRow.length === 1 && wordedRow[0] === 'User declined to answer', JSON.stringify(wordedRow))
  const crewmate = await rowOf(`<tool_use_error>${CREWMATE_REJECT_MESSAGE}</tool_use_error>`)
  check("a crewmate's declined question reads the same line", crewmate.length === 1 && crewmate[0] === 'User declined to answer', JSON.stringify(crewmate))
}

section('a real failure of the tool is still an error row with its words')
{
  const failed = await rowOf('<tool_use_error>Question texts must be unique.</tool_use_error>')
  check('the failure is shown as before, with what went wrong', failed.some(line => line.includes('Question texts must be unique')) && !failed.some(line => line.includes('User declined')), JSON.stringify(failed))
}

await releaseScratchHome(home)
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
