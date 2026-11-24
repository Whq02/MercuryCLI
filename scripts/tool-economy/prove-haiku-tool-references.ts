#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'haiku-tool-references-'))
const cwd = join(scratch, 'work')
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_BARE', 'NODE_ENV', 'MERCURY_PROJECT_INTEL', 'MERCURY_TOOL_SEARCH', 'ANTHROPIC_BASE_URL']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const previousCwd = process.cwd()
process.chdir(cwd)

const HINT = 'check haikuTakesToolReferences in src/models/facts/capabilities.ts, asked by modelSupportsToolReference in src/engine/messages/toolSearch.ts'
let failures = 0
let checks = 0
const check = (label: string, good: boolean, detail = ''): void => {
  checks++
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}${good ? (detail ? ` — ${detail}` : '') : ` — ${[detail, HINT].filter(Boolean).join('; ')}`}`)
  if (!good) failures++
}

try {
  const state = await import('../../src/boot/process-state/processState.ts')
  state.setOriginalCwd(cwd)
  state.setProjectRoot(cwd)
  state.setCwdState(cwd)
  state.setIsInteractive(false)
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const search = await import('../../src/engine/messages/toolSearch.ts')
  const economy = await import('../../src/models/roads/toolEconomy.ts')
  const { deferralWireFormFor } = await import('../../src/models/roads/deferralWire.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  const { getTools } = await import('../../src/tools/kit/toolList.ts')
  const { zodToJsonSchema } = await import('../../src/platform/primitives/zodToJsonSchema.ts')

  console.log('§1 which model takes tool references')
  const answers: Array<[string, boolean]> = [
    ['claude-haiku-5-5', true],
    ['claude-haiku-4-5', true],
    ['claude-haiku-4-5-20251001', true],
    ['claude-3-5-haiku-20241022', false],
    ['claude-3-haiku-20240307', false],
    ['some-haiku-from-elsewhere', false],
    ['claude-sonnet-5-5', true],
    ['claude-opus-5-5', true],
    ['claude-fable-5-1', true],
  ]
  for (const [model, want] of answers) {
    const got = search.modelSupportsToolReference(model)
    check(`${model}: ${want ? 'takes' : 'takes no'} tool references`, got === want, `answered ${got}`)
  }

  console.log("§2 the tools term of a first request, the product's own tool list on the home lane")
  const permissionContext = getEmptyToolPermissionContext()
  const pool = getTools(permissionContext)
  const describe = async (tool: { name: string; inputSchema?: unknown; inputJSONSchema?: unknown; prompt?: (options: unknown) => Promise<string> }): Promise<string> => {
    let description = ''
    try { description = typeof tool.prompt === 'function' ? await tool.prompt({ getToolPermissionContext: async () => permissionContext, tools: pool, agents: [] }) : '' } catch { description = '' }
    let schema: unknown = tool.inputJSONSchema
    if (schema === undefined && tool.inputSchema !== undefined) { try { schema = zodToJsonSchema(tool.inputSchema as never) } catch { schema = {} } }
    return JSON.stringify({ name: tool.name, description, input_schema: schema ?? {} })
  }
  const termOf = async (model: string) => {
    economy.clearToolRosterLatches()
    const plan = await economy.planToolPayload({ model, tools: pool, messages: [], getToolPermissionContext: async () => permissionContext, agents: [], source: 'probe' })
    const wire = economy.toolsOnTheWire(plan)
    let bytes = 0
    for (const tool of wire) {
      const deferred = plan.deferredNames.has(tool.name)
      bytes += deferred ? JSON.stringify({ name: tool.name }).length : (await describe(tool as never)).length
    }
    return { enabled: plan.enabled, form: plan.wireForm, tools: wire.length, deferred: plan.deferredNames.size, bytes }
  }
  const form = deferralWireFormFor('claude-haiku-5-5')
  console.log(`the home lane's wire form for claude-haiku-5-5: ${form.form} (${form.why}); the pool holds ${pool.length} tools`)
  const sonnet = await termOf('claude-sonnet-5-5')
  const haiku55 = await termOf('claude-haiku-5-5')
  const haiku45 = await termOf('claude-haiku-4-5')
  const haiku35 = await termOf('claude-3-5-haiku-20241022')
  console.log(`claude-sonnet-5-5: deferral ${sonnet.enabled ? 'on' : 'off'}, ${sonnet.tools} tools on the wire, ${sonnet.deferred} by name alone, about ${sonnet.bytes} bytes of full definitions`)
  console.log(`claude-haiku-5-5:  deferral ${haiku55.enabled ? 'on' : 'off'}, ${haiku55.tools} tools on the wire, ${haiku55.deferred} by name alone, about ${haiku55.bytes} bytes of full definitions`)
  console.log(`claude-haiku-4-5:  deferral ${haiku45.enabled ? 'on' : 'off'}, ${haiku45.tools} tools on the wire, ${haiku45.deferred} by name alone, about ${haiku45.bytes} bytes of full definitions`)
  console.log(`claude-3-5-haiku:  deferral ${haiku35.enabled ? 'on' : 'off'}, ${haiku35.tools} tools on the wire, ${haiku35.deferred} by name alone, about ${haiku35.bytes} bytes of full definitions`)
  check('claude-haiku-5-5 is sent what claude-sonnet-5-5 is sent: deferral on, the same tools by name alone', haiku55.enabled === sonnet.enabled && haiku55.deferred === sonnet.deferred && haiku55.bytes === sonnet.bytes, `haiku ${haiku55.bytes} bytes, sonnet ${sonnet.bytes} bytes`)
  check('claude-haiku-4-5 the same', haiku45.enabled === sonnet.enabled && haiku45.deferred === sonnet.deferred && haiku45.bytes === sonnet.bytes, `haiku ${haiku45.bytes} bytes`)
  check('an older Haiku is sent the whole list as before', haiku35.enabled === false && haiku35.deferred === 0 && haiku35.bytes > sonnet.bytes, `${haiku35.bytes} bytes`)
} finally {
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? `all ${checks} hold` : `${failures} of ${checks} fail`)
process.exit(failures === 0 ? 0 : 1)
