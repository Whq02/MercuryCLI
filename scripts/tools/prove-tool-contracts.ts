#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const aliases = await import('../../src/utils/model/aliases.ts')
t(
  'AGENT_DISPATCH_MODELS is the canonical list',
  Array.isArray(aliases.AGENT_DISPATCH_MODELS) &&
    ['sonnet', 'opus', 'haiku', 'fable', 'fable51', 'sonnet[1m]', 'opus[1m]', 'fable[1m]'].every(
      m => (aliases.AGENT_DISPATCH_MODELS as readonly string[]).includes(m),
    ),
)

const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const agentSchema = AgentTool.inputSchema
const agentBase = { description: 'test', prompt: 'test' }
for (const m of [
  'sonnet',
  'opus',
  'haiku',
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
const { CANONICAL_MODEL_IDS } = await import('../../src/utils/model/configs.ts')
for (const id of CANONICAL_MODEL_IDS) {
  t(`Agent schema accepts the served id '${id}'`, agentSchema.safeParse({ ...agentBase, model: id }).success === true)
}
for (const id of ['gemini-2.5-pro', 'openrouter/qwen/qwen3-coder', 'huggingface/org/model', 'local/llama3']) {
  t(`Agent schema accepts the exact engine id '${id}' (the dispatch grammar validates it)`, agentSchema.safeParse({ ...agentBase, model: id }).success === true)
}
const { unrecognisedModelWordRefusal } = await import('../../src/utils/swarm/engineDispatch.ts')
const { modelFamilyWords } = await import('../../src/utils/model/modelFamilies.ts')
t('the dispatch grammar refuses a word no family declares, naming it', (unrecognisedModelWordRefusal('banana') ?? '').includes("'banana'"))
t('the dispatch grammar admits a served first-party id', unrecognisedModelWordRefusal('claude-haiku-4-5') === null)
t('the dispatch grammar admits every family word', modelFamilyWords().every(word => unrecognisedModelWordRefusal(word) === null))
t('the dispatch grammar admits the engine class aliases and exact engine ids', ['gpt', 'gemini', 'gpt-5.6-sol', 'openrouter/qwen/qwen3-coder'].every(word => unrecognisedModelWordRefusal(word) === null))
const modelDescription = (agentSchema as unknown as { shape: { model: { description?: string } } }).shape.model.description ?? ''
t('the model parameter\'s description enumerates no per-boot id list (prompt-cache stable)', modelDescription.length > 0 && !modelDescription.includes('gpt-5.6-sol') && !modelDescription.includes('glm-5.2'))

process.env['MERCURY_CONFIG_DIR'] ??= (await import('node:fs')).mkdtempSync(
  (await import('node:path')).join((await import('node:os')).tmpdir(), 'tool-contracts-'),
)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getAgentModelPickerRows } = await import('../../src/utils/model/agentModelPicker.ts')
const { getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
const options = getAgentModelPickerRows()
t(
  'picker offers fable',
  options.some(o => o.value === 'fable'),
)
t(
  'picker lists one row per model: no [1m] twin row (the typed [1m] forms stay accepted above)',
  options.every(o => !o.value.endsWith('[1m]')),
)
t(
  'picker offers every catalogue row after inherit (no tier is dropped)',
  options.length === getModelOptions().length + 1,
)
t(
  'picker leads with inherit (the agent grammar\'s own default)',
  options[0]?.value === 'inherit',
)

const { getAgentModel } = await import('../../src/utils/model/agent.ts')
const pinned = getAgentModel('haiku', 'claude-opus-4-8', undefined, 'default')
t('a haiku agent-def pin resolves to the haiku row', /haiku/i.test(pinned), `resolved=${pinned}`)

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

const { formatZodValidationError } = await import(
  '../../src/utils/toolErrors.ts'
)
type Parsed<T> = { success: true; data: T } | { success: false; error: never }
const refusal = (tool: string, r: { success: boolean; error?: unknown }): string =>
  r.success ? '' : `InputValidationError: ${formatZodValidationError(tool, r.error as never).replace(/\n/g, ' ')}`
const describes = (schema: unknown, key: string): string =>
  ((schema as { shape: Record<string, { description?: string }> }).shape[key]?.description ?? '')

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
  const above = TaskOutputTool.inputSchema.safeParse({ task_id: 'x', timeout: '900000' }) as Parsed<{ timeout: number }>
  t(
    'TaskOutput timeout above the ceiling passes the schema (the tool clamps it to 600000 and says so)',
    above.success === true && above.data.timeout === 900000,
    refusal('TaskOutput', above),
  )
  const atCeiling = TaskOutputTool.inputSchema.safeParse({ task_id: 'x', timeout: 600000 }) as Parsed<{ timeout: number }>
  t('TaskOutput timeout at the ceiling parses as before', atCeiling.success === true && atCeiling.data.timeout === 600000, refusal('TaskOutput', atCeiling))
  const negative = TaskOutputTool.inputSchema.safeParse({ task_id: 'x', timeout: -1 })
  t(
    'TaskOutput timeout below zero keeps a typed refusal',
    negative.success === false && refusal('TaskOutput', negative).includes('The parameter `timeout` must have a minimum of 0'),
    refusal('TaskOutput', negative),
  )
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'ten minutes']) {
    t(`TaskOutput timeout ${String(bad)} keeps a typed refusal`, TaskOutputTool.inputSchema.safeParse({ task_id: 'x', timeout: bad }).success === false)
  }
  const words = describes(TaskOutputTool.inputSchema, 'timeout')
  t("the timeout parameter's own words name the ceiling and say a value above it is clamped", words.includes('600000') && /clamped/.test(words), words)
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
  const above = SleepTool.inputSchema.safeParse({ seconds: '4000' }) as Parsed<{ seconds: number }>
  t(
    'Sleep seconds above the ceiling passes the schema (the tool clamps it to 3600 and says so)',
    above.success === true && above.data.seconds === 4000,
    refusal('Sleep', above),
  )
  const zero = SleepTool.inputSchema.safeParse({ seconds: 0 }) as Parsed<{ seconds: number }>
  t('Sleep seconds of zero passes the schema (the tool clamps it up to the one-second floor and says so)', zero.success === true && zero.data.seconds === 0, refusal('Sleep', zero))
  const words = describes(SleepTool.inputSchema, 'seconds')
  t("the seconds parameter's own words name both bounds and say a value outside them is clamped", words.includes('min 1') && words.includes('max 3600') && /clamped/.test(words), words)
}

