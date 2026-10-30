#!/usr/bin/env bun
import { plugin } from 'bun'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const NAME = 'image-generation'
const SOURCE = join(ROOT, 'mercury-skills', NAME)
const MEDIA_SERVER = join(ROOT, 'src', 'extensions', 'bundled', 'mercury-media', 'server', 'server.js')
const POSITIVE = 'Use Mercury image generation to make a pixel-art character from this reference.'
const NEGATIVE = 'How do I install Mercury or sign in?'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'image-generation-skill-')))
const project = join(scratch, 'project')
for (const dir of ['home', 'tmp', 'media', 'project']) mkdirSync(join(scratch, dir), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_TMPDIR = join(scratch, 'tmp')
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CRITTER
delete process.env.MERCURY_SESSION_KIT
process.chdir(project)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
const guard = setTimeout(() => {
  console.log('\nTIMEOUT: the image-generation skill proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { mercuryDocPages, MERCURY_DOCS_SKILL_NAME } = await import('../../src/skills/bundled/mercuryDocs.ts')
plugin({
  name: 'bundled-skill-text',
  setup(build) {
    build.onLoad({ filter: /\.md$/ }, ({ path }) => ({ contents: `export default ${JSON.stringify(readFileSync(path, 'utf8'))}`, loader: 'js' }))
  },
})

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? `: ${detail.slice(0, 400)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'-'.repeat(76)}\n${title}`)

const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
const gen = await import('./gen-bundled.ts')
const { parseFrontmatter } = await import('../../src/utils/frontmatterParser.ts')
const { initBundledSkills } = await import('../../src/skills/bundled/index.ts')
const { getBundledSkills, getBundledSkillExtractDir } = await import('../../src/skills/bundledSkills.ts')
const { builtinCommands, getCommands, getSkillToolCommands } = await import('../../src/commands.ts')
const { getSkillListingAttachments, resetSentSkillNames } = await import('../../src/utils/attachments/skillListing.ts')
const { SkillTool, expansionBodyOf } = await import('../../src/tools/SkillTool/SkillTool.ts')
const { MAX_LISTING_DESC_CHARS } = await import('../../src/tools/SkillTool/constants.ts')
const { processSlashCommand } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
const { bareUsageLine, requiresArgument } = await import('../../src/skills/argumentHint.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { compileJsonSchema, formatSchemaIssues } = await import('../../src/services/schema/jsonSchemaEngine.ts')
const { Client, StdioClientTransport } = await import('../../src/services/mcp/sdk.ts')
type Command = import('../../src/types/command.ts').Command
type Message = import('../../src/types/message.ts').Message
type ToolUseContext = import('../../src/Tool.ts').ToolUseContext

const context = (commands: Command[] = [], interactive = false): ToolUseContext =>
  ({
    messages: [],
    options: { commands, tools: [SkillTool], mcpClients: [], mcpResources: {}, engineModel: 'fixture-model', agentDefinitions: { activeAgents: [], allAgents: [] }, debug: false, verbose: false, isNonInteractiveSession: !interactive },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), mcp: { clients: [], commands: [] }, sessionHooks: new Map() }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    nestedMemoryAttachmentTriggers: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
  }) as unknown as ToolUseContext
const parent = { uuid: 'image-generation-proof-parent', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_image_generation', name: 'Skill', input: {} }] } } as never
const canUse = async (): Promise<never> => {
  throw new Error('the fixture never reaches a permission request')
}
const bodiesOf = (messages: readonly Message[] | undefined): string[] => (messages ?? []).map(expansionBodyOf).filter((text): text is string => text !== null)
const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'))
        .sort()
    : []
const backticked = (files: ReadonlyArray<readonly [string, string]>, pattern: RegExp): string[] => [...new Set(files.flatMap(([, text]) => [...text.matchAll(pattern)].map(match => match[1]!)))]

section('§1 THE SOURCE: mercury-skills/image-generation compiles into the bundled modules (RED on the base: the skill is absent)')
const sourceMd = existsSync(join(SOURCE, 'SKILL.md')) ? readFileSync(join(SOURCE, 'SKILL.md'), 'utf8') : ''
const { frontmatter, content } = parseFrontmatter(sourceMd)
const body = content.trimStart()
const description = typeof frontmatter.description === 'string' ? frontmatter.description : ''
const hint = typeof frontmatter['argument-hint'] === 'string' ? frontmatter['argument-hint'] : undefined
const references = walk(SOURCE).filter(rel => rel !== 'SKILL.md')
const skillFiles: Array<readonly [string, string]> = sourceMd === '' ? [] : [['SKILL.md', sourceMd], ...references.map(rel => [rel, readFileSync(join(SOURCE, rel), 'utf8')] as const)]
check('the source skill exists with a description, an argument hint and a body', sourceMd !== '' && description !== '' && hint !== undefined && body.length > 0)
check('the generator discovers it under its own name', gen.discoverSkills().names.includes(NAME), gen.discoverSkills().names.join(' '))
const drift = sourceMd === '' ? ['no source'] : gen.checkSkill(NAME)
check('the generated wrapper, content module and mirror match a fresh render of the source', drift.length === 0, drift.join(' | '))
check('the proof loads .md as text, the loader the generator declares for bundled skills', gen.TEXT_LOADERS['.md'] === 'text')
check('neither the name nor the description names ComfyUI', !/comfy/i.test(NAME) && !/comfy/i.test(description), description)

section('§2 DISCOVERY: the real loader registers it, the Skill tool sees it and the listing carries its whole description')
initBundledSkills()
const command = getBundledSkills().find(item => item.name === NAME)
check('the bundled registry carries the skill', command !== undefined, getBundledSkills().map(item => item.name).join(' '))
check(
  'an inline prompt skill that both the model and the user may invoke',
  command?.type === 'prompt' && command.loadedFrom === 'bundled' && command.userInvocable !== false && command.isHidden !== true && command.disableModelInvocation !== true && command.context === undefined,
  JSON.stringify(command === undefined ? null : { type: command.type, userInvocable: command.userInvocable, isHidden: command.isHidden }),
)
check('the registered description and argument hint are the SKILL.md ones', command !== undefined && command.description === description && command.argumentHint === hint, `${command?.description} / ${command?.argumentHint}`)
check('the hint requires an argument, so a bare slash send answers its usage', command !== undefined && requiresArgument(command), String(hint))
check('the Skill tool universe holds it', (await getSkillToolCommands(project)).some(item => item.name === NAME))
check('the slash roster holds it', (await getCommands(project)).some(item => item.name === NAME))
resetSentSkillNames()
const listing = (await getSkillListingAttachments(context())).map(attachment => String((attachment as { content?: unknown }).content ?? '')).join('\n')
const line = listing.split('\n').find(row => row.startsWith(`- ${NAME}: `)) ?? ''
const docsLine = listing.split('\n').find(row => row.startsWith(`- ${MERCURY_DOCS_SKILL_NAME}: `)) ?? ''
check(`the description fits the ${MAX_LISTING_DESC_CHARS}-character listing cap`, description.length > 0 && description.length <= MAX_LISTING_DESC_CHARS, `${description.length} characters`)
check('the listing line the model reads is the whole description, with no ellipsis', line === `- ${NAME}: ${description}`, line || '(no line)')
check('the description opens on its trigger', description.startsWith('Use when making or editing images with Mercury image generation'), description)
check('the same listing carries the mercury-docs line', docsLine.startsWith(`- ${MERCURY_DOCS_SKILL_NAME}: Use when the user asks how to use Mercury itself`), docsLine)

section('§3 ROUTING: the positive example is in scope; the negative belongs to mercury-docs (listing metadata and loaded guidance, not a model choice)')
const [trigger = '', exclusion = ''] = description.split(' Not for ')
const inScope = (clause: string): boolean => /\bmaking or editing images\b/.test(clause) && clause.includes('Mercury image generation') && /\bpixel art\b/.test(clause) && /\breference\b/.test(clause)
const excludesNegative = (clause: string): boolean => /\binstalling Mercury\b/.test(clause) && /\bsign-in\b/.test(clause)
check(`positive "${POSITIVE}": the trigger names making images with Mercury image generation, pixel art and a reference`, inScope(trigger), trigger)
check('positive: the exclusion names none of it', exclusion !== '' && !/image|pixel|reference/i.test(exclusion), exclusion)
check(`negative "${NEGATIVE}": the exclusion names installing Mercury and sign-in`, excludesNegative(exclusion), exclusion)
check('negative: the trigger claims neither', trigger !== '' && !/install|sign/i.test(trigger), trigger)
const pages = mercuryDocPages()
check("the docs skill's pages loaded through its build-time page macro", Object.keys(pages).length > 1 && typeof pages['README.md'] === 'string', `${Object.keys(pages).length} pages`)
check('negative: mercury-docs claims how-to questions and ships the pages that answer both (README Install, ENGINES sign-in)', docsLine.includes('how to use Mercury itself') && /^## Install/m.test(pages['README.md'] ?? '') && /sign-in/.test(pages['docs/ENGINES.md'] ?? ''))
check('the loaded guidance names both examples and sends the negative to mercury-docs', body.includes(`“${POSITIVE.slice(0, -1)}” loads this skill`) && body.includes(`“${NEGATIVE}” does not`) && body.includes('mercury-docs'))
check('poison control: a trigger without pixel art fails the positive predicate', !inScope(trigger.replace('pixel art', 'art')))
check('poison control: an exclusion without sign-in fails the negative predicate', !excludesNegative(exclusion.replace('sign-in', 'billing')))

section('§4 INVOCATION: the Skill tool and the slash command append the argument to the body after the supplied base directory')
const extractDir = getBundledSkillExtractDir(NAME)
const validation = await SkillTool.validateInput({ skill: NAME }, context())
check('the Skill tool accepts the name', validation.result === true, JSON.stringify(validation))
const permission = await SkillTool.checkPermissions({ skill: NAME }, context())
check('the Skill tool runs it without a permission ask', permission.behavior === 'allow', permission.behavior)
let modelBodies: string[] = []
let callError = ''
try {
  const called = (await SkillTool.call({ skill: NAME, args: POSITIVE }, context(), canUse, parent)) as { data: { success: boolean; commandName: string }; newMessages?: Message[] }
  modelBodies = bodiesOf(called.newMessages)
  check('the call loads the skill under its name', called.data.success === true && called.data.commandName === NAME, JSON.stringify(called.data))
} catch (error) {
  callError = error instanceof Error ? error.message : String(error)
}
check('the Skill tool call expanded the skill once', modelBodies.length === 1, callError || `${modelBodies.length} bodies`)
const expanded = modelBodies[0] ?? ''
check('the expansion opens on the base-directory line naming the extract directory', expanded.startsWith(`Base directory for this skill: ${extractDir} (`), expanded.slice(0, 160))
check('the SKILL.md body follows verbatim with its frontmatter stripped', body.length > 0 && expanded.includes(body.trimEnd()) && !/^(?:description|argument-hint|name):/m.test(expanded))
check('the argument rides last, after a blank line', expanded.endsWith(`\n\n${POSITIVE}`), expanded.slice(-120))
check('the source relies on no disk-only substitution token', sourceMd !== '' && !/\$ARGUMENTS|\$\{MERCURY_SKILL_DIR\}|\$\{MERCURY_SESSION_ID\}|\$\d/.test(sourceMd))
check('the text loader carried Markdown, never rendered HTML', expanded !== '' && !/<(?:h1|h2|p|ul|li|code)>/.test(expanded))
if (command !== undefined) {
  const slashContext = context([command], true) as never
  const typed = await processSlashCommand(`/${NAME} ${POSITIVE}`, [], [], [], slashContext, () => {})
  const typedBodies = bodiesOf(typed.messages as Message[])
  check('a typed /image-generation with an argument starts a turn carrying the same expansion', typed.shouldQuery === true && typedBodies.length === 1 && typedBodies[0] === expanded, `shouldQuery=${typed.shouldQuery} bodies=${typedBodies.length}`)
  const bare = await processSlashCommand(`/${NAME}`, [], [], [], slashContext, () => {})
  check('a bare /image-generation answers its usage row and starts no turn', bare.shouldQuery === false && bare.resultText === bareUsageLine(command), String(bare.resultText))
} else {
  check('the slash command expands the skill', false, 'no registered skill')
}

section('§5 REFERENCES: every file the skill names ships and extracts byte for byte; the media guide it points to ships with mercury-docs')
check('the skill carries reference files', references.length > 0, references.join(' '))
for (const rel of references) {
  const extracted = join(extractDir, rel)
  check(`${rel}: extracted byte-identical to the source`, existsSync(extracted) && readFileSync(extracted, 'utf8') === readFileSync(join(SOURCE, rel), 'utf8'))
  check(`${rel}: named in the body by its path relative to the base directory`, body.includes(`\`${rel}\``))
}
const namedReferences = backticked(skillFiles, /`(references\/[A-Za-z0-9._/-]+)`/g)
check('every reference path the skill names exists', namedReferences.length > 0 && namedReferences.every(rel => references.includes(rel)), namedReferences.filter(rel => !references.includes(rel)).join(' '))
check('nothing but the reference files is extracted', JSON.stringify(walk(extractDir)) === JSON.stringify(references), walk(extractDir).join(' '))
const mediaGuide = readFileSync(join(ROOT, 'docs', 'MEDIA.md'), 'utf8')
check('the body points to docs/MEDIA.md through mercury-docs', body.includes('`docs/MEDIA.md`') && /mercury-docs skill ships/.test(body))
check('mercury-docs ships docs/MEDIA.md byte for byte', pages['docs/MEDIA.md'] === mediaGuide)
const builtinNames = new Set(builtinCommands().flatMap(item => [item.name, ...(item.aliases ?? [])]))
const commandsNamed = backticked(skillFiles, /`\/([a-z][a-z-]*)[^`]*`/g)
check('every slash command the skill names is a Mercury command', commandsNamed.length > 0 && commandsNamed.every(name => builtinNames.has(name)), commandsNamed.filter(name => !builtinNames.has(name)).join(' ') || commandsNamed.join(' '))

section('§6 CONTRACT: shipped MCP schemas, every documented input and enum, and typed examples; no diffusion runtime starts')
type Schema = { properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[]; enum?: unknown[]; const?: unknown; additionalProperties?: unknown }
const pathsOf = (schema: Schema, prefix = ''): string[] => [
  ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return [path, ...pathsOf(child, path)]
  }),
  ...(schema.items ? pathsOf(schema.items, `${prefix}[]`) : []),
  ...[...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].flatMap(branch => pathsOf(branch, prefix)),
]
const enumsOf = (schema: Schema): string[] => [
  ...(schema.enum ?? []).filter((value): value is string => typeof value === 'string'),
  ...(typeof schema.const === 'string' ? [schema.const] : []),
  ...Object.values(schema.properties ?? {}).flatMap(enumsOf),
  ...(schema.items ? enumsOf(schema.items) : []),
  ...[...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].flatMap(enumsOf),
]
const sorted = (values: Iterable<string>): string => [...new Set(values)].sort().join(' ')
const inventoryText = skillFiles.find(([rel]) => rel === 'references/tools.md')?.[1] ?? ''
const inventory = new Map([...inventoryText.matchAll(/^\| `([a-z_]+)` \| ([^\n]+) \|$/gm)].map(match => [match[1]!, [...match[2]!.matchAll(/`([^`]+)`/g)].map(field => field[1]!)]))
const noNull = (value: unknown): boolean => value !== null && (Array.isArray(value) ? value.every(noNull) : typeof value !== 'object' || Object.values(value).every(noNull))
const client = new Client({ name: 'image-generation-skill-proof', version: '1' })
try {
  await client.connect(new StdioClientTransport({ command: 'node', args: [MEDIA_SERVER], cwd: scratch, env: { PATH: process.env.PATH ?? '', MEDIA_ROOT: join(scratch, 'media'), HOME: join(scratch, 'home'), TMPDIR: join(scratch, 'tmp') }, stderr: 'pipe' }))
  const tools = (await client.listTools()).tools
  const schemas = new Map(tools.map(tool => [tool.name, tool.inputSchema as Schema]))
  const toolNames = new Set(schemas.keys())
  check('the inventory teaches every shipped media tool, without aliases or invented tools', sorted(inventory.keys()) === sorted(toolNames), `${sorted(inventory.keys())} vs ${sorted(toolNames)}`)
  for (const [name, schema] of schemas) {
    check(`${name}: closed input schema`, schema.additionalProperties === false)
    check(`${name}: documented fields equal the shipped fields, including nested objects and arrays`, sorted(inventory.get(name) ?? []) === sorted(pathsOf(schema)), `documented ${sorted(inventory.get(name) ?? [])}; shipped ${sorted(pathsOf(schema))}`)
  }
  const described = await client.callTool({ name: 'pipeline_describe', arguments: {} })
  const pipelineSchema = (described.structuredContent as { schema?: Schema } | undefined)?.schema
  check('pipeline_describe returns the actual step document schema without running a step', pipelineSchema !== undefined && described.isError !== true)
  schemas.set('pipeline', pipelineSchema ?? {})
  const imageSchema = schemas.get('image_generate') ?? {}
  const image = compileJsonSchema(imageSchema)
  check('image schema compiles in Mercury', image.ok, image.ok ? '' : image.error)
  const catalogue = JSON.parse(readFileSync(join(ROOT, 'src', 'extensions', 'bundled', 'mercury-media', 'server', 'catalog.json'), 'utf8')) as { models: Array<{ id: string; control?: { kind: string } }> }
  const vocabulary = new Set([...toolNames, ...[...schemas.values()].flatMap(schema => pathsOf(schema)), ...[...schemas.values()].flatMap(enumsOf), ...catalogue.models.flatMap(row => [row.id, ...(row.control ? [row.control.kind] : [])])])
  for (const path of [...vocabulary]) for (const part of path.replaceAll('[]', '').split('.')) vocabulary.add(part)
  check('media.host is a product setting, not a media tool argument', mediaGuide.includes('`media.host`') && !pathsOf(imageSchema).includes('media.host'))
  vocabulary.add('media.host'); vocabulary.add('null')
  const unknownNames = (text: string): string[] => [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)]
    .map(match => match[1]!).filter(token => /^[A-Za-z][A-Za-z0-9_.+\-[\]]*$/.test(token) && !vocabulary.has(token))
  for (const [rel, text] of skillFiles) check(`${rel}: every inline tool, field and enum name exists in the shipped schemas`, unknownNames(text).length === 0, unknownNames(text).join(', '))
  check('poison controls: an invented tool, field and nested field fail the vocabulary check', unknownNames('`pipeline_imagine` `reference_image_typo` `control.missing`').length === 3)
  const renamed = structuredClone(imageSchema)
  if (renamed.properties) { renamed.properties.reference_image_renamed = renamed.properties.reference_image!; delete renamed.properties.reference_image }
  check('poison control: a future engine field rename makes the inventory fail', sorted(inventory.get('image_generate') ?? []) !== sorted(pathsOf(renamed)))
  for (const [field, label] of [['sampler', 'Sampler'], ['scheduler', 'Scheduler']] as const) {
    const row = inventoryText.split('\n').find(line => line.startsWith(`${label} enum:`)) ?? ''
    const names = [...row.matchAll(/`([^`]+)`/g)].map(match => match[1]!)
    check(`${field}: documented enum exactly matches the shipped enum`, sorted(names) === sorted(enumsOf(imageSchema.properties?.[field] ?? {})), sorted(names))
  }
  check('default-slot kinds are image and video', sorted(enumsOf(schemas.get('media_set_default')?.properties?.kind ?? {})) === 'image video' && inventoryText.includes('`kind` (image or video)'))
  check('video VAE devices are metal and cpu', sorted(enumsOf(schemas.get('video_generate')?.properties?.vae_backend ?? {})) === 'cpu metal' && inventoryText.includes('`vae_backend` accepts `metal` or `cpu`'))
  const pipelineText = skillFiles.find(([rel]) => rel === 'references/pipelines.md')?.[1] ?? ''
  const documentedKinds = [...pipelineText.matchAll(/^\| `([a-z-]+)` \|/gm)].map(match => match[1]!)
  const stepSchema = pipelineSchema?.properties?.steps?.items
  const stepBranches = [...(stepSchema?.anyOf ?? []), ...(stepSchema?.oneOf ?? [])]
  check('the step table teaches every schema kind, without invented kinds', sorted(documentedKinds) === sorted(stepBranches.flatMap(branch => enumsOf(branch.properties?.kind ?? {}))), sorted(documentedKinds))
  const generationFields = Object.keys(imageSchema.properties ?? {}).filter(field => !['cwd', 'wait', 'dry', 'export_workflow'].includes(field))
  for (const branch of stepBranches.filter(branch => ['generate', 'edit', 'control'].includes(String(branch.properties?.kind?.const)))) {
    check(`${branch.properties?.kind?.const}: generation-step fields exclude job controls`, sorted(Object.keys(branch.properties?.inputs?.properties ?? {})) === sorted(generationFields))
  }
  const examples = skillFiles.flatMap(([rel, text]) => [...text.matchAll(/(?:Tool|Document): `([^`]+)`\n```json\n([\s\S]*?)\n```/g)].map(match => ({ rel, name: match[1]!, text: match[2]! })))
  const fencedCount = skillFiles.reduce((n, [, text]) => n + [...text.matchAll(/```json\n/g)].length, 0)
  check('every JSON example names its actual tool or the pipeline document schema', examples.length >= 10 && examples.length === fencedCount, `${examples.length}/${fencedCount}`)
  const { Ajv2020 } = await import('ajv/dist/2020.js')
  const pipelineValidator = new Ajv2020({ allErrors: true, logger: false }).compile(pipelineSchema ?? false)
  const compiledPipeline = { ok: true as const, check: (value: unknown) => pipelineValidator(value) ? [] : (pipelineValidator.errors ?? []).map(error => ({ path: error.instancePath || 'root', message: error.message ?? 'failed validation', keyword: error.keyword })) }
  for (const example of examples) {
    const compiled = example.name === 'pipeline' ? compiledPipeline : compileJsonSchema(schemas.get(example.name) ?? false)
    const value = JSON.parse(example.text) as Record<string, unknown>
    const issues = compiled.ok ? compiled.check(value) : [{ path: 'root', message: compiled.error, keyword: 'compile' }]
    const crossField = example.name === 'image_generate'
      ? (value.prompt !== undefined || value.workflow !== undefined) && (value.reference_image !== undefined || (value.strength === undefined && value.mask === undefined)) && (value.sheet === undefined || (value.sheet as { columns: number }).columns <= Number(value.count ?? 1)) && (value.upscaler === undefined || Number(value.upscale) > 1)
      : example.name === 'video_generate' ? value.frames === undefined || value.seconds === undefined
      : example.name === 'pipeline_run' ? value.resume === undefined || value.step !== undefined : true
    check(`${example.rel}: ${example.name} example validates with no null placeholders`, schemas.has(example.name) && issues.length === 0 && noNull(value) && crossField, formatSchemaIssues(issues))
    if (compiled.ok) check(`${example.name}: an extra field in this example is refused`, compiled.check({ ...value, not_a_field: 1 }).length > 0)
    if (example.name === 'pipeline') {
      const validation = await client.callTool({ name: 'pipeline_validate', arguments: { pipeline: value, cwd: project } })
      check('the worked pipeline also satisfies the engine reference/order rules without rendering', (validation.structuredContent as { valid?: boolean } | undefined)?.valid === true, JSON.stringify(validation.structuredContent))
    }
  }
  check('poison control: a nested null placeholder fails the skill example policy even when a tool accepts null', !noNull({ loras: [{ path: 'style.safetensors', weight: null }] }))
  const bounds: Array<[string, string, number, number, boolean]> = [
    ['image_generate', 'width', 64, 4096, true], ['image_generate', 'height', 64, 4096, true], ['image_generate', 'steps', 1, 1000, true],
    ['image_generate', 'seed', -1, Number.MAX_SAFE_INTEGER, true], ['image_generate', 'strength', 0, 1, false], ['image_generate', 'cfg', 0, 100, false],
    ['image_generate', 'clip_skip', 1, 12, true], ['image_generate', 'downsize', 1, 64, true], ['image_generate', 'count', 1, 16, true],
    ['media_result', 'timeout', 0, 86400, false], ['video_generate', 'frames', 1, 4096, true], ['video_generate', 'fps', 1, 240, true],
    ['video_generate', 'timeout_seconds', 1, 86400, true], ['video_generate', 'vae_tile_size', 128, 4096, true], ['video_generate', 'temporal_decode_frames', 1, 16, true],
  ]
  for (const [name, field, min, max, integer] of bounds) {
    const compiled = compileJsonSchema(schemas.get(name)?.properties?.[field] ?? false)
    const accepts = (value: number) => compiled.ok && compiled.check(value).length === 0
    check(`${name}.${field}: documented bounds and numeric unit type`, accepts(min) && accepts(max) && !accepts(min - 1) && !accepts(max + 1) && (integer ? !accepts(min + 0.5) : accepts(min + 0.5)))
  }
  for (const [name, schema] of tools.map(tool => [tool.name, tool.inputSchema] as const)) {
    const marker = `server.registerTool("${name}"`
    const bundled = readFileSync(MEDIA_SERVER, 'utf8')
    const offset = bundled.indexOf(marker)
    check(`${name}: schema came from a registered vendored tool`, offset >= 0 && schema !== undefined)
    if (offset >= 0) console.log(`  schema source: server.js:${bundled.slice(0, offset).split('\n').length} ${name}`)
  }
  check('schema-only calls left no weights or diffusion runtime in the scratch media root', !existsSync(join(scratch, 'media', 'models')) && !existsSync(join(scratch, 'media', 'runtime')))
} catch (error) {
  check('the vendored media server answers schema-only requests', false, error instanceof Error ? error.message : String(error))
} finally {
  await client.close().catch(() => {})
}

section('§7 THE WORDS: no em or en dash, and ComfyUI only as the format of a workflow file')
for (const [rel, text] of skillFiles) {
  check(`${rel}: no em or en dash`, !/[\u2013\u2014]/.test(text))
  check(`${rel}: the skill does not prescribe installing a separate workflow engine`, !/install (?:a |the )?ComfyUI/i.test(text))
}
check('unused optionals are omitted, never null placeholders', body.includes('Omit unused optional fields entirely; never send `null`') && body.includes('omit `reference_image`, `strength` and `mask`'))
check('state and catalogue reads precede choosing a model or size', body.includes('Before any render, call `media_status`') && body.includes('then `media_models`') && body.includes('Use these results before choosing a model or size'))
check('invalid fields are corrected and the same tool retried, never silently replaced', body.includes('correct or omit it and call the same media tool again') && body.includes("getting the user's agreement") && body.includes('Do not retry a permission denial'))
check('the words were read from the shipped files', skillFiles.length === references.length + 1 && skillFiles.length > 1)

console.log("\nRouting evidence: the listing line, the description's clauses and the loaded body, read through the real loader. No model ran, so this shows eligibility, not the model's choice.")
console.log(`\n${failures === 0 ? `IMAGE GENERATION SKILL GREEN (${checks} checks)` : `IMAGE GENERATION SKILL RED (${failures} of ${checks})`}`)
process.exit(failures === 0 ? 0 : 1)
