#!/usr/bin/env bun

process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const WANT_TOKENS = process.argv.includes('--tokens')
const AS_JSON = process.argv.includes('--json')

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const { getAllBaseTools, getTools } = await import('../../src/tools.ts')
const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { resolveBehaviourContract } = await import('../../src/prompt/behaviourContract.ts')

const MODEL = 'claude-opus-5'
const DEFAULT_CTX = {
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
} as never
const catalogCount = getAllBaseTools().length
const tools = getTools(DEFAULT_CTX)
const segments = await getSystemPrompt(tools, MODEL)
const contract = resolveBehaviourContract(segments)

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

interface Row {
  group: string
  name: string
  owner: string
  cacheClass: string
  bytes: number
  tokens?: number
}

const rows: Row[] = contract.sections.map(s => ({
  group: String(s.group),
  name: s.name,
  owner: s.owner,
  cacheClass: String(s.cacheClass),
  bytes: bytes(s.text),
}))

const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
let describedOk = 0
let toolSchemaBytes = 0
const apiTools: unknown[] = []
for (const t of tools) {
  const tool = t as {
    name: string
    inputJSONSchema?: unknown
    inputSchema?: unknown
    prompt?: (o: unknown) => Promise<string> | string
  }
  let description = ''
  try {
    const p = await tool.prompt?.({
      getToolPermissionContext: () => ({}),
      tools,
      agents: [],
      allowedAgentTypes: [],
    })
    if (typeof p === 'string') {
      description = p
      describedOk += 1
    }
  } catch {
  }
  const input_schema =
    tool.inputJSONSchema ?? (tool.inputSchema ? zodToJsonSchema(tool.inputSchema as never) : {})
  toolSchemaBytes += bytes(JSON.stringify({ name: tool.name, description, input_schema }))
  apiTools.push({ name: tool.name, description, input_schema } as never)
}

let tokenSource = 'not measured (offline run — pass --tokens to use the real tokenizer)'
let promptTokens: number | undefined
let classTokens: Map<string, number> | undefined
let toolSchemaTokens: number | undefined
if (WANT_TOKENS) {
  try {
    const { countTokensWithAPI, countMessagesTokensWithAPI } = await import(
      '../../src/services/tokenEstimation.ts'
    )
    const textsByClass = new Map<string, string[]>()
    for (const r of rows) {
      textsByClass.set(r.cacheClass, [...(textsByClass.get(r.cacheClass) ?? []), ''])
    }
    classTokens = new Map()
    for (const cls of textsByClass.keys()) {
      const text = contract.sections
        .filter(s => String(s.cacheClass) === cls)
        .map(s => s.text)
        .join('\n\n')
      const n = await countTokensWithAPI(text)
      if (typeof n !== 'number') throw new Error(`count refused for class '${cls}'`)
      classTokens.set(cls, n)
    }
    const res = await countTokensWithAPI(segments.join('\n\n'))
    if (typeof res === 'number') {
      promptTokens = res
      tokenSource = 'count_tokens (the real tokenizer)'
    } else {
      classTokens = undefined
      tokenSource = `refused: countTokensWithAPI returned ${JSON.stringify(res)}`
    }
    const dummyOnly = await countMessagesTokensWithAPI(
      [{ role: 'user', content: 'foo' }],
      [],
    )
    const withTools = await countMessagesTokensWithAPI(
      [{ role: 'user', content: 'foo' }],
      apiTools as never,
    )
    if (typeof dummyOnly === 'number' && typeof withTools === 'number') {
      toolSchemaTokens = withTools - dummyOnly
    }
  } catch (e) {
    classTokens = undefined
    toolSchemaTokens = undefined
    tokenSource = `unavailable: ${e instanceof Error ? e.message : String(e)}`
  }
}

const byClass = new Map<string, number>()
for (const r of rows) byClass.set(r.cacheClass, (byClass.get(r.cacheClass) ?? 0) + r.bytes)
const byOwner = new Map<string, number>()
for (const r of rows) byOwner.set(r.owner, (byOwner.get(r.owner) ?? 0) + r.bytes)

const promptBytes = rows.reduce((n, r) => n + r.bytes, 0)

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        model: MODEL,
        digest: contract.digest,
        sections: rows.length,
        promptBytes,
        toolSchemaBytes,
        requestBytes: promptBytes + toolSchemaBytes,
        byCacheClass: Object.fromEntries(byClass),
        byOwner: Object.fromEntries(byOwner),
        tokenSource,
        toolCount: tools.length,
        toolDescriptionsResolved: describedOk,
        ...(promptTokens !== undefined ? { promptTokens } : {}),
        ...(classTokens ? { tokensByCacheClass: Object.fromEntries(classTokens) } : {}),
        ...(toolSchemaTokens !== undefined ? { toolSchemaTokens } : {}),
        rows,
      },
      null,
      2,
    ),
  )
} else {
  const pct = (n: number): string => `${((n / (promptBytes + toolSchemaBytes)) * 100).toFixed(1)}%`
  console.log(`prompt attribution · ${MODEL} · contract ${contract.digest.slice(0, 12)}`)
  console.log(`  sections: ${rows.length}`)
  console.log('')
  console.log('  BY CACHE CLASS (how the request actually splits)')
  const tok = (cls: string): string =>
    classTokens?.has(cls) ? `  ${String(classTokens.get(cls)).padStart(6)} tok` : ''
  for (const [cls, n] of [...byClass].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cls.padEnd(10)} ${String(n).padStart(7)} B  ${pct(n)}${tok(cls)}`)
  }
  console.log(
    `    ${'tool-schema'.padEnd(10)} ${String(toolSchemaBytes).padStart(7)} B  ${pct(toolSchemaBytes)}${
      toolSchemaTokens !== undefined ? `  ${String(toolSchemaTokens).padStart(6)} tok (metered as tools[])` : ''
    }`,
  )
  console.log('')
  console.log('  TOP OWNERS BY BYTES')
  for (const [owner, n] of [...byOwner].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(n).padStart(7)} B  ${pct(n)}  ${owner}`)
  }
  console.log('')
  console.log('  LARGEST SECTIONS')
  for (const r of [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, 12)) {
    console.log(`    ${String(r.bytes).padStart(7)} B  ${r.cacheClass.padEnd(8)} ${r.group}:${r.name}`)
  }
  console.log('')
  console.log(`  prompt ${promptBytes} B + tool schemas ${toolSchemaBytes} B = ${promptBytes + toolSchemaBytes} B`)
  console.log(`  tokens: ${promptTokens ?? '—'}  ·  source: ${tokenSource}`)
  console.log(`  tool descriptions resolved: ${describedOk}/${tools.length}`)
  console.log(`  pool: REQUEST (${tools.length} enabled) · catalog ${catalogCount} — disabled tools ship nothing`)
}
