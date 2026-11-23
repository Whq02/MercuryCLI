import type { ToolEffectOutcome } from '../../kit/tool.js'
import { z } from 'zod/v4'
import { lazySchema } from '../../../platform/primitives/lazySchema.js'
import { semanticBoolean } from '../../kit/semanticBoolean.js'
import { semanticNumber } from '../../kit/semanticNumber.js'

const OPS = [
  'launch',
  'breakpoints',
  'threads',
  'stack',
  'scopes',
  'variables',
  'evaluate',
  'continue',
  'next',
  'stepIn',
  'stepOut',
  'pause',
  'output',
  'status',
  'disconnect',
  'loadedSources',
  'modules',
  'exceptionBreakpoints',
  'source',
  'completions',
  'setVariable',
  'attach',
  'functionBreakpoints',
  'disassemble',
  'readMemory',
  'dataBreakpoints',
  'instructionBreakpoints',
  'writeMemory',
  'restart',
  'customRequest',
] as const

export const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(OPS).describe('Debug operation.'),
    session: z
      .string()
      .optional()
      .describe('Session name (default "main"; re-launch replaces it)'),
    adapter: z
      .string()
      .optional()
      .describe('launch/attach: adapter key (default inferred from extension)'),
    program: z.string().optional().describe('launch/attach: target program'),
    args: z.array(z.string()).optional().describe('launch: argv'),
    stopOnEntry: semanticBoolean(z.boolean().optional()).describe('launch: stop at first instruction'),
    timeoutMs: semanticNumber(z.number().positive().optional()).describe('Stop wait in ms (default 10000, uncapped)'),
    file: z.string().optional().describe('breakpoints: source file'),
    lines: z.array(semanticNumber(z.number().int().positive())).optional().describe('breakpoints: replaces file lines across sessions; [] clears'),
    breakpoints: z
      .array(
        z.strictObject({
          line: semanticNumber(z.number().int().positive()),
          condition: z.string().optional().describe('Break expression'),
          hitCondition: z.string().optional().describe('Hit count ("3")'),
          logMessage: z.string().optional().describe('Logpoint message (no stop)'),
        }),
      )
      .optional()
      .describe('breakpoints: conditional/hit/logpoint rows instead of lines; replaces file set across sessions; [] clears'),
    pid: semanticNumber(z.number().int().positive().optional()).describe('attach: process id'),
    port: semanticNumber(z.number().int().positive().max(65_535).optional()).describe('attach: debug port (alone implies python)'),
    host: z.string().optional().describe('attach: default 127.0.0.1'),
    method: z.string().optional().describe('customRequest: verbatim DAP command'),
    body: z.string().optional().describe('customRequest: JSON arguments string'),
    functions: z
      .array(
        z.union([
          z.string(),
          z.strictObject({
            name: z.string(),
            condition: z.string().optional(),
            hitCondition: z.string().optional(),
          }),
        ]),
      )
      .optional()
      .describe('functionBreakpoints: names, or {name, condition?, hitCondition?} rows; the set reaches every session of the tree and a child session started later, and [] clears it everywhere'),
    dataBreakpoints: z
      .array(
        z.strictObject({
          name: z.string().describe('Variable to watch'),
          variablesReference: semanticNumber(z.number().int().optional()).describe('Scope/container ref (from scopes/variables)'),
          frameId: semanticNumber(z.number().int().optional()).describe('Frame for expression-style names'),
          accessType: z.enum(['read', 'write', 'readWrite']).optional().describe('Default "write"'),
          condition: z.string().optional(),
          hitCondition: z.string().optional(),
        }),
      )
      .optional()
      .describe('dataBreakpoints: replaces watched set; [] clears'),
    instructionBreakpoints: z
      .array(
        z.strictObject({
          instructionReference: z.string().describe('Frame [ip …] or disassemble address'),
          offset: semanticNumber(z.number().int().optional()).describe('Byte offset'),
          condition: z.string().optional(),
          hitCondition: z.string().optional(),
        }),
      )
      .optional()
      .describe('instructionBreakpoints: replaces set; [] clears'),
    memoryReference: z.string().optional().describe('disassemble/readMemory/writeMemory: frame [ip …] or variable [memory …]'),
    count: semanticNumber(z.number().int().positive().optional()).describe('readMemory: bytes (≤4096)'),
    offset: semanticNumber(z.number().int().optional()).describe('disassemble/readMemory/writeMemory: byte offset'),
    data: z.string().optional().describe('writeMemory: base64 bytes'),
    allowPartial: semanticBoolean(z.boolean().optional()).describe('writeMemory: allow partial write'),
    instructionCount: semanticNumber(z.number().int().positive().optional()).describe('disassemble: instructions (default 16, ≤64)'),
    granularity: z
      .enum(['statement', 'instruction'])
      .optional()
      .describe('next/stepIn: default "statement"'),
    threadId: semanticNumber(z.number().int().optional()).describe('stack/continue/step/pause thread (default stopped thread)'),
    frameId: semanticNumber(z.number().int().optional()).describe('scopes/evaluate/completions frame; evaluate defaults to the top frame of the thread that stopped last'),
    depth: semanticNumber(z.number().int().positive().optional()).describe('stack: number of frames to return (default 20)'),
    variablesReference: semanticNumber(z.number().int().optional()).describe('variables/setVariable: container ref from scopes/variables/evaluate'),
    expression: z.string().optional().describe('evaluate: expression in debuggee'),
    context: z
      .enum(['repl', 'watch', 'hover', 'clipboard', 'variables'])
      .optional()
      .describe('evaluate: default "repl"; "watch" for a side-effect-free read, "hover" for a symbol under the cursor, "clipboard" for a copyable value, "variables" for a variables-view value'),
    filters: z
      .array(z.string())
      .optional()
      .describe('exceptionBreakpoints: filter ids to arm (omit to list)'),
    sourceReference: semanticNumber(z.number().int().optional()).describe('source: sourceReference (>0) from stack/loadedSources'),
    name: z.string().optional().describe('setVariable: variable name in variablesReference'),
    value: z.string().optional().describe('setVariable: new value expression'),
    text: z.string().optional().describe('completions: partial expression'),
  }),
)

export type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  op: Input['op']
  result: string
  outcome: ToolEffectOutcome
  debuggee?: 'stopped' | 'running' | 'terminated'
}

export type OpResult = {
  result: string
  outcome: ToolEffectOutcome
  debuggee?: 'stopped' | 'running' | 'terminated'
  details?: Record<string, unknown>
}

export type InputWith<K extends keyof Input> = Input & { [P in K]-?: NonNullable<Input[P]> }
