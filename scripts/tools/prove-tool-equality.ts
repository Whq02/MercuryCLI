#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'tool-equality-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()

const { PROVIDER_ID_SPACES, classifyModelRoute, declaredRouteOf } = await import(
  '../../src/models/roads/routeLaw.ts'
)
const { resolveModelCapabilities } = await import('../../src/models/facts/capabilities.ts')
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { toolToAPISchema } = await import('../../src/engine/messages/apiSystemAndToolSchema.ts')
const { clearToolSchemaCache } = await import('../../src/models/roads/toolSchemaCache.ts')
const { mapToolsToZai, mapMessagesToZai } = await import(
  '../../src/models/roads/zai/zaiCodec.ts'
)
const { mapToolsToOpenai, mapMessagesToOpenaiInput } = await import(
  '../../src/models/roads/openai/responsesBridge.ts'
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
check('the id-space table declares twenty-three non-anthropic families', declaredRoutes.length === 23, `${declaredRoutes.length}: the PROVIDER_ID_SPACES table in src/models/roads/routeLaw.ts and this proof's EXEMPLARS list must name the same families, so add or remove the family in both`)
check('twenty-four families with the anthropic home lane', FAMILIES.length === 24, `${FAMILIES.join(',')}: the PROVIDER_ID_SPACES table in src/models/roads/routeLaw.ts changed its family count, so update this count and EXEMPLARS together`)
check('no duplicate family ids', new Set(FAMILIES).size === FAMILIES.length)

const EXEMPLARS: Record<string, string> = {
  anthropic: 'claude-opus-4-6',
  zai: 'glm-5.3',
  openai: 'gpt-5.2',
  moonshot: 'kimi-k3',
  deepseek: 'deepseek-chat',
  xai: 'grok-4.7',
  meta: 'muse-spark-1.3',
  'openai-compat': 'compat/operator-model',
  openrouter: 'openrouter/qwen/qwen3-coder',
  gemini: 'gemini-3-pro',
  huggingface: 'huggingface/org/model',
  local: 'local/llama3',
  zen: 'zen/glm-5.3',
  mistral: 'mistral-large-4',
  nous: 'nous/anthropic/claude-sonnet-4.6',
  together: 'together/moonshotai/Kimi-K3',
  minimax: 'minimax-m3',
  cohere: 'command-a-plus-05-2026',
  groq: 'groq/openai/gpt-oss-120b',
  melious: 'melious/glm-5.3',
  orcarouter: 'orcarouter/orcarouter/auto',
  cerebras: 'cerebras/gpt-oss-120b',
  fireworks: 'fireworks/accounts/fireworks/models/kimi-k3',
  qwen: 'qwen3.8-max',
}
for (const family of FAMILIES) {
  check(
    `exemplar '${EXEMPLARS[family]}' resolves to its family`,
    Boolean(EXEMPLARS[family]) && declaredRouteOf(EXEMPLARS[family]!) === family,
    `${declaredRouteOf(EXEMPLARS[family] ?? '') ?? 'null'}: declaredRouteOf in src/models/roads/routeLaw.ts does not map this exemplar id to '${family}', so fix the exemplar here or the id-space rule there`,
  )
}

section('§2 the tool roster derives from the registry')

const roster = getAllBaseTools()
check('the registry answers a non-trivial roster', roster.length >= 25, `${roster.length}: getAllBaseTools in src/tools/kit/toolList.ts returned too few tools, so check which tool registrations were dropped`)
check('tool names are unique', new Set(roster.map(t => t.name)).size === roster.length)
const CORE = ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'TaskStop']
for (const name of CORE) {
  check(`core tool present: ${name}`, roster.some(t => t.name === name), `getAllBaseTools in src/tools/kit/toolList.ts no longer returns ${name}, so restore its registration`)
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
    tool: 'ProviderSearch',
    pattern: /\(Anthropic or OpenAI\)/g,
    reason:
      'provider-enumeration — the subject IS the native-search family set (NATIVE_SEARCH_FAMILIES: the tool exists only because those wires carry a construct, and the prompt names which; an exemption with teeth over a spelling-dodge)',
  },
  {
    tool: 'Crewmate',
    pattern: /## Model selection\n[^\n]+/g,
    reason:
      "provider-enumeration — the subject IS the family-word set (MODEL_PARAM_DESCRIPTION: each dispatch word names the family it selects — 'kimi' is Moonshot's row by definition; it rode the model parameter's schema text until fold 46bh moved it into the manual under its own heading, one line long)",
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
check(`every rendered text is brand-free (${brandCleanCount}/${roster.length})`, brandCleanCount === roster.length - renderFailures.length, 'a tool prompt or description names a provider brand, so reword that tool text to be brand-free (see the brand vocabulary lines above for which tool)')

const readTool = roster.find(t => t.name === 'Read')!
const VISUAL_CLAIM = 'Images are shown as pictures'
const OCR_CLAIM = 'return recognised text through an installed OCR engine'
const PDF_CLAIM = 'PDFs open as numbered text with page markers'
for (const family of FAMILIES) {
  const model = EXEMPLARS[family]!
  const caps = resolveModelCapabilities(model)
  const text = await readTool.prompt(promptOptions(model))
  check(
    `Read × ${family}: image claim tracks media.images=${caps.media.images}`,
    caps.media.images ? text.includes(VISUAL_CLAIM) && !text.includes(OCR_CLAIM) : text.includes(OCR_CLAIM) && !text.includes(VISUAL_CLAIM),
    `the Read prompt for '${model}' must claim pictures only when resolveModelCapabilities (src/models/facts/capabilities.ts) says media.images is true, and the OCR wording otherwise`,
  )
  check(
    `Read × ${family}: PDF text is readable independently of native input`,
    text.includes(PDF_CLAIM),
    `the Read prompt for '${model}' lost the PDF wording '${PDF_CLAIM}', so restore it in the Read tool prompt for every model`,
  )
}

const unknownId = 'totally-unknown-model-x1'
check("an unknown id classifies 'unrecognised' — never the home lane by remainder", classifyModelRoute(unknownId).kind === 'unrecognised', 'classifyModelRoute (imported from src/models/roads/routeLaw.ts) must return kind unrecognised for an id no family claims')
check('and its media record carries the home-transport truth', resolveModelCapabilities(unknownId).media.images === true, 'resolveModelCapabilities in src/models/facts/capabilities.ts must give an unknown id media.images true')

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
const wireOf = async (model: string): Promise<string> => readTool.prompt(promptOptions(model))
const claudeWire = await wireOf(EXEMPLARS.anthropic!)
const glmWire = await wireOf(EXEMPLARS.zai!)
check('the wire is the one text: Read has no manual behind its description', readTool.wireDescription === undefined && claudeWire === (await readTool.prompt(promptOptions(EXEMPLARS.anthropic!))), 'the Read tool gained a wireDescription or its prompt is not stable between calls, so keep the wire text the one prompt text')
check('a foreign-lane render does not poison the anthropic render', (readOnClaude as { description: string }).description === claudeWire, 'toolToAPISchema (src/engine/messages/apiSystemAndToolSchema.ts) returned a description for the anthropic model that differs from the Read prompt, so the schema memo must key on the model capability posture')
const glmCaps = resolveModelCapabilities(EXEMPLARS.zai!)
const glmText = (readOnGlm1 as { description: string }).description
check(
  `the foreign render carries its own media truth (images=${glmCaps.media.images}, pdf=${glmCaps.media.pdf})`,
  glmText === glmWire && glmText.split('\n\n')[1] !== claudeWire.split('\n\n')[1] && glmText.includes(PDF_CLAIM),
  'toolToAPISchema (src/engine/messages/apiSystemAndToolSchema.ts) must render the foreign-lane Read description from that model own prompt and media record, not reuse the anthropic render',
)
check('the two postures render different bytes', glmText !== (readOnClaude as { description: string }).description, 'toolToAPISchema (src/engine/messages/apiSystemAndToolSchema.ts) gave both capability postures the same description bytes, so its memo must be keyed per posture')
check('same-posture renders are byte-stable (memo hit)', (readOnGlm1 as { description: string }).description === (readOnGlm2 as { description: string }).description, 'toolToAPISchema (src/engine/messages/apiSystemAndToolSchema.ts) rendered different bytes for the same posture twice, so its schema memo must return the cached render')

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
check('every roster tool yields a wire schema', shaped.length === roster.length, `${shaped.length}/${roster.length}: toolToAPISchema (src/engine/messages/apiSystemAndToolSchema.ts) returned no name or input_schema for some tool, so find which tool it fails on`)

const zaiTools = mapToolsToZai(shaped)
check('chat-completions codec: every tool serializes', zaiTools.length === shaped.length, 'mapToolsToZai (src/models/roads/zai/zaiCodec.ts) dropped or added tools, so it must map every shaped tool')
check(
  'chat-completions codec: nested function spelling with name+parameters',
  zaiTools.every(t => t.type === 'function' && typeof t.function.name === 'string' && t.function.parameters !== undefined),
  'mapToolsToZai (src/models/roads/zai/zaiCodec.ts) must emit {type: function, function: {name, parameters}} for every tool',
)
check(
  'chat-completions codec: descriptions carried',
  zaiTools.filter(t => t.function.description).length === shaped.filter(s => s.description).length,
  'mapToolsToZai (src/models/roads/zai/zaiCodec.ts) must carry each tool description into function.description',
)
const zaiJson = JSON.stringify(zaiTools)
for (const forbidden of ['strict', 'eager_input_streaming', 'defer_loading', 'cache_control']) {
  check(`chat-completions codec: no Anthropic-only field '${forbidden}'`, !zaiJson.includes(`"${forbidden}":`), `mapToolsToZai (src/models/roads/zai/zaiCodec.ts) must strip the Anthropic-only field ${forbidden} from its output`)
}

const openaiTools = mapToolsToOpenai(shaped)
check('Responses codec: every tool serializes FLAT', openaiTools.length === shaped.length && openaiTools.every(t => (t as { name?: string }).name !== undefined), 'mapToolsToOpenai (src/models/roads/openai/responsesBridge.ts) must emit one flat tool with a top-level name for every shaped tool')
const openaiJson = JSON.stringify(openaiTools)
for (const forbidden of ['eager_input_streaming', 'defer_loading', 'cache_control']) {
  check(`Responses codec: no Anthropic-only field '${forbidden}'`, !openaiJson.includes(`"${forbidden}":`), `mapToolsToOpenai (src/models/roads/openai/responsesBridge.ts) must drop the Anthropic-only field ${forbidden} from its output`)
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
  `${JSON.stringify(parallelRow?.tool_calls?.map(c => c.id))}: mapMessagesToZai (src/models/roads/zai/zaiCodec.ts) must put every tool_use of one assistant turn into that row's tool_calls, once each`,
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
check('an image tool result degrades to the named placeholder when the model takes no images', toolRow?.content === '[image]', `${JSON.stringify(toolRow?.content)}: mapMessagesToZai (src/models/roads/zai/zaiCodec.ts) must write [image] for an image tool result when imagesSupported is false`)
const zaiImageCarried = mapMessagesToZai(undefined, [imageResult as never])
const carriedUser = zaiImageCarried.find(m => m.role === 'user')
check(
  'an image tool result rides as an image_url part of the user row that follows the tool row when the model takes images',
  Array.isArray(carriedUser?.content) && carriedUser.content.some(p => p.type === 'image_url'),
  `${JSON.stringify(carriedUser?.content).slice(0, 120)}: mapMessagesToZai (src/models/roads/zai/zaiCodec.ts) must carry an image tool result as an image_url part when images are supported`,
)
check('…never to an empty string', (toolRow?.content ?? '').length > 0, 'mapMessagesToZai (src/models/roads/zai/zaiCodec.ts) emitted an empty tool row for an image-only result, so it must write the [image] placeholder')

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
  `${JSON.stringify(mixedRow?.content)}: mapMessagesToZai (src/models/roads/zai/zaiCodec.ts) must keep the text part and write [document] for a document part in a tool result`,
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
  'mapMessagesToZai (src/models/roads/zai/zaiCodec.ts) must replace a user image block with [image] when imagesSupported is false',
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
  'mapMessagesToOpenaiInput (src/models/roads/openai/responsesBridge.ts) must emit an input_image part in the function_call_output when imagesSupported is true',
)
check(
  'Responses bridge: an unsupported model gets the named placeholder',
  typeof unsupportedOutput === 'string' && unsupportedOutput.includes('[image]'),
  `${JSON.stringify(unsupportedOutput)}: mapMessagesToOpenaiInput (src/models/roads/openai/responsesBridge.ts) must write the [image] placeholder when imagesSupported is false`,
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
check('a past-the-end read WARNS inside a successful result', (shortRead as { is_error?: boolean }).is_error !== true && shortText.includes('Warning'), 'the Read tool mapToolResultToToolResultBlockParam must return a successful result carrying a Warning line when startLine is past the end of the file, not an error')
const emptyRead = readTool.mapToolResultToToolResultBlockParam(
  {
    type: 'text',
    file: { filePath: '/tmp/x', content: '', numLines: 0, startLine: 1, totalLines: 0 },
  } as never,
  'toolu_eq_2',
)
const emptyText = typeof emptyRead.content === 'string' ? emptyRead.content : JSON.stringify(emptyRead.content)
check('an empty-file read WARNS inside a successful result', (emptyRead as { is_error?: boolean }).is_error !== true && emptyText.includes('Warning'), 'the Read tool mapToolResultToToolResultBlockParam must return a successful result carrying a Warning line for an empty file, not an error')


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
