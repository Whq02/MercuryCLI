
import { readFileSync } from 'node:fs'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { evalCodePermission } from '../../utils/permissions/shellProtectedPaths.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { modelReceivesImageBlocks } from '../../utils/model/capabilities.js'
import { getEngineModel } from '../../utils/model/model.js'
import {
  evalEnabled,
  EVAL_DEFAULT_TIMEOUT_SECONDS,
  EVAL_MAX_DISPLAY_CHARS,
  EVAL_MAX_TIMEOUT_SECONDS,
  type EvalCellOutcome,
  type EvalLanguage,
} from '../../services/eval/contracts.js'
import { evalAvailability } from '../../services/eval/interpreters.js'
import { evalKernelManager } from '../../services/eval/kernelManager.js'
import { makeEvalBridgeServer, type BridgeScreenshot } from '../../services/eval/evalBridge.js'
import type { EvalToolProgress } from '../../types/tools.js'
import { EVAL_TOOL_NAME } from './constants.js'
import { buildEvalPrompt, EVAL_DESCRIPTION } from './prompt.js'
import {
  renderEvalProgressMessage,
  renderEvalRejectedMessage,
  renderEvalResultMessage,
  renderEvalToolUseMessage,
} from './UI.js'

const inputSchema = () => {
  return z.strictObject({
    language: z.enum(['py', 'js']).describe('The retained runtime this cell runs in.'),
    code: z.string().min(1).describe('The cell source. State persists to your next cell in this language.'),
    title: z.string().optional().describe('Short human title for the cell card.'),
    timeoutSeconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`Runtime budget in seconds: default ${EVAL_DEFAULT_TIMEOUT_SECONDS}, at most ${EVAL_MAX_TIMEOUT_SECONDS} (a larger value runs at ${EVAL_MAX_TIMEOUT_SECONDS} and the result says so); 0 disables; bridge and permission time never counts.`),
    reset: z.boolean().optional().describe("Recreate this language's kernel first (the other language keeps its state)."),
  })
}
type InputSchema = ReturnType<typeof inputSchema>
type EvalToolInput = z.infer<InputSchema>

export type EvalToolOutput = EvalCellOutcome & { language: EvalLanguage; title?: string; screenshot?: BridgeScreenshot; bridgeTools?: { calls: number; elapsedMs: number } }

const PROGRESS_THROTTLE_MS = 300
const RUNNING_TICK_MS = 1000

function composeResultText(output: EvalToolOutput): string {
  const parts: string[] = []
  if (output.status !== 'ok') parts.push(`[cell ${output.status}]`)
  if (output.stdout.text.trim()) parts.push(output.stdout.text)
  if (output.stderr.text.trim()) parts.push(`[stderr]\n${output.stderr.text}`)
  for (const display of output.displays) {
    if (display.mime === 'text/plain' || display.mime === 'text/markdown' || display.mime === 'application/json') {
      const mark = display.data.length > EVAL_MAX_DISPLAY_CHARS
        ? `\n… [display cut: ${display.data.length} chars, the first ${EVAL_MAX_DISPLAY_CHARS} shown]`
        : ''
      parts.push(`${display.mime === 'application/json' ? '[json]\n' : ''}${display.data.slice(0, EVAL_MAX_DISPLAY_CHARS)}${mark}`)
    }
  }
  if (output.resultRepr) parts.push(`⇒ ${output.resultRepr}`)
  if (output.error) {
    parts.push(
      `${output.error.name}: ${output.error.value}${output.error.traceback ? `\n${output.error.traceback}` : ''}`,
    )
  }
  for (const sample of output.samples ?? []) {
    parts.push(`[sample] ${sample.title} v${sample.version} → ${sample.url}${sample.ask ? ` · asked: ${sample.ask}` : ''}`)
  }
  for (const note of output.annotations) parts.push(`[note] ${note}`)
  if (output.bridgeTools && output.bridgeTools.calls > 0) parts.push(`[Bridge tools: ${output.bridgeTools.calls} calls; ${(output.bridgeTools.elapsedMs / 1000).toFixed(2)}s total tool-call time, including permission waits.]`)
  if (parts.length === 0) parts.push('(the cell produced no output)')
  return parts.join('\n')
}

function screenshotImageOf(screenshot: BridgeScreenshot | undefined): { mediaType: 'image/png' | 'image/jpeg'; data: string } | null {
  if (screenshot === undefined || !modelReceivesImageBlocks(getEngineModel())) return null
  try {
    const bytes = readFileSync(screenshot.inlinePath ?? screenshot.imagePath)
    const mediaType = screenshot.inlinePath !== undefined && screenshot.inlineMediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    return { mediaType, data: bytes.toString('base64') }
  } catch {
    return null
  }
}

