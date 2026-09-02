import { join } from 'node:path'
import { createAssistantMessage } from '../utils/messages.js'
import { getCwd } from '../utils/cwd.js'
import type { queryModelWithStreaming } from '../services/providers/anthropic/index.js'

const SLOW_TEXT_ACTIVE_MS = 8_000

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })

export function scriptedCallModel(
  script: string,
): typeof queryModelWithStreaming | null {
  if (script === 'hammer-breaker') return scriptedHammerBreaker
  if (script === ANSWER_TEXT_SCRIPT) return scriptedAnswerText
  if (script === CHATTY_BASH_SCRIPT) return scriptedChattyBash
  if ((ONE_TOOL_SCRIPTS as readonly string[]).includes(script)) {
    return scriptedOneTool(script as OneToolScript)
  }
  if (script !== 'slow-text') return null
  return async function* scriptedSlowText(params) {
    yield { type: 'stream_event', event: { type: 'ping' } } as never
    await sleep(SLOW_TEXT_ACTIVE_MS, params.signal)
    if (params.signal.aborted) return
    yield createAssistantMessage({
      content:
        'Scripted stream settled — the active window closed at the scripted boundary.',
    }) as never
  } as typeof queryModelWithStreaming
}

export const HAMMER_BREAKER_FILE = 'definitely-missing-file-for-the-hammer-proof.txt'

let hammerCalls = 0

const scriptedHammerBreaker = async function* scriptedHammerBreaker(params) {
  yield { type: 'stream_event', event: { type: 'ping' } } as never
  if (params.signal.aborted) return
  const message = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: `toolu_hammer_${++hammerCalls}`,
        name: 'Read',
        input: { file_path: join(getCwd(), HAMMER_BREAKER_FILE) },
      },
    ] as never,
  })
  message.message.stop_reason = 'tool_use'
  yield message as never
} as typeof queryModelWithStreaming

export const ONE_TOOL_SCRIPTS = ['tool-read', 'tool-glob', 'tool-bash', 'tool-bash-write'] as const
export type OneToolScript = (typeof ONE_TOOL_SCRIPTS)[number]
export const ANSWER_TEXT_SCRIPT = 'answer-text'
export const CHATTY_BASH_SCRIPT = 'tool-bash-chatty'
export const CHATTY_BASH_LINES = 6
export const CHATTY_BASH_COMMAND = `i=1; while [ $i -le ${CHATTY_BASH_LINES} ]; do echo "chatty line $i"; i=$((i+1)); sleep 0.5; done`
export const ONE_TOOL_READ_FILE = 'one-tool-read-fixture.md'
export const ONE_TOOL_SETTLED_TEXT = 'VERDICT-TURN-DONE'
export const ONE_TOOL_WRITE_WITNESS = 'exit-cliff-write-witness.txt'

const oneToolCalls = new Map<OneToolScript, number>()

function oneToolUse(script: OneToolScript): { name: string; input: Record<string, unknown> } {
  switch (script) {
    case 'tool-read':
      return { name: 'Read', input: { file_path: join(getCwd(), ONE_TOOL_READ_FILE) } }
    case 'tool-glob':
      return { name: 'Glob', input: { pattern: '*.md', path: getCwd() } }
    case 'tool-bash':
      return {
        name: 'Bash',
        input: { command: 'echo tool finished', description: 'Print one line' },
      }
    case 'tool-bash-write':
      return {
        name: 'Bash',
        input: {
          command: `printf ran > ${ONE_TOOL_WRITE_WITNESS}`,
          description: 'Write the side-effect witness',
        },
      }
  }
}

function scriptedOneTool(script: OneToolScript): typeof queryModelWithStreaming {
  return async function* scriptedOneTool(params) {
    yield { type: 'stream_event', event: { type: 'ping' } } as never
    if (params.signal.aborted) return
    const call = (oneToolCalls.get(script) ?? 0) + 1
    oneToolCalls.set(script, call)
    if (call > 1) {
      yield createAssistantMessage({ content: ONE_TOOL_SETTLED_TEXT }) as never
      return
    }
    const { name, input } = oneToolUse(script)
    const message = createAssistantMessage({
      content: [
        { type: 'tool_use', id: `toolu_${script.replace('-', '_')}_${call}`, name, input },
      ] as never,
    })
    message.message.stop_reason = 'tool_use'
    yield message as never
  } as typeof queryModelWithStreaming
}

const scriptedAnswerText = async function* scriptedAnswerText(params) {
  yield { type: 'stream_event', event: { type: 'ping' } } as never
  if (params.signal.aborted) return
  yield createAssistantMessage({ content: ONE_TOOL_SETTLED_TEXT }) as never
} as typeof queryModelWithStreaming

let chattyBashCalls = 0
const scriptedChattyBash = async function* scriptedChattyBash(params) {
  yield { type: 'stream_event', event: { type: 'ping' } } as never
  if (params.signal.aborted) return
  chattyBashCalls += 1
  if (chattyBashCalls > 1) {
    yield createAssistantMessage({ content: ONE_TOOL_SETTLED_TEXT }) as never
    return
  }
  const message = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_chatty_bash_1',
        name: 'Bash',
        input: { command: CHATTY_BASH_COMMAND, description: 'Print chatty lines slowly' },
      },
    ] as never,
  })
  message.message.stop_reason = 'tool_use'
  yield message as never
} as typeof queryModelWithStreaming
