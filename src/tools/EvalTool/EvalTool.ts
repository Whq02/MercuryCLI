// ============================================================================
//  tools/EvalTool — persistent Python/JS eval cells as a first-class tool.
//
//  One cell per call in a retained per-(owner, language, cwd, interpreter)
//  kernel; in-cell tool re-entry, agent()/parallel()/pipeline()/completion()
//  over the permission-checked bridge (services/eval). The tool's own
//  permission verdict is ASK — running arbitrary code is Bash-class — so
//  the session mode governs it exactly like any other write-classed call:
//  flow/bypass-class modes proceed, ask-class modes ask, rules and the
//  kill-switch apply unchanged.
// ============================================================================

import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import {
  evalEnabled,
  EVAL_MAX_DISPLAY_CHARS,
  type EvalCellOutcome,
  type EvalLanguage,
} from '../../services/eval/contracts.js'
import { evalAvailability } from '../../services/eval/interpreters.js'
import { evalKernelManager } from '../../services/eval/kernelManager.js'
import { makeEvalBridgeServer } from '../../services/eval/evalBridge.js'
import { capLines } from '../../services/eval/outputSink.js'
import type { EvalToolProgress } from '../../types/tools.js'
import { EVAL_TOOL_NAME } from './constants.js'
import { buildEvalPrompt, EVAL_DESCRIPTION } from './prompt.js'
import {
  renderEvalProgressMessage,
  renderEvalRejectedMessage,
  renderEvalResultMessage,
  renderEvalToolUseMessage,
} from './UI.js'

// Rebuilt on every access (not lazySchema-frozen): the LIVE schema
// advertises only languages that would actually run — never a union that
// rejects everything (the fixed upstream edge). The interpreter probe
// behind it is cached briefly, so the rebuild costs microseconds.
const inputSchema = () => {
  const available = evalAvailability(getCwd())
    .filter(a => a.available)
    .map(a => a.language)
  const languages = (available.length > 0 ? available : ['py', 'js']) as [EvalLanguage, ...EvalLanguage[]]
  return z.strictObject({
    language: z.enum(languages).describe('The retained runtime this cell runs in.'),
    code: z.string().min(1).describe('The cell source. State persists to your next cell in this language.'),
    title: z.string().optional().describe('Short human title for the cell card.'),
    timeoutSeconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Runtime budget in seconds (default 30; 0 disables; bridge/permission time never counts).'),
    reset: z.boolean().optional().describe("Recreate this language's kernel first (the other language keeps its state)."),
  })
}
type InputSchema = ReturnType<typeof inputSchema>
type EvalToolInput = z.infer<InputSchema>

export type EvalToolOutput = EvalCellOutcome & { language: EvalLanguage; title?: string }

const PROGRESS_THROTTLE_MS = 300

function composeResultText(output: EvalToolOutput): string {
  const parts: string[] = []
  if (output.status !== 'ok') parts.push(`[cell ${output.status}]`)
  if (output.stdout.text.trim()) parts.push(output.stdout.text)
  if (output.stderr.text.trim()) parts.push(`[stderr]\n${output.stderr.text}`)
  for (const display of output.displays) {
    if (display.mime === 'text/plain' || display.mime === 'text/markdown') {
      parts.push(capLines(display.data.slice(0, EVAL_MAX_DISPLAY_CHARS)))
    } else if (display.mime === 'application/json') {
      parts.push(`[json]\n${display.data.slice(0, EVAL_MAX_DISPLAY_CHARS)}`)
    }
    // Images ride as real image blocks beside this text.
  }
  if (output.resultRepr) parts.push(`⇒ ${output.resultRepr}`)
  if (output.error) {
    parts.push(
      `${output.error.name}: ${output.error.value}${output.error.traceback ? `\n${output.error.traceback}` : ''}`,
    )
  }
  for (const note of output.annotations) parts.push(`[note] ${note}`)
  if (parts.length === 0) parts.push('(the cell produced no output)')
  return parts.join('\n')
}