const evalToolDef = buildTool({
  name: EVAL_TOOL_NAME,
  searchHint: 'run python or javascript in a persistent kernel with tool re-entry and samples',
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
    const floor = await evalCodePermission(input.code, getCwd())
    if (floor) return floor
    const message = `Run a ${input.language} cell${input.title ? ` — ${input.title}` : ''}`
    return { behavior: 'passthrough' as const, message, decisionReason: { type: 'other' as const, reason: message } }
  },
  async preparePermissionMatcher(input: EvalToolInput) {
    return (rulePattern: string) => rulePattern === '*' || rulePattern === input.language
  },
  async description() {
    return EVAL_DESCRIPTION
  },
  async prompt(options) {
    return buildEvalPrompt(options?.tools)
  },
  wireDescription(fullPrompt: string) {
    const languages = fullPrompt.split('Languages in this session:\n')[1]?.split('\n\n')[0] ?? ''
    return `Run computation in a retained py or js runtime: data, numbers, plots or tool results that code must combine. Use Bash/Read/Edit directly for shell commands, builds, tests and ordinary file work. One call is one cell, ordered within a message; state is per agent/language/cwd, reaped after 15 minutes idle.
${languages}
JS has top-level await; Python helpers are synchronous. Helpers: tool.Name (JS object, Python keywords), tool.attempt, agent, completion, parallel, pipeline, display/display_markdown/display_json/display_image, read_file/write_file, env. Tool calls keep all permissions; never retry a denial. Bash returns {code,stdout,stderr}, nonzero is a value; stdout is the full interleaved capture. JS read_file needs await.${fullPrompt.includes('sample({name') ? ' sample publishes only on an operator ask.' : ''}
JS declarations/imports persist; module/exports/__dirname/__filename/import.meta are absent. An ordinary throw keeps prior bindings; cancellation keeps Python state but resets JS. timeoutSeconds excludes bridge/permission time; cut output names its full file. Full helper signatures and sample formats arrive on discovery or first use.`
  },
  getActivityDescription(input?: Partial<EvalToolInput>) {
    return input?.language ? `Running a ${input.language} cell` : 'Running an eval cell'
  },
  async call(input: EvalToolInput, context: ToolUseContext, canUseTool, _parent, onProgress) {
    const toolUseId = context.toolUseId ?? 'eval'
    const owner = String(ownerFromToolUseContext(context))
    const cwd = getCwd()

    const cellAbort = new AbortController()
    const onSessionAbort = (): void => cellAbort.abort()
    context.abortController.signal.addEventListener('abort', onSessionAbort, { once: true })

    const emit = (data: EvalToolProgress): void => {
      onProgress?.({ toolUseID: toolUseId, data })
    }
    let screenshot: BridgeScreenshot | undefined
    const bridgeCalls = new Map<string, { started: number; elapsed?: number }>()
    const serveBridge = makeEvalBridgeServer({
      owner: ownerFromToolUseContext(context),
      context,
      canUseTool: canUseTool as never,
      cellAbort,
      onNested: message => {
        const now = performance.now()
        const blocks = message.message.content
        if (Array.isArray(blocks)) for (const block of blocks) {
          if (block.type === 'tool_use' && !bridgeCalls.has(block.id)) bridgeCalls.set(block.id, { started: now })
          if (block.type === 'tool_result') {
            const call = bridgeCalls.get(block.tool_use_id)
            if (call && call.elapsed === undefined) call.elapsed = now - call.started
          }
        }
        emit({ type: 'eval_progress', kind: 'nested', message })
      },
      onScreenshot: captured => {
        screenshot = captured
      },
    })

    let pendingTail = ''
    let pendingStream: 'stdout' | 'stderr' = 'stdout'
    let lastEmit = 0
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let lastOutputLine = ''
    const flushTail = (): void => {
      if (!pendingTail) return
      const tail = pendingTail.slice(-2_000)
      lastOutputLine = tail.trimEnd().split('\n').at(-1) ?? ''
      emit({
        type: 'eval_progress',
        kind: 'output',
        stream: pendingStream,
        tail,
        language: input.language,
        ...(input.title ? { title: input.title } : {}),
      })
      lastEmit = Date.now()
      pendingTail = ''
    }
    let runningTimer: ReturnType<typeof setInterval> | null = null
    const onCellStarted = ({ budgetMs }: { budgetMs: number | null }): void => {
      const startedAt = Date.now()
      const tick = (): void =>
        emit({
          type: 'eval_progress',
          kind: 'running',
          elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
          ...(budgetMs !== null ? { budgetMs } : {}),
          ...(lastOutputLine !== '' ? { tail: lastOutputLine } : {}),
          language: input.language,
          ...(input.title ? { title: input.title } : {}),
        })
      tick()
      runningTimer = setInterval(tick, RUNNING_TICK_MS)
      runningTimer.unref?.()
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
        onCellStarted,
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
        bridgeTools: { calls: bridgeCalls.size, elapsedMs: Math.round([...bridgeCalls.values()].reduce((sum, call) => sum + (call.elapsed ?? performance.now() - call.started), 0)) },
        language: input.language,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(screenshot !== undefined ? { screenshot } : {}),
      }
      return { data }
    } finally {
      if (flushTimer) clearTimeout(flushTimer)
      if (runningTimer) clearInterval(runningTimer)
      context.abortController.signal.removeEventListener('abort', onSessionAbort)
      cellAbort.abort()
    }
  },
  mapToolResultToToolResultBlockParam(output: EvalToolOutput, toolUseID) {
    const text = composeResultText(output)
    const images = output.displays.filter(
      d => (d.mime === 'image/png' || d.mime === 'image/jpeg') && d.b64 === true,
    ).map(image => ({ mediaType: image.mime as 'image/png' | 'image/jpeg', data: image.data }))
    const screenshot = screenshotImageOf(output.screenshot)
    if (screenshot !== null) images.unshift(screenshot)
    if (images.length === 0) {
      return { tool_use_id: toolUseID, type: 'tool_result', content: text, ...(output.status !== 'ok' ? { is_error: true } : {}) }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      ...(output.status !== 'ok' ? { is_error: true } : {}),
      content: [
        { type: 'text' as const, text },
        ...images.map(image => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: image.mediaType,
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

Object.defineProperty(evalToolDef, 'inputSchema', {
  get: inputSchema,
  enumerable: true,
  configurable: true,
})

export const EvalTool = evalToolDef