const monitorModule = await import('../../src/tools/MonitorTool/MonitorTool.ts')
{
  const MonitorTool = monitorModule.MonitorTool as {
    inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: { timeout_ms?: number }; error?: unknown } }
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
  const above = MonitorTool.inputSchema.safeParse({ ...base, timeout_ms: '99999999' })
  t(
    'Monitor timeout_ms above the ceiling passes the schema (the tool clamps it to 3600000 and says so)',
    above.success === true && above.data?.timeout_ms === 99999999,
    refusal('Monitor', above),
  )
  const under = MonitorTool.inputSchema.safeParse({ ...base, timeout_ms: 500 })
  t(
    'Monitor timeout_ms under the floor passes the schema (the tool clamps it up to 1000 and says so)',
    under.success === true && under.data?.timeout_ms === 500,
    refusal('Monitor', under),
  )
  const negative = MonitorTool.inputSchema.safeParse({ ...base, timeout_ms: -1 })
  t(
    'Monitor timeout_ms below zero keeps a typed refusal',
    negative.success === false && refusal('Monitor', negative).includes('The parameter `timeout_ms` must have a minimum of 0'),
    refusal('Monitor', negative),
  )
  const words = describes(monitorModule.MonitorTool.inputSchema, 'timeout_ms')
  t("the timeout_ms parameter's own words name both bounds and say a value outside them is clamped", words.includes('3600000') && words.includes('1000') && /clamped/.test(words), words)
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
