#!/usr/bin/env bun
// ============================================================================
//  prove-tool-contracts — model & tool contracts are single-source and
//  self-repairing:
//
//   1. The Agent tool's public model contract is the canonical
//      AGENT_DISPATCH_MODELS list: it accepts every alias the runtime
//      genuinely resolves for dispatch (fable + the 1M forms) and REJECTS
//      'haiku' at the schema (the runtime never-Haiku floor stays as defence
//      for legacy configs that bypass the public schema).
//   2. Model-facing scalar inputs tolerate quoted booleans/numbers via
//      semanticBoolean/semanticNumber — bounds, defaults and API schema
//      types preserved; malformed values still fail.
//   3. formatZodValidationError turns invalid_value / too_small / too_big /
//      custom issues into actionable prose — never raw Zod issue JSON.
// ============================================================================

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// —— 1. Agent dispatch model contract ————————————————————————————————
const aliases = await import('../../src/utils/model/aliases.ts')
t(
  'AGENT_DISPATCH_MODELS is the canonical list',
  Array.isArray(aliases.AGENT_DISPATCH_MODELS) &&
    ['sonnet', 'opus', 'fable', 'fable51', 'sonnet[1m]', 'opus[1m]', 'fable[1m]'].every(
      m => (aliases.AGENT_DISPATCH_MODELS as readonly string[]).includes(m),
    ),
)
t(
  'haiku is not in the dispatch list',
  !(aliases.AGENT_DISPATCH_MODELS as readonly string[] | undefined)?.includes(
    'haiku',
  ),
)

const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const agentSchema = AgentTool.inputSchema
const agentBase = { description: 'test', prompt: 'test' }
for (const m of [
  'sonnet',
  'opus',
  'fable',
  'fable51',
  'sonnet[1m]',
  'opus[1m]',
  'fable[1m]',
]) {
  t(
    `Agent schema accepts model '${m}'`,
    agentSchema.safeParse({ ...agentBase, model: m }).success === true,
  )
}
t(
  'Agent schema REJECTS haiku at the public contract',
  agentSchema.safeParse({ ...agentBase, model: 'haiku' }).success === false,
)

// RE-POINTED (the multiauth mandate): the picker road now
// rides getAgentModelPickerRows — THE ONE catalogue owner's agent
// projection (getModelOptions), provider-neutral in the catalogue's own
// order; the old static alias list (getAgentModelOptions) retired with it.
// The live catalogue spells its 1M rows as full ids, so the 1M pin asserts
// the CAPABILITY (some [1m] row offered), not one family's alias spelling.
process.env['MERCURY_CONFIG_DIR'] ??= (await import('node:fs')).mkdtempSync(
  (await import('node:path')).join((await import('node:os')).tmpdir(), 'tool-contracts-'),
)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getAgentModelPickerRows } = await import('../../src/utils/model/agentModelPicker.ts')
const { isHaikuTier } = await import('../../src/utils/model/modelFloor.ts')
const options = getAgentModelPickerRows()
t(
  'picker offers fable',
  options.some(o => o.value === 'fable'),
)
t(
  'picker offers 1M-context forms',
  options.some(o => o.value.endsWith('[1m]')),
)
t(
  'picker never offers a haiku-tier row (the floor never silently rewrites a pick)',
  options.every(o => !isHaikuTier(o.value)),
)
t(
  'picker leads with inherit (the agent grammar\'s own default)',
  options[0]?.value === 'inherit',
)

// The floor stays as runtime defence (legacy agent-def pins, env overrides).
const { getAgentModelWithFloorNote } = await import(
  '../../src/utils/model/agent.ts'
)
const floored = getAgentModelWithFloorNote(
  'haiku',
  'claude-opus-4-8',
  undefined,
  'default',
)
t(
  'runtime never-Haiku floor still guards legacy agent-def pins',
  !/haiku/i.test(floored.model) && !!floored.flooredFrom,
  `resolved=${floored.model} from=${floored.flooredFrom ?? 'unset'}`,
)

// —— 2. semantic scalars on model-facing inputs ————————————————————————
t(
  "Agent run_in_background accepts quoted 'true'",
  agentSchema.safeParse({ ...agentBase, run_in_background: 'true' }).success ===
    true,
)
t(
  'Agent run_in_background still rejects garbage',
  agentSchema.safeParse({ ...agentBase, run_in_background: 'yes' }).success ===
    false,
)

const { TaskOutputTool } = await import(
  '../../src/tools/TaskOutputTool/TaskOutputTool.tsx'
)
{
  const r = TaskOutputTool.inputSchema.safeParse({
    task_id: 'x',
    timeout: '5000',
  })
  t(
    'TaskOutput timeout accepts a quoted number',
    r.success === true && (r as { data?: { timeout?: number } }).data?.timeout === 5000,
  )
  t(
    'TaskOutput timeout keeps its 600000 bound',
    TaskOutputTool.inputSchema.safeParse({ task_id: 'x', timeout: '900000' })
      .success === false,
  )
}

const { SleepTool } = await import('../../src/tools/SleepTool/SleepTool.tsx')
{
  const r = SleepTool.inputSchema.safeParse({ seconds: '30' })
  t(
    'Sleep seconds accepts a quoted number',
    r.success === true && (r as { data?: { seconds?: number } }).data?.seconds === 30,
  )
  t(
    'Sleep seconds keeps its positive bound',
    SleepTool.inputSchema.safeParse({ seconds: '-5' }).success === false,
  )
}

