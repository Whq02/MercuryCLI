import { join } from 'node:path'
import { createAssistantMessage } from '../utils/messages.js'
import { getCwd } from '../utils/cwd.js'
import type { CallModel } from '../services/providers/callModelContract.js'

const SLOW_TEXT_ACTIVE_MS = 8_000
const HAMMER_ROUND_MS = 50

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    const onAbort = (): void => {
      clearTimeout(t)
      resolve()
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

export function scriptedCallModel(
  script: string,
): CallModel | null {
  if (script === 'hammer-breaker') return scriptedHammerBreaker
  if (script === ANSWER_TEXT_SCRIPT) return scriptedAnswerText
  if (script === CHATTY_BASH_SCRIPT) return scriptedChattyBash
  if (script === OPENING_TEXT_SCRIPT) return scriptedOpeningText
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
  }
}

const HAMMER_BREAKER_FILE = 'definitely-missing-file-for-the-hammer-proof.txt'

let hammerCalls = 0

const scriptedHammerBreaker: CallModel = async function* scriptedHammerBreaker(params) {
  yield { type: 'stream_event', event: { type: 'ping' } } as never
  await sleep(HAMMER_ROUND_MS, params.signal)
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
}

export const ONE_TOOL_SCRIPTS = ['tool-read', 'tool-glob', 'tool-bash', 'tool-bash-write'] as const
type OneToolScript = (typeof ONE_TOOL_SCRIPTS)[number]
export const ANSWER_TEXT_SCRIPT = 'answer-text'
export const CHATTY_BASH_SCRIPT = 'tool-bash-chatty'
export const CHATTY_BASH_LINES = 6
const CHATTY_BASH_COMMAND = `i=1; while [ $i -le ${CHATTY_BASH_LINES} ]; do echo "chatty line $i"; i=$((i+1)); sleep 0.5; done`
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

function scriptedOneTool(script: OneToolScript): CallModel {
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
  }
}

const scriptedAnswerText: CallModel = async function* scriptedAnswerText(params) {
  yield { type: 'stream_event', event: { type: 'ping' } } as never
  if (params.signal.aborted) return
  yield createAssistantMessage({ content: ONE_TOOL_SETTLED_TEXT }) as never
}

const OPENING_TEXT_SCRIPT = 'opening-text'
const OPENING_TEXT_FILES = ['package.json', 'README.md', 'docs/README.md'] as const
const OPENING_TEXT_WORDS = 'Before I touch anything: the manifest names the package, so the greeting runs against that name. I will read the three files and report what came back.'
const OPENING_TEXT_CLOSING_WORDS = 'All three files read; the manifest still names the package.'
const OPENING_TEXT_DELTA_MS = 60

let openingTextCalls = 0

function usageOf(): { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } {
  return { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
}

const scriptedOpeningText: CallModel = async function* scriptedOpeningText(params) {
  openingTextCalls += 1
  const call = openingTextCalls
  const id = `msg_opening_${call}`
  const streamEvent = (event: Record<string, unknown>): never => ({ type: 'stream_event', event }) as never
  yield streamEvent({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'scripted', content: [], stop_reason: null, stop_sequence: null, usage: usageOf() } })
  const blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> = []
  const stopReason = call <= OPENING_TEXT_FILES.length ? 'tool_use' : 'end_turn'
  if (call === 1 || call > OPENING_TEXT_FILES.length) {
    const words = call === 1 ? OPENING_TEXT_WORDS : OPENING_TEXT_CLOSING_WORDS
    const index = blocks.length
    yield streamEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    for (const piece of words.split(/(?<= )/)) {
      yield streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
      await sleep(OPENING_TEXT_DELTA_MS, params.signal)
      if (params.signal.aborted) return
    }
    yield streamEvent({ type: 'content_block_stop', index })
    blocks.push({ type: 'text', text: words })
  }
  if (call <= OPENING_TEXT_FILES.length) {
    const index = blocks.length
    const input = { file_path: join(getCwd(), OPENING_TEXT_FILES[call - 1]!) }
    const toolUseId = `toolu_opening_${call}`
    yield streamEvent({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolUseId, name: 'Read', input: {} } })
    yield streamEvent({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
    yield streamEvent({ type: 'content_block_stop', index })
    blocks.push({ type: 'tool_use', id: toolUseId, name: 'Read', input })
  }
  yield streamEvent({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } })
  yield streamEvent({ type: 'message_stop' })
  const message = createAssistantMessage({ content: blocks as never })
  message.message.id = id
  message.message.stop_reason = stopReason
  yield message as never
}

let chattyBashCalls = 0
const scriptedChattyBash: CallModel = async function* scriptedChattyBash(params) {
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
}
