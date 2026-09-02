// ============================================================================
//  query/scriptedStream — the deterministic scripted model stream (
//  the rateLimitMocking-class fixture seam).
//
//  Rendered-capture choreography needs an ACTIVE foreground turn with
//  deterministic timing and zero network: the MERCURY_SCRIPTED_STREAM flag
//  (registered) swaps the provider callModel at the deps seam
//  (src/query/deps.ts) for one of these bounded synthetic streams. The
//  active window is a scripted await — long enough for a PTY send to open
//  /model, park at the preview card, and confirm into the QUEUED path while
//  the turn still runs (the A03 journey + the pending-chip
//  capture). Abort is honored (a capture teardown never hangs on the
//  window). Never active unless the flag names a known script.
// ============================================================================
import { join } from 'node:path'
import { createAssistantMessage } from '../utils/messages.js'
import { getCwd } from '../utils/cwd.js'
import type { queryModelWithStreaming } from '../services/providers/anthropic/index.js'

/** The scripted active window (ms) — long enough for capture sends, short
 *  enough that a scenario settles inside its tick budget. */
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

/** Build the scripted callModel for a named script; null for unknown names
 *  (the deps seam falls back to the provider router — never a dead lane). */
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

/** The file the hammering script keeps reading, under the session's own
 *  working directory: it never exists, so every Read fails identically, and
 *  a Read inside the project never asks for permission. */
export const HAMMER_BREAKER_FILE = 'definitely-missing-file-for-the-hammer-proof.txt'

let hammerCalls = 0

/** A model in a trance: every call answers with the SAME failing Read
 *  tool_use, forever — the shape the repetition breaker
 *  (services/tools/identicalFailureGuard.ts) exists to end. The screen
 *  capture (scripts/repetition-guard/render-hammer-breaker.ts) reads the
 *  breaker's warning off the real cockpit. */
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

/** The one-tool scripts (the headless exit
 *  abort on win32 after ANY tool executed): the FIRST call answers one
 *  tool_use of the named class against the session's own working directory
 *  (a Read of ONE_TOOL_READ_FILE, a Glob of `*.md`, a Bash echo), the SECOND
 *  — after the tool_result — settles with ONE_TOOL_SETTLED_TEXT: the exact
 *  turn shape the box crashed on 8/8. `answer-text` settles at once with no
 *  tool: the control. Zero network. */
export const ONE_TOOL_SCRIPTS = ['tool-read', 'tool-glob', 'tool-bash', 'tool-bash-write'] as const
export type OneToolScript = (typeof ONE_TOOL_SCRIPTS)[number]
export const ANSWER_TEXT_SCRIPT = 'answer-text'
/** `tool-bash-chatty` (LIVEPAINT's RUN_LIVE leg): the one-tool turn shape
 *  with a CHATTY bounded command — several output lines across ~3s, so the
 *  REAL BashTool yields bash_progress ticks and the runner's ephemeral-tail
 *  frames can be asserted on a real stream. Deliberately NOT a member of
 *  ONE_TOOL_SCRIPTS: the exit-cliff census loops that array and this
 *  script's active window would slow it for nothing. */
export const CHATTY_BASH_SCRIPT = 'tool-bash-chatty'
export const CHATTY_BASH_LINES = 6
export const CHATTY_BASH_COMMAND = `i=1; while [ $i -le ${CHATTY_BASH_LINES} ]; do echo "chatty line $i"; i=$((i+1)); sleep 0.5; done`
export const ONE_TOOL_READ_FILE = 'one-tool-read-fixture.md'
export const ONE_TOOL_SETTLED_TEXT = 'VERDICT-TURN-DONE'
/** `tool-bash-write`'s side-effect witness: a MUTATING command (a redirect,
 *  never auto-allowed as read-only) so the permission layer decides — with
 *  Bash allowed the file exists after the run; with Bash outside
 *  --allowedTools the call is DENIED at dispatch and the file never appears
 *  (dispatched, not executed). */
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