const evalToolDef = buildTool({
  name: EVAL_TOOL_NAME,
  searchHint: 'run python or javascript in a persistent kernel with tool re-entry',
  maxResultSizeChars: 80_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    if (!evalEnabled()) return false
    return evalAvailability(getCwd()).some(a => a.available)
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isDestructive() {
    return false
  },
  async checkPermissions(input: EvalToolInput) {
    // Arbitrary code is Bash-class: the tool verdict is ASK, and the
    // decision chain around it (rules → mode band) turns that into the
    // session's actual posture — flow/bypass proceed, default asks.
    return {
      behavior: 'ask' as const,
      message: `Run a ${input.language} cell${input.title ? ` — ${input.title}` : ''}`,
    }
  },
  async preparePermissionMatcher(input: EvalToolInput) {
    // Rule content matches the language: Eval(py) / Eval(js) / Eval(*).
    return (rulePattern: string) => rulePattern === '*' || rulePattern === input.language
  },
  toAutoClassifierInput(input: EvalToolInput) {
    return `${input.language}${input.title ? ` ${input.title}` : ''}: ${typeof input.code === 'string' ? input.code.slice(0, 400) : ''}`
  },
  async description() {
    return EVAL_DESCRIPTION
  },
  async prompt() {
    return buildEvalPrompt()
  },
  getActivityDescription(input?: Partial<EvalToolInput>) {
    return input?.language ? `Running a ${input.language} cell` : 'Running an eval cell'
  },
  async call(input: EvalToolInput, context: ToolUseContext, canUseTool, _parent, onProgress) {
    const toolUseId = context.toolUseId ?? 'eval'
    const owner = String(ownerFromToolUseContext(context))
    const cwd = getCwd()

    // The cell-scope abort: session abort propagates in; when the cell
    // settles the scope aborts so dangling bridge work dies with its cell.
    const cellAbort = new AbortController()
    const onSessionAbort = (): void => cellAbort.abort()
    context.abortController.signal.addEventListener('abort', onSessionAbort, { once: true })

    const emit = (data: EvalToolProgress): void => {
      onProgress?.({ toolUseID: toolUseId, data })
    }
    const serveBridge = makeEvalBridgeServer({
      context,
      canUseTool: canUseTool as never,
      cellAbort,
      onNested: message => emit({ type: 'eval_progress', kind: 'nested', message }),
    })

    let pendingTail = ''
    let pendingStream: 'stdout' | 'stderr' = 'stdout'
    let lastEmit = 0
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flushTail = (): void => {
      if (!pendingTail) return
      emit({
        type: 'eval_progress',
        kind: 'output',
        stream: pendingStream,
        tail: pendingTail.slice(-2_000),
        language: input.language,
        ...(input.title ? { title: input.title } : {}),
      })
      lastEmit = Date.now()
      pendingTail = ''
    }

    try {
      const outcome = await evalKernelManager.runCell({
        owner,
        cwd,
        input: {
          language: input.language,
          code: input.code,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
          ...(input.reset !== undefined ? { reset: input.reset } : {}),
        },
        abortSignal: context.abortController.signal,
        serveBridge,
        onLiveOutput: (stream, chunk) => {
          pendingStream = stream
          pendingTail += chunk
          const now = Date.now()
          if (now - lastEmit >= PROGRESS_THROTTLE_MS) flushTail()
          else if (!flushTimer) {
            flushTimer = setTimeout(() => {
              flushTimer = null
              flushTail()
            }, PROGRESS_THROTTLE_MS)
            flushTimer.unref?.()
          }
        },
      })
      flushTail()
      const data: EvalToolOutput = {
        ...outcome,
        language: input.language,
        ...(input.title !== undefined ? { title: input.title } : {}),
      }
      return { data }
    } finally {
      if (flushTimer) clearTimeout(flushTimer)
      context.abortController.signal.removeEventListener('abort', onSessionAbort)
      cellAbort.abort()
    }
  },
  mapToolResultToToolResultBlockParam(output: EvalToolOutput, toolUseID) {
    const text = composeResultText(output)
    const images = output.displays.filter(
      d => (d.mime === 'image/png' || d.mime === 'image/jpeg') && d.b64 === true,
    )
    if (images.length === 0) {
      return { tool_use_id: toolUseID, type: 'tool_result', content: text, ...(output.status === 'error' ? { is_error: true } : {}) }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      ...(output.status === 'error' ? { is_error: true } : {}),
      content: [
        { type: 'text' as const, text },
        ...images.map(image => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: image.mime as 'image/png' | 'image/jpeg',
            data: image.data,
          },
        })),
      ],
    }
  },
  isResultTruncated(output: EvalToolOutput) {
    return output.stdout.truncated || output.stderr.truncated
  },
  renderToolUseMessage: renderEvalToolUseMessage,
  renderToolUseProgressMessage: renderEvalProgressMessage,
  renderToolUseRejectedMessage: renderEvalRejectedMessage,
  renderToolResultMessage: renderEvalResultMessage,
} satisfies ToolDef<InputSchema, EvalToolOutput, EvalToolProgress>)

// buildTool SPREADS its definition, which would materialize the schema
// getter once and freeze the advertised languages; re-installing the getter
// on the built tool keeps the schema LIVE (the language gates and the
// interpreter probe are re-read on every access).
Object.defineProperty(evalToolDef, 'inputSchema', {
  get: inputSchema,
  enumerable: true,
  configurable: true,
})

export const EvalTool = evalToolDef