const monitorModule = await import('../../src/tools/MonitorTool/MonitorTool.ts')
{
  const MonitorTool = monitorModule.MonitorTool as {
    inputSchema: { safeParse: (v: unknown) => { success: boolean } }
  }
  const base = { description: 'watch', command: 'echo hi' }
  t(
    'Monitor timeout_ms accepts a quoted number',
    MonitorTool.inputSchema.safeParse({ ...base, timeout_ms: '60000' })
      .success === true,
  )
  t(
    "Monitor persistent accepts quoted 'true'",
    MonitorTool.inputSchema.safeParse({ ...base, persistent: 'true' })
      .success === true,
  )
  t(
    'Monitor timeout_ms keeps its refine ceiling',
    MonitorTool.inputSchema.safeParse({ ...base, timeout_ms: '99999999' })
      .success === false,
  )
}

const { AskUserQuestionTool } = await import(
  '../../src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx'
)
{
  const q = {
    questions: [
      {
        question: 'Pick?',
        header: 'Pick',
        multiSelect: 'false',
        options: [
          { label: 'a', description: 'a' },
          { label: 'b', description: 'b' },
        ],
      },
    ],
  }
  const r = AskUserQuestionTool.inputSchema.safeParse(q)
  t(
    "AskUserQuestion multiSelect accepts quoted 'false' as false",
    r.success === true &&
      (r as { data?: { questions?: Array<{ multiSelect?: boolean }> } }).data
        ?.questions?.[0]?.multiSelect === false,
  )
}

const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.ts')
{
  const r = DebugTool.inputSchema.safeParse({
    op: 'continue',
    threadId: '3',
  })
  t(
    'Debug threadId accepts a quoted integer',
    r.success === true && (r as { data?: { threadId?: number } }).data?.threadId === 3,
  )
  const r2 = DebugTool.inputSchema.safeParse({
    op: 'launch',
    program: 'x.py',
    stopOnEntry: 'true',
  })
  t(
    "Debug stopOnEntry accepts quoted 'true'",
    r2.success === true &&
      (r2 as { data?: { stopOnEntry?: boolean } }).data?.stopOnEntry === true,
  )
  t(
    'Debug breakpoint lines accept quoted integers',
    DebugTool.inputSchema.safeParse({
      op: 'breakpoints',
      file: 'x.py',
      lines: ['10', 20],
    }).success === true,
  )
}

// —— 3. Zod validation errors are actionable prose ———————————————————
const { formatZodValidationError } = await import(
  '../../src/utils/toolErrors.ts'
)
const { z } = await import('zod/v4')

{
  const schema = z.strictObject({
    mode: z.enum(['fast', 'slow']),
    count: z.number().min(1).max(10),
    name: z.string(),
  })
  const enumErr = schema.safeParse({ mode: 'medium', count: 5, name: 'x' })
  const msg = formatZodValidationError('TestTool', (enumErr as { error: never }).error)
  t(
    'invalid_value names the parameter and allowed values',
    msg.includes('`mode`') && msg.includes('fast') && msg.includes('slow'),
    msg.slice(0, 160),
  )
  t('invalid_value is prose, not raw issue JSON', !msg.includes('"code"'))

  const smallErr = schema.safeParse({ mode: 'fast', count: 0, name: 'x' })
  const smallMsg = formatZodValidationError(
    'TestTool',
    (smallErr as { error: never }).error,
  )
  t(
    'too_small names the parameter and the bound',
    smallMsg.includes('`count`') && smallMsg.includes('1'),
    smallMsg.slice(0, 160),
  )
  t('too_small is prose, not raw issue JSON', !smallMsg.includes('"code"'))

  const bigErr = schema.safeParse({ mode: 'fast', count: 99, name: 'x' })
  const bigMsg = formatZodValidationError(
    'TestTool',
    (bigErr as { error: never }).error,
  )
  t(
    'too_big names the parameter and the bound',
    bigMsg.includes('`count`') && bigMsg.includes('10'),
    bigMsg.slice(0, 160),
  )

  const refined = z
    .strictObject({ timeout_ms: z.number() })
    .refine(v => v.timeout_ms <= 100, {
      message: 'timeout_ms must be ≤ 100',
      path: ['timeout_ms'],
    })
  const customErr = refined.safeParse({ timeout_ms: 200 })
  const customMsg = formatZodValidationError(
    'TestTool',
    (customErr as { error: never }).error,
  )
  t(
    'custom (refine) failures surface their message as prose',
    customMsg.includes('timeout_ms must be ≤ 100') &&
      !customMsg.includes('"code"'),
    customMsg.slice(0, 160),
  )

  const unknownKey = schema.safeParse({
    mode: 'fast',
    count: 5,
    name: 'x',
    bogus: 1,
  })
  const unknownMsg = formatZodValidationError(
    'TestTool',
    (unknownKey as { error: never }).error,
    schema,
  )
  t(
    'unexpected-key errors list the valid top-level parameters',
    unknownMsg.includes('`bogus`') &&
      unknownMsg.includes('mode') &&
      unknownMsg.includes('count'),
    unknownMsg.slice(0, 200),
  )
}

process.exit(failures)
