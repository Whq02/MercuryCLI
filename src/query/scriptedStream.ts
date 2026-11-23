import { join } from 'node:path'
import { createAssistantMessage } from '../services/messages.js'
import { getCwd } from '../utils/cwd.js'
import { sleep } from '../utils/sleep.js'
import type { CallModel } from '../services/providers/callModelContract.js'
import type { StreamEvent } from '../types/message.js'
import type { ApiStreamEvent, ApiUsage, ContentBlock } from '../types/wire.js'
import { isOneOf } from '../utils/isOneOf.js'

const SLOW_TEXT_ACTIVE_MS = 8_000
const HAMMER_ROUND_MS = 50

export function scriptedCallModel(
  script: string,
): CallModel | null {
  if (script === 'hammer-breaker') return scriptedHammerBreaker
  if (script === ANSWER_TEXT_SCRIPT) return scriptedAnswerText
  if (script === CHATTY_BASH_SCRIPT) return scriptedChattyBash
  if (script === OPENING_TEXT_SCRIPT) return scriptedOpeningText
  if (script === WRITE_TOOL_SCRIPT || isOneOf(ONE_TOOL_SCRIPTS, script)) {
    return scriptedOneTool(script)
  }
  if (script !== 'slow-text') return null
  return async function* scriptedSlowText(params) {
    yield { type: 'stream_event', event: { type: 'ping' } }
    await sleep(SLOW_TEXT_ACTIVE_MS, params.signal)
    if (params.signal.aborted) return
    yield createAssistantMessage({
      content:
        'Scripted stream settled — the active window closed at the scripted boundary.',
    })
  }
}

const HAMMER_BREAKER_FILE = 'definitely-missing-file-for-the-hammer-proof.txt'

let hammerCalls = 0

const scriptedHammerBreaker: CallModel = async function* scriptedHammerBreaker(params) {
  yield { type: 'stream_event', event: { type: 'ping' } }
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
    ],
  })
  message.message.stop_reason = 'tool_use'
  yield message
}

export const ONE_TOOL_SCRIPTS = ['tool-read', 'tool-glob', 'tool-bash', 'tool-bash-write'] as const
const WRITE_TOOL_SCRIPT = 'tool-write'
type OneToolScript = (typeof ONE_TOOL_SCRIPTS)[number] | typeof WRITE_TOOL_SCRIPT
export const ANSWER_TEXT_SCRIPT = 'answer-text'
export const CHATTY_BASH_SCRIPT = 'tool-bash-chatty'
export const CHATTY_BASH_LINES = 6
const CHATTY_BASH_COMMAND = `i=1; while [ $i -le ${CHATTY_BASH_LINES} ]; do echo "chatty line $i"; i=$((i+1)); sleep 0.5; done`
export const ONE_TOOL_READ_FILE = 'one-tool-read-fixture.md'
export const ONE_TOOL_SETTLED_TEXT = 'VERDICT-TURN-DONE'
export const ONE_TOOL_WRITE_WITNESS = 'exit-cliff-write-witness.txt'
const WRITE_TOOL_WITNESS = 'one-tool-write-witness.txt'
const WRITE_TOOL_CONTENT = 'written by the scripted write tool\n'

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
    case 'tool-write':
      return {
        name: 'Write',
        input: { file_path: join(getCwd(), WRITE_TOOL_WITNESS), content: WRITE_TOOL_CONTENT },
      }
  }
}

function scriptedOneTool(script: OneToolScript): CallModel {
  return async function* scriptedOneTool(params) {
    yield { type: 'stream_event', event: { type: 'ping' } }
    if (params.signal.aborted) return
    const call = (oneToolCalls.get(script) ?? 0) + 1
    oneToolCalls.set(script, call)
    if (call > 1) {
      yield createAssistantMessage({ content: ONE_TOOL_SETTLED_TEXT })
      return
    }
    const { name, input } = oneToolUse(script)
    const message = createAssistantMessage({
      content: [
        { type: 'tool_use', id: `toolu_${script.replace('-', '_')}_${call}`, name, input },
      ],
    })
    message.message.stop_reason = 'tool_use'
    yield message
  }
}

const scriptedAnswerText: CallModel = async function* scriptedAnswerText(params) {
  yield { type: 'stream_event', event: { type: 'ping' } }
  if (params.signal.aborted) return
  yield createAssistantMessage({ content: ONE_TOOL_SETTLED_TEXT })
}

const OPENING_TEXT_SCRIPT = 'opening-text'
const OPENING_TEXT_FILES = ['package.json', 'README.md', 'docs/README.md'] as const
const OPENING_TEXT_WORDS = 'Before I touch anything: the manifest names the package, so the greeting runs against that name. I will read the three files and report what came back.'
const OPENING_TEXT_CLOSING_WORDS = 'All three files read; the manifest still names the package.'
const OPENING_TEXT_DELTA_MS = 60

let openingTextCalls = 0

function usageOf(): ApiUsage {
  return {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    iterations: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  }
}

const scriptedOpeningText: CallModel = async function* scriptedOpeningText(params) {
  openingTextCalls += 1
  const call = openingTextCalls
  const id = `msg_opening_${call}`
  const streamEvent = (event: ApiStreamEvent): StreamEvent => ({ type: 'stream_event', event })
  yield streamEvent({
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'scripted',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: usageOf(),
      container: null,
      context_management: null,
    },
  })
  const blocks: ContentBlock[] = []
  const stopReason = call <= OPENING_TEXT_FILES.length ? 'tool_use' : 'end_turn'
  if (call === 1 || call > OPENING_TEXT_FILES.length) {
    const words = call === 1 ? OPENING_TEXT_WORDS : OPENING_TEXT_CLOSING_WORDS
    const index = blocks.length
    yield streamEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } })
    for (const piece of words.split(/(?<= )/)) {
      yield streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
      await sleep(OPENING_TEXT_DELTA_MS, params.signal)
      if (params.signal.aborted) return
    }
    yield streamEvent({ type: 'content_block_stop', index })
    blocks.push({ type: 'text', text: words, citations: null })
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
  yield streamEvent({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      output_tokens: 1,
      input_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
    },
  })
  yield streamEvent({ type: 'message_stop' })
  const message = createAssistantMessage({ content: blocks })
  message.message.id = id
  message.message.stop_reason = stopReason
  yield message
}

let chattyBashCalls = 0
const scriptedChattyBash: CallModel = async function* scriptedChattyBash(params) {
  yield { type: 'stream_event', event: { type: 'ping' } }
  if (params.signal.aborted) return
  chattyBashCalls += 1
  if (chattyBashCalls > 1) {
    yield createAssistantMessage({ content: ONE_TOOL_SETTLED_TEXT })
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
    ],
  })
  message.message.stop_reason = 'tool_use'
  yield message
}
