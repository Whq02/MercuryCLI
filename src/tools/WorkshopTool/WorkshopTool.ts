// ============================================================================
//  Workshop tool — persistent typed code cells.
//
//  A session-owned JS/TS runtime with retained state: cells share a vm
//  context across calls (top-level await supported), stream output, spill
//  big output to artifacts, and reach the NORMAL tool surface through the
//  mercury.* bridge — every nested call runs the owned tool transaction
//  with the SAME permission path as a direct call (nothing rides the cell's
//  approval), and nested Workshop calls are refused by construction.
//
//  Additive by doctrine: primitives stay visible — Workshop earns use for
//  multi-step analysis, retained data transforms, and programmatic tool
//  composition, not as a wrapper for single calls.
// ============================================================================

import { z } from 'zod/v4'
import { buildTool, findToolByName, type ToolUseContext } from '../../Tool.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import {
  DEFAULT_CELL_TIMEOUT_MS,
  MAX_CELL_TIMEOUT_MS,
  workshopEnabled,
  type WorkshopCellResult,
} from '../../services/workshop/contracts.js'
import {
  resetWorkshopRuntime,
  runWorkshopCell,
  type WorkshopBridge,
} from '../../services/workshop/runtime.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'

export const WORKSHOP_TOOL_NAME = 'Workshop' as const

const cellSchema = () =>
  z.strictObject({
    language: z
      .enum(['js', 'ts', 'py'])
      .describe('Cell language (ts needs a workspace typescript package; py needs python3 on PATH)'),
    title: z.string().max(120).optional().describe('Short cell title for the transcript'),
    code: z.string().min(1).describe('The cell body. State persists across cells and Workshop calls.'),
    timeoutMs: semanticNumber(
      z.number().int().min(100).max(MAX_CELL_TIMEOUT_MS).optional(),
    ).describe(`Active-runtime budget per cell (default ${DEFAULT_CELL_TIMEOUT_MS}ms; nested tool/agent waits pause it)`),
    reset: semanticBoolean(z.boolean().optional()).describe(
      'true = discard this language runtime\'s retained state BEFORE running this cell (explicit, visible)',
    ),
  })

const inputSchema = lazySchema(() =>
  z.strictObject({
    cells: z.array(cellSchema()).min(1).max(10).describe('Cells run in order on the owning runtime'),
  }),
)
type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  cells: WorkshopCellResult[]
  result: string
}

function renderCellText(cell: WorkshopCellResult): string {
  const head =
    `[${cell.cellId}] ${cell.state}` +
    ` · ${cell.durationMs}ms · gen ${cell.generation}` +
    (cell.title ? ` · ${cell.title}` : '') +
    (cell.compiler ? ` · ${cell.compiler}` : '') +
    (cell.nestedCalls > 0 ? ` · ${cell.nestedCalls} bridge call(s)` : '')
  const lines: string[] = [head]
  if (cell.runtimeKilled) {
    lines.push('RUNTIME KILLED — retained state was lost; the next cell starts a fresh generation.')
  }
  if (cell.error) lines.push(`error: ${cell.error}`)
  if (cell.valuePreview) lines.push(`value: ${cell.valuePreview}`)
  for (const d of cell.displays) {
    lines.push(`display[${d.kind}]: ${d.value.length > 2000 ? d.value.slice(0, 2000) + '…' : d.value}`)
  }
  if (cell.outputTail.length > 0) {
    lines.push('output:', ...cell.outputTail.map(l => `  ${l}`))
  }
  if (cell.artifactRef) {
    lines.push(`full output: ${cell.artifactRef}`)
  }
  return lines.join('\n')
}

