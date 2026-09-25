import { z } from 'zod/v4'

import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { type ContextFillView, contextFillView } from '../../utils/contextFill.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { CONTEXT_LEFT_MAX_RESULT_CHARS, CONTEXT_LEFT_TOOL_NAME } from './constants.js'
import { CONTEXT_LEFT_DESCRIPTION, CONTEXT_LEFT_PROMPT, CONTEXT_LEFT_SEARCH_HINT } from './prompt.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

export interface ContextLeftOutput {
  usedTokens: number | null
  usedPct: number | null
  fillSource: ContextFillView['fillSource']
  window: number
  windowSource: ContextFillView['windowSource']
  windowPinned: boolean
  windowReason?: string
  compactAtPct: number | null
  leftUntilCompactPct: number | null
  leftUntilCompactTokens: number | null
  text: string
}

export const CONTEXT_LEFT_UNKNOWN_LINE = 'Context: unknown until the model has answered once; the reply that made this call is the first on record, so call again now for a measured figure.'
export const CONTEXT_LEFT_NO_FOLD_LINE = 'No fold line: autocompact is off, so nothing compacts on its own; the window edge is the limit.'

const WINDOW_SOURCE_WORDS: Record<ContextFillView['windowSource'], string> = {
  'live-current': "the provider's live catalogue",
  'static-pin': 'the pinned window for this model',
  capability: "the model's capability record",
  'suffix-1m': 'the [1m] suffix on the model id',
  'beta-header': 'the 1M context beta header',
  fallback: 'a conservative default, not a figure the provider stated',
}

const FILL_SOURCE_WORDS: Record<'usage' | 'estimate', string> = {
  usage: 'measured on the wire',
  estimate: 'estimated from characters',
}

function count(n: number): string {
  return n.toLocaleString('en-US')
}

export function windowFigure(view: ContextFillView): string {
  return `${view.windowSource === 'fallback' ? '~' : ''}${count(view.window)}`
}

export function windowWords(view: ContextFillView): string {
  const source =
    view.windowSource === 'static-pin' && view.windowPinned
      ? `${WINDOW_SOURCE_WORDS['static-pin']}, awaiting the live figure`
      : WINDOW_SOURCE_WORDS[view.windowSource]
  const reason = view.windowReason ? ` (${view.windowReason})` : ''
  return `${windowFigure(view)} tokens, ${source}${reason}`
}

export function leftUntilCompactTokens(view: ContextFillView): number | null {
  if (view.usedTokens === null || view.compactAtPct === null || view.leftUntilCompactPct === null) return null
  return Math.max(0, Math.round((view.compactAtPct / 100) * view.window) - view.usedTokens)
}

export function contextLeftText(view: ContextFillView): string {
  if (view.usedTokens === null || view.fillSource === null) {
    return `${CONTEXT_LEFT_UNKNOWN_LINE}\nWindow: ${windowWords(view)}.`
  }
  const source = FILL_SOURCE_WORDS[view.fillSource]
  const pct = view.usedPct === null ? '' : ` (${view.usedPct}%)`
  const lines = [
    `Context: ${count(view.usedTokens)} of ${windowFigure(view)} tokens used${pct}, ${source}.`,
    `Window: ${windowWords(view)}.`,
  ]
  const left = leftUntilCompactTokens(view)
  if (left === null || view.leftUntilCompactPct === null) {
    lines.push(CONTEXT_LEFT_NO_FOLD_LINE)
  } else {
    lines.push(`Left until the fold (autocompact): ${count(left)} tokens (${view.leftUntilCompactPct}% of the window), ${source}.`)
  }
  return lines.join('\n')
}

export function contextLeftOutput(view: ContextFillView): ContextLeftOutput {
  return {
    usedTokens: view.usedTokens,
    usedPct: view.usedPct,
    fillSource: view.fillSource,
    window: view.window,
    windowSource: view.windowSource,
    windowPinned: view.windowPinned,
    ...(view.windowReason !== undefined ? { windowReason: view.windowReason } : {}),
    compactAtPct: view.compactAtPct,
    leftUntilCompactPct: view.leftUntilCompactPct,
    leftUntilCompactTokens: leftUntilCompactTokens(view),
    text: contextLeftText(view),
  }
}

export const ContextLeftTool = buildTool({
  name: CONTEXT_LEFT_TOOL_NAME,
  searchHint: CONTEXT_LEFT_SEARCH_HINT,
  shouldDefer: false,
  maxResultSizeChars: CONTEXT_LEFT_MAX_RESULT_CHARS,
  capability: {
    intents: [
      'ask how full the context window is',
      'check the tokens left before the fold',
      'budget a large read or edit against the context window',
    ],
    units: ['resource-inspection'],
    class: 'observation',
    cancellation: 'not-applicable',
    latency: 'fast',
    proof: 'scripts/tools/prove-context-left-tool.ts',
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async checkPermissions(input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  toAutoClassifierInput() {
    return ''
  },
  async description() {
    return CONTEXT_LEFT_DESCRIPTION
  },
  async prompt() {
    return CONTEXT_LEFT_PROMPT
  },
  getActivityDescription() {
    return 'Measuring the context window'
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage(output: ContextLeftOutput | undefined) {
    return typeof output?.text === 'string' ? output.text : ''
  },
  extractSearchText(output: ContextLeftOutput) {
    return typeof output?.text === 'string' ? output.text : ''
  },
  mapToolResultToToolResultBlockParam(output: ContextLeftOutput, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output.text,
    }
  },
  async call(_input, context: ToolUseContext) {
    return { data: contextLeftOutput(contextFillView(context.messages, context.options.mainLoopModel)) }
  },
} satisfies ToolDef<InputSchema, ContextLeftOutput>)
