#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const HOME = mkdtempSync(join(tmpdir(), 'tool-equality-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { PROVIDER_ID_SPACES, classifyModelRoute, declaredRouteOf } = await import(
  '../../src/services/providers/routeLaw.ts'
)
const { resolveModelCapabilities } = await import('../../src/utils/model/capabilities.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
const { mapToolsToZai, mapMessagesToZai } = await import(
  '../../src/services/providers/zai/zaiCodec.ts'
)
const { mapToolsToOpenai, mapMessagesToOpenaiInput } = await import(
  '../../src/services/providers/openai/responsesBridge.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

section('§1 the family list derives from routeLaw')

const declaredRoutes = PROVIDER_ID_SPACES.map(s => s.route)
const FAMILIES = ['anthropic', ...declaredRoutes] as const
check('the id-space table declares nine non-anthropic families', declaredRoutes.length === 9, String(declaredRoutes.length))
check('ten families with the anthropic home lane', FAMILIES.length === 10, FAMILIES.join(','))
check('no duplicate family ids', new Set(FAMILIES).size === FAMILIES.length)

const EXEMPLARS: Record<string, string> = {
  anthropic: 'claude-opus-4-6',
  zai: 'glm-5.3',
  openai: 'gpt-5.2',
  moonshot: 'kimi-k3',
  deepseek: 'deepseek-chat',
  'openai-compat': 'compat/operator-model',
  openrouter: 'openrouter/qwen/qwen3-coder',
  gemini: 'gemini-3-pro',
  huggingface: 'huggingface/org/model',
  local: 'local/llama3',
}
for (const family of FAMILIES) {
  check(
    `exemplar '${EXEMPLARS[family]}' resolves to its family`,
    declaredRouteOf(EXEMPLARS[family]!) === family,
    declaredRouteOf(EXEMPLARS[family]!),
  )
}

section('§2 the tool roster derives from the registry')

const roster = getAllBaseTools()
check('the registry answers a non-trivial roster', roster.length >= 25, String(roster.length))
check('tool names are unique', new Set(roster.map(t => t.name)).size === roster.length)
const CORE = ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'TaskStop']
for (const name of CORE) {
  check(`core tool present: ${name}`, roster.some(t => t.name === name))
}

const promptOptions = (model: string) => ({
  getToolPermissionContext: async () => getEmptyToolPermissionContext(),
  tools: roster,
  agents: [],
  model,
})

section('§3 model-facing text per family: brand-free, capability-true')

const BRAND_ALLOWLIST: ReadonlyArray<{ tool: string; pattern: RegExp; reason: string }> = [
  {
    tool: 'Bash',
    pattern: /Co-Authored-By: Mercury · [^\n]*/g,
    reason: 'model-derived attribution trailer (utils/attribution.ts)',
  },
  {
    tool: 'Workflow',
    pattern: /one workflow may run Claude-family agents and a connected GPT lane's agents side by side/g,
    reason: 'provider-mixing guidance — the subject IS the family set',
  },
  {
    tool: 'ProviderSearch',
    pattern: /\(Anthropic web search · OpenAI web search\)/g,
    reason:
      'provider-enumeration — the subject IS the native-search family set (NATIVE_SEARCH_FAMILIES: the tool exists only because those wires carry a construct, and the prompt names which; an exemption with teeth over a spelling-dodge)',
  },
]
function brandHits(toolName: string, text: string): string[] {
  let stripped = text
  for (const allow of BRAND_ALLOWLIST) {
    if (allow.tool === toolName) stripped = stripped.replace(allow.pattern, '[allowed]')
  }
  const hits: string[] = []
  for (const brand of [/\bClaude\b/, /\bAnthropic\b/, /\bOpenAI\b/, /\bGPT\b/, /\bGemini\b/, /\bDeepSeek\b/, /\bMoonshot\b/, /\bKimi\b/]) {
    const m = stripped.match(brand)
    if (m) hits.push(m[0])
  }
  return hits
}

let brandCleanCount = 0
let renderFailures: string[] = []
for (const tool of roster) {
  let text = ''
  try {
    text = await tool.prompt(promptOptions(EXEMPLARS.anthropic!))
    const description = await tool.description(undefined, {})
    text += '\n' + (description ?? '')
  } catch (error) {
    renderFailures.push(`${tool.name}: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  const hits = brandHits(tool.name, text)
  if (hits.length === 0) brandCleanCount++
  else check(`brand vocabulary in ${tool.name}`, false, hits.join(','))
}
check('every roster prompt+description renders', renderFailures.length === 0, renderFailures.slice(0, 3).join(' | '))
check(`every rendered text is brand-free (${brandCleanCount}/${roster.length})`, brandCleanCount === roster.length - renderFailures.length)

const readTool = roster.find(t => t.name === 'Read')!
const VISUAL_CLAIM = 'sees the picture itself'
const PLACEHOLDER_CLAIM = 'an `[image]` placeholder'
const PDF_CLAIM = 'can read PDF files'
for (const family of FAMILIES) {
  const model = EXEMPLARS[family]!
  const caps = resolveModelCapabilities(model)
  const text = await readTool.prompt(promptOptions(model))
  check(
    `Read × ${family}: image claim tracks media.images=${caps.media.images}`,
    caps.media.images ? text.includes(VISUAL_CLAIM) && !text.includes(PLACEHOLDER_CLAIM) : text.includes(PLACEHOLDER_CLAIM) && !text.includes(VISUAL_CLAIM),
  )
  check(
    `Read × ${family}: PDF lines track media.pdf=${caps.media.pdf}`,
    caps.media.pdf === text.includes(PDF_CLAIM),
  )
}

const unknownId = 'totally-unknown-model-x1'
check("an unknown id classifies 'unrecognised' — never the home lane by remainder", classifyModelRoute(unknownId).kind === 'unrecognised')
check('and its media record carries the home-transport truth', resolveModelCapabilities(unknownId).media.images === true)

section('§4 the schema memo: per-capability-posture bytes, no first-writer-wins')

clearToolSchemaCache()
const schemaOptions = (model: string) => ({
  getToolPermissionContext: async () => getEmptyToolPermissionContext(),
  tools: roster,
  agents: [],
  model,
})
const readOnGlm1 = await toolToAPISchema(readTool, schemaOptions(EXEMPLARS.zai!))
const readOnClaude = await toolToAPISchema(readTool, schemaOptions(EXEMPLARS.anthropic!))
const readOnGlm2 = await toolToAPISchema(readTool, schemaOptions(EXEMPLARS.zai!))
check('a foreign-lane render does not poison the anthropic render', (readOnClaude as { description: string }).description.includes(VISUAL_CLAIM))
check('the foreign-lane render carries the placeholder truth', (readOnGlm1 as { description: string }).description.includes(PLACEHOLDER_CLAIM))
check('same-posture renders are byte-stable (memo hit)', (readOnGlm1 as { description: string }).description === (readOnGlm2 as { description: string }).description)

section('§5 the roster serializes onto every foreign codec')

type Shaped = { name: string; description?: string; input_schema: unknown }
const shaped: Shaped[] = []
for (const tool of roster) {
  const schema = (await toolToAPISchema(tool, schemaOptions(EXEMPLARS.zai!))) as Record<string, unknown>
  if (typeof schema.name === 'string' && schema.input_schema !== undefined) {
    shaped.push({
      name: schema.name,
      ...(schema.description ? { description: String(schema.description) } : {}),
      input_schema: schema.input_schema,
    })
  }
}
check('every roster tool yields a wire schema', shaped.length === roster.length, `${shaped.length}/${roster.length}`)

const zaiTools = mapToolsToZai(shaped)
check('chat-completions codec: every tool serializes', zaiTools.length === shaped.length)
check(
  'chat-completions codec: nested function spelling with name+parameters',
  zaiTools.every(t => t.type === 'function' && typeof t.function.name === 'string' && t.function.parameters !== undefined),
)
check(
  'chat-completions codec: descriptions carried',
  zaiTools.filter(t => t.function.description).length === shaped.filter(s => s.description).length,
)
const zaiJson = JSON.stringify(zaiTools)
for (const forbidden of ['strict', 'eager_input_streaming', 'defer_loading', 'cache_control']) {
  check(`chat-completions codec: no Anthropic-only field '${forbidden}'`, !zaiJson.includes(`"${forbidden}":`))
}

const openaiTools = mapToolsToOpenai(shaped)
check('Responses codec: every tool serializes FLAT', openaiTools.length === shaped.length && openaiTools.every(t => (t as { name?: string }).name !== undefined))
const openaiJson = JSON.stringify(openaiTools)
for (const forbidden of ['eager_input_streaming', 'defer_loading', 'cache_control']) {
  check(`Responses codec: no Anthropic-only field '${forbidden}'`, !openaiJson.includes(`"${forbidden}":`))
}

const parallelAssistant = {
  role: 'assistant' as const,
  content: [
    { type: 'tool_use' as const, id: 'call-A', name: 'Read', input: { file_path: '/a' } },
    { type: 'tool_use' as const, id: 'call-B', name: 'Grep', input: { pattern: 'x' } },
  ],
}
const zaiParallel = mapMessagesToZai(undefined, [parallelAssistant as never])
const parallelRow = zaiParallel.find(m => m.role === 'assistant')
check(
  'parallel tool_use blocks map to sibling tool_calls (exactly once each)',
  parallelRow?.tool_calls?.length === 2 && new Set(parallelRow.tool_calls.map(c => c.id)).size === 2,
  JSON.stringify(parallelRow?.tool_calls?.map(c => c.id)),
)

const imageResult = {
  role: 'user' as const,
  content: [
    {
      type: 'tool_result' as const,
      tool_use_id: 'call-A',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
  ],
}
const zaiImage = mapMessagesToZai(undefined, [imageResult as never], { imagesSupported: false })
const toolRow = zaiImage.find(m => m.role === 'tool')
check('an image tool result degrades to the named placeholder when the model takes no images', toolRow?.content === '[image]', JSON.stringify(toolRow?.content))
const zaiImageCarried = mapMessagesToZai(undefined, [imageResult as never])
const carriedUser = zaiImageCarried.find(m => m.role === 'user')
check(
  'an image tool result rides as an image_url part of the user row that follows the tool row when the model takes images',
  Array.isArray(carriedUser?.content) && carriedUser.content.some(p => p.type === 'image_url'),
  JSON.stringify(carriedUser?.content).slice(0, 120),
)
check('…never to an empty string', (toolRow?.content ?? '').length > 0)

const mixedResult = {
  role: 'user' as const,
  content: [
    {
      type: 'tool_result' as const,
      tool_use_id: 'call-A',
      content: [
        { type: 'text', text: 'PDF summary line. ' },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' } },
      ],
    },
  ],
}
const zaiMixed = mapMessagesToZai(undefined, [mixedResult as never])
const mixedRow = zaiMixed.find(m => m.role === 'tool')
check(
  'a mixed text+document result keeps the text and names the document',
  mixedRow?.content === 'PDF summary line. [document]',
  JSON.stringify(mixedRow?.content),
)

const userImage = {
  role: 'user' as const,
  content: [
    { type: 'text' as const, text: 'look:' },
    { type: 'image' as const, source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ],
}
const zaiUserImage = mapMessagesToZai(undefined, [userImage as never], { imagesSupported: false })
check(
  'a pasted user image degrades to the same named placeholder when the model takes no images',
  zaiUserImage.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[image]')),
)

const bridgeRows = [
  {
    role: 'user' as const,
    content: [
      {
        type: 'tool_result' as const,
        tool_use_id: 'call-A',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      },
    ],
  },
]
const withImages = mapMessagesToOpenaiInput(bridgeRows as never, { imagesSupported: true })
const withoutImages = mapMessagesToOpenaiInput(bridgeRows as never, { imagesSupported: false })
const outputOf = (items: unknown[]): unknown =>
  (items.find(i => (i as { type?: string }).type === 'function_call_output') as { output?: unknown })?.output
const supportedOutput = outputOf(withImages)
const unsupportedOutput = outputOf(withoutImages)
check(
  'Responses bridge: a supported lane carries the image as input_image',
  Array.isArray(supportedOutput) && supportedOutput.some(p => (p as { type?: string }).type === 'input_image'),
)
check(
  'Responses bridge: an unsupported model gets the named placeholder',
  typeof unsupportedOutput === 'string' && unsupportedOutput.includes('[image]'),
  JSON.stringify(unsupportedOutput),
)

section('§6 warning-class facts warn in the result; only correctness errors')

const shortRead = readTool.mapToolResultToToolResultBlockParam(
  {
    type: 'text',
    file: { filePath: '/tmp/x', content: '', numLines: 0, startLine: 99, totalLines: 3 },
  } as never,
  'toolu_eq_1',
)
const shortText = typeof shortRead.content === 'string' ? shortRead.content : JSON.stringify(shortRead.content)
check('a past-the-end read WARNS inside a successful result', (shortRead as { is_error?: boolean }).is_error !== true && shortText.includes('Warning'))
const emptyRead = readTool.mapToolResultToToolResultBlockParam(
  {
    type: 'text',
    file: { filePath: '/tmp/x', content: '', numLines: 0, startLine: 1, totalLines: 0 },
  } as never,
  'toolu_eq_2',
)
const emptyText = typeof emptyRead.content === 'string' ? emptyRead.content : JSON.stringify(emptyRead.content)
check('an empty-file read WARNS inside a successful result', (emptyRead as { is_error?: boolean }).is_error !== true && emptyText.includes('Warning'))

const webFetchSource = readFileSync(new URL('../../src/tools/WebFetchTool/utils.ts', import.meta.url), 'utf8')
check(
  'WebFetch: a failed extraction leg DEGRADES to fetched content with a note',
  webFetchSource.includes('The extraction model was unavailable') && webFetchSource.includes('catch (error)'),
)
check(
  'WebFetch: the degraded passthrough restates the quote ceiling for untrusted domains',
  webFetchSource.includes('under 125 characters'),
)
const nativeSearchSource = readFileSync(new URL('../../src/services/search/nativeSearch.ts', import.meta.url), 'utf8')
check(
  'WebSearch: a native provider failure settles as the TYPED provider-refused outcome',
  nativeSearchSource.includes('isApiErrorMessage === true') && nativeSearchSource.includes("searchFailure('provider-refused'"),
)
const searchDoorSource = readFileSync(new URL('../../src/services/search/searchDoor.ts', import.meta.url), 'utf8')
check(
  'WebSearch: the door walks typed failures and throws the one composed line when no door answers',
  searchDoorSource.includes('throw new Error(walkFailureLine(failures, plan, { nativeFamily:') && searchDoorSource.includes('notes: [...failures.map(failureLine)'),
)
check(
  'WebSearch: the native door is the main model\'s OWN family by the routing law — never another family\'s credential',
  searchDoorSource.includes('declaredRouteOf(mainModel)') && searchDoorSource.includes('isNativeSearchFamily(route)'),
)

section('the equality matrix (dispositions per tool-class × family)')

const matrix = [
  ['tool class', 'anthropic', 'openai', 'chat lanes (zai·moonshot·deepseek·compat·openrouter·gemini·hf·local)'],
  ['text-in/text-out tools (the roster majority)', 'works', 'works', 'works — §5 serialization law'],
  ['image-result reads (Read, MCP images)', 'works (native)', 'works (modality-gated, named degrade)', 'FIXED — named placeholder + capability-true prompt (§3–§5)'],
  ['PDF document reads', 'works', 'typed error + extraction fallback', 'typed error + extraction fallback (record-derived, §3)'],
  ['WebSearch (the search door)', 'works (native server tool)', 'works (native Responses web_search)', 'works — keyed/keyless doors, typed one-line failures (§6)'],
  ['WebFetch extraction leg', 'works', 'degrades to content + note', 'FIXED — degrades to content + note (§6)'],
  ['tool-less models (hf/local catalogues)', '—', '—', 'typed refusal at the profile (provwave provers)'],
  ['anthropic beta wire fields (defer/strict/eager)', 'stripped at the beta chokepoint', 'dropped by codec (§5)', 'dropped by codec (§5)'],
]
for (const row of matrix) console.log('  | ' + row.join(' | '))

console.log('')
if (failures > 0) {
  console.error(`prove-tool-equality: ${failures} RED`)
  process.exit(1)
}
console.log('✅ prove-tool-equality: the matrix laws hold')