export const WorkshopTool = buildTool({
  name: WORKSHOP_TOOL_NAME,
  searchHint:
    'persistent JS/TS code cells with retained state, tool/agent composition (mercury.tool, mercury.agent, mercury.inspect)',
  maxResultSizeChars: 100_000,
  strict: true,
  isEnabled() {
    return workshopEnabled()
  },
  async description() {
    return 'Run persistent JavaScript/TypeScript analysis cells with retained state'
  },
  async prompt() {
    return `Run code cells on a persistent session-owned JS/TS runtime. State persists ACROSS cells and Workshop calls (top-level var/let/const/class/function; in cells using top-level await, simple "const x = …" bindings persist — complex patterns stay cell-local). Use Workshop for multi-step analysis, retained data transforms, and programmatic tool composition; keep single file reads/edits on the primitive tools.

Each cell: { language: "js"|"ts"|"py", code, title?, timeoutMs?, reset? }. ts needs a workspace typescript package (Mercury does not bundle a compiler — an absent one refuses honestly). py needs python3 on PATH (absent ⇒ honest refusal; no packages are ever auto-installed; interactive stdin raises). require() resolves from the session cwd and re-reads changed local files on later cells (dynamic import() stays cached). One cell runs at a time per runtime; later cells queue. A JS/TS timeout or cancel TERMINATES the runtime — retained state is lost and reported, never silently; a py cancel INTERRUPTS first (KeyboardInterrupt — state retained) and kills only if the interrupt does not land within 2s. reset: true discards state explicitly.

The bridge (inside cells):
· await mercury.tool(name, input) — run any normal tool through the standard permission path (nested Workshop calls are refused)
· await mercury.agent(input) — delegate to the Agent tool (same input shape); the result includes the structured envelope
· await mercury.inspect(ref) — read a mercury:// resource
· mercury.display(value) — structured display (text/markdown/json/table/ref detected by shape)
· mercury.parallel(thunks) / mercury.pipeline(items, ...stages) — in-cell composition helpers

Output streams to a bounded tail; large output spills to an artifact ref. The last expression's value is the cell value.`
  },
  userFacingName() {
    return 'Workshop'
  },
  getToolUseSummary(input?: Partial<Input>) {
    const cells = Array.isArray(input?.cells) ? input.cells : []
    const first = cells[0]
    return first?.title ?? `${cells.length} ${first?.language ?? ''} cell(s)`
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false
  },
  async checkPermissions(input: Input) {
    // Executing arbitrary code is Bash-class: always a human/rule decision.
    const preview = input.cells[0]?.code.split('\n')[0]?.slice(0, 80) ?? ''
    return {
      behavior: 'ask' as const,
      message: `Workshop: run ${input.cells.length} ${input.cells.map(c => c.language).join('/')} cell(s) — ${preview}`,
    }
  },
  toAutoClassifierInput(input: Input) {
    return Array.isArray(input.cells) ? input.cells.map(c => c?.code ?? '').join('\n').slice(0, 2000) : ''
  },
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // HZ7 projection: the renderer paints each cell's output tail (and the
  // aggregate result) — search indexes the same.
  extractSearchText({ cells, result }: Output) {
    const parts = cells.flatMap(c => [c.title ?? '', ...(c.outputTail ?? [])])
    if (result) parts.push(result)
    return parts.filter(Boolean).join('\n')
  },
  async call(input: Input, context: ToolUseContext, canUseTool, parentMessage) {
    const owner = ownerFromToolUseContext(context)
    const cwd = getCwd()
    const startedAt = Date.now()

    // The bridge: nested calls run the REAL owned tool transaction with the
    // SAME canUseTool — permissions resolve exactly like a direct call.
    let bridgeSeq = 0
    const runNestedTool = async (name: string, nestedInput: unknown): Promise<string> => {
      if (name === WORKSHOP_TOOL_NAME) {
        throw new Error('recursive Workshop calls are refused — compose within the current cell')
      }
      const tools = context.options.tools
      const tool = findToolByName(tools, name)
      if (!tool) {
        throw new Error(`no tool '${name}' in this session's catalog`)
      }
      const { runToolUse } = await import('../../services/tools/toolExecution.js')
      const toolUseId = `toolu_workshop_${++bridgeSeq}`
      let resultText = ''
      let isError = false
      for await (const update of runToolUse(
        { type: 'tool_use', id: toolUseId, name, input: nestedInput } as never,
        (parentMessage ?? {
          uuid: 'workshop-parent',
          requestId: 'workshop-req',
          message: { id: 'workshop-msg' },
        }) as never,
        canUseTool as never,
        context as never,
      )) {
        const message = (update as { message?: { message?: { content?: unknown } } }).message
        const content = message?.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; content?: unknown; is_error?: boolean }
            if (b.type === 'tool_result') {
              isError = b.is_error === true
              resultText =
                typeof b.content === 'string'
                  ? b.content
                  : Array.isArray(b.content)
                    ? (b.content as { type?: string; text?: string }[])
                        .filter(x => x.type === 'text')
                        .map(x => x.text ?? '')
                        .join('\n')
                    : JSON.stringify(b.content)
            }
          }
        }
      }
      if (isError) throw new Error(resultText || `tool '${name}' failed`)
      return resultText
    }

    const bridge: WorkshopBridge = {
      inspect: async ref => {
        const { InspectTool } = await import('../InspectTool/InspectTool.js')
        const result = await (InspectTool as { call: Function }).call({ ref }, context)
        return String(result.data.result)
      },
      tool: runNestedTool,
      agent: async agentInput => {
        const { AGENT_TOOL_NAME } = await import('../AgentTool/constants.js')
        return runNestedTool(AGENT_TOOL_NAME, agentInput)
      },
    }

    const cells: WorkshopCellResult[] = []
    for (const cell of input.cells) {
      let result: WorkshopCellResult
      if (cell.language === 'py') {
        const { resetPythonRuntime, runPythonCell } = await import(
          '../../services/workshop/pythonRuntime.js'
        )
        if (cell.reset) await resetPythonRuntime(owner)
        result = await runPythonCell({
          owner,
          cwd,
          cell: { ...cell, reset: false },
          bridge,
          signal: context.abortController.signal,
        })
      } else {
        if (cell.reset) resetWorkshopRuntime(owner, cell.language)
        result = await runWorkshopCell({
          owner,
          cwd,
          cell: { ...cell, reset: false },
          bridge,
          signal: context.abortController.signal,
        })
      }
      cells.push(result)
      if (result.state === 'cancelled') break
    }

    const rendered = cells.map(renderCellText).join('\n\n')
    const anyFailed = cells.some(c => c.state === 'failed' || c.state === 'timed-out')
    const cancelled = cells.some(c => c.state === 'cancelled')
    return {
      data: { cells, result: rendered },
      effect: {
        outcome: cancelled || anyFailed ? ('failed' as const) : ('succeeded' as const),
        operation: 'workshop.cell',
        changedPaths: [],
        evidence: `${cells.length} cell(s): ${cells.map(c => c.state).join(', ')} · ${cells.reduce((n, c) => n + c.nestedCalls, 0)} bridge call(s)`,
        startedAt,
        completedAt: Date.now(),
        details: { cellIds: cells.map(c => c.cellId) },
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: output.result,
    }
  },
})
