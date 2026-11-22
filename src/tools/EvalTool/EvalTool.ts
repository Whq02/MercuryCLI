import { readFileSync } from 'node:fs'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { evalCodePermission } from '../../utils/permissions/shellProtectedPaths.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { modelReceivesImageBlocks } from '../../utils/model/capabilities.js'
import { getEngineModel } from '../../services/model/model.js'
import { EVAL_IDLE_TTL_MS,
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
import { buildEvalPrompt, EVAL_DESCRIPTION, SAMPLE_PROMPT_LINES } from './prompt.js'
import {
  renderEvalProgressMessage,
  renderEvalRejectedMessage,
  renderEvalResultMessage,
  renderEvalToolUseMessage,
} from './UI.js'
import { errorMessage } from '../../utils/errors.js'
import { startInterval, startTimeout, stopInterval, stopTimeout } from '../../utils/timers.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

const inputSchema = () => {
  return z.strictObject({
    language: z.enum(['py', 'js']).describe('The retained runtime this cell runs in.'),
    code: z.string().min(1).describe('The cell source.'),
    title: z.string().optional().describe('Short human title for the cell card.'),
    timeoutSeconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`Runtime budget in seconds: default ${EVAL_DEFAULT_TIMEOUT_SECONDS}, at most ${EVAL_MAX_TIMEOUT_SECONDS}; 0 disables; time inside tool calls and permission waits never counts.`),
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

function screenshotImageOf(
  screenshot: BridgeScreenshot | undefined,
): { ok: true; mediaType: 'image/png' | 'image/jpeg'; data: string } | { ok: false; note: string } | null {
  if (screenshot === undefined || !modelReceivesImageBlocks(getEngineModel())) return null
  const path = screenshot.inlinePath ?? screenshot.imagePath
  try {
    const bytes = readFileSync(path)
    const mediaType = screenshot.inlinePath !== undefined && screenshot.inlineMediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    return { ok: true, mediaType, data: bytes.toString('base64') }
  } catch (error) {
    return { ok: false, note: `(image not inlined — could not read ${path} (${errorMessage(error)}))` }
  }
}

const evalToolDef: Unbuilt = unbuilt('src/tools/EvalTool/EvalTool.ts:97')

Object.defineProperty(evalToolDef, 'inputSchema', {
  get: inputSchema,
  enumerable: true,
  configurable: true,
})

export const EvalTool = evalToolDef
