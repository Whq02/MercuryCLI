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
const BUILD_FIELDS = ['sampler', 'scheduler', 'cfg', 'clip_skip', 'embeddings', 'upscale', 'upscaler', 'workflow', 'dry', 'export_workflow']
const BUILD_FIELDS_HEADING = '## Fields some builds add'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'image-generation-skill-')))
const project = join(scratch, 'project')
for (const dir of ['home', 'tmp', 'media', 'project']) mkdirSync(join(scratch, dir), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_TMPDIR = join(scratch, 'tmp')
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
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

section('§6 EXAMPLES AGAINST THE LIVE SCHEMA: every JSON example validates against the image_generate schema the vendored media server lists')
const client = new Client({ name: 'image-generation-skill-proof', version: '1' })
try {
  await client.connect(new StdioClientTransport({ command: 'node', args: [MEDIA_SERVER], cwd: scratch, env: { PATH: process.env.PATH ?? '', MEDIA_ROOT: join(scratch, 'media') }, stderr: 'pipe' }))
  const tools = (await client.listTools()).tools
  const toolNames = new Set(tools.map(tool => tool.name))
  const schema = tools.find(tool => tool.name === 'image_generate')?.inputSchema as { properties?: Record<string, unknown>; additionalProperties?: unknown } | undefined
  check('the vendored server lists image_generate with a closed schema', schema !== undefined && schema.additionalProperties === false)
  const toolsNamed = backticked(skillFiles, /`((?:media_[a-z_]+|image_generate|video_generate))`/g)
  check('every media tool the skill names is listed by the server and tabled in the media guide', toolsNamed.length >= 4 && toolsNamed.every(name => toolNames.has(name) && mediaGuide.includes(`| \`${name}\` |`)), toolsNamed.join(' '))
  const compiled = compileJsonSchema(schema ?? {})
  check("the schema compiles in Mercury's JSON schema engine", compiled.ok, compiled.ok ? '' : compiled.error)
  const examples = skillFiles.flatMap(([rel, text]) => [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => ({ rel, text: match[1]! })))
  check('the skill carries worked examples', examples.length >= 3, String(examples.length))
  for (const example of examples) {
    let value: Record<string, unknown> | null = null
    try {
      value = JSON.parse(example.text) as Record<string, unknown>
    } catch {
      value = null
    }
    const issues = value !== null && compiled.ok ? compiled.check(value) : [{ path: 'root', message: 'not valid JSON', keyword: 'parse' }]
    const crossField =
      value !== null &&
      (value.reference_image !== undefined || (value.strength === undefined && value.mask === undefined)) &&
      (value.sheet === undefined || (value.sheet as { columns: number }).columns <= Number(value.count ?? 1))
    check(`${example.rel}: ${example.text.slice(0, 64)}... validates, and keeps the server's cross-field rules`, issues.length === 0 && crossField, formatSchemaIssues(issues))
  }
  const first = examples[0] === undefined ? null : (JSON.parse(examples[0].text) as Record<string, unknown>)
  check('poison control: an example with a field the schema does not list is refused, as the skill says', compiled.ok && first !== null && compiled.check({ ...first, not_a_field: 1 }).length > 0)
  const listed = new Set(Object.keys(schema?.properties ?? {}))
  const unlisted = BUILD_FIELDS.filter(field => !listed.has(field))
  console.log(`  this build's image_generate lists ${listed.size} fields; of the fields some builds add, it lists: ${BUILD_FIELDS.filter(field => listed.has(field)).join(', ') || 'none'}`)
  const ungated: string[] = []
  for (const [rel, text] of skillFiles) {
    let heading = ''
    for (const row of text.split('\n')) {
      if (row.startsWith('#')) heading = row.trim()
      for (const field of unlisted) if (row.includes(`\`${field}\``) && heading !== BUILD_FIELDS_HEADING && !row.includes('schema lists')) ungated.push(`${rel}: ${field}`)
    }
  }
  check('a field this build does not list is named only beside the rule that the live schema must list it', skillFiles.length > 0 && ungated.length === 0, ungated.join(' | '))
} catch (error) {
  check('the vendored media server answers tools/list', false, error instanceof Error ? error.message : String(error))
} finally {
  await client.close().catch(() => {})
}

section('§7 THE WORDS: no em or en dash, and ComfyUI only as the format of a workflow file')
for (const [rel, text] of skillFiles) {
  check(`${rel}: no em or en dash`, !/[\u2013\u2014]/.test(text))
  const comfy = text.split('\n').filter(row => /comfy/i.test(row))
  check(`${rel}: ComfyUI appears only beside the workflow fields`, comfy.every(row => /`(?:workflow|export_workflow)`/.test(row)), comfy.join(' | '))
}
check('the words were read from the shipped files', skillFiles.length === references.length + 1 && skillFiles.length > 1)

console.log("\nRouting evidence: the listing line, the description's clauses and the loaded body, read through the real loader. No model ran, so this shows eligibility, not the model's choice.")
console.log(`\n${failures === 0 ? `IMAGE GENERATION SKILL GREEN (${checks} checks)` : `IMAGE GENERATION SKILL RED (${failures} of ${checks})`}`)
process.exit(failures === 0 ? 0 : 1)
