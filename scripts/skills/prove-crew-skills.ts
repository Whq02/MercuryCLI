import { plugin } from 'bun'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'prove-crew-skills-')))
const HOME = join(SCRATCH, 'home')
const TMP = join(SCRATCH, 'tmp')
const PROJ = join(SCRATCH, 'project')
for (const dir of [HOME, TMP, PROJ]) mkdirSync(dir, { recursive: true })

process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = TMP
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_WORKFLOWS = '0'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CRITTER
delete process.env.MERCURY_SESSION_KIT
delete process.env.MERCURY_SKILL_CHAR_BUDGET
delete process.env.MERCURY_SESSION_WORKFLOWS

const guard = setTimeout(() => {
  console.error('TIMEOUT: prove-crew-skills exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

plugin({
  name: 'crew-skills-md-loader',
  setup(build: { onLoad: (opts: { filter: RegExp }, cb: (args: { path: string }) => { contents: string; loader: 'js' }) => void }) {
    build.onLoad({ filter: /\.md$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(readFileSync(path, 'utf8'))}`,
      loader: 'js',
    }))
  },
})

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  const suffix = !ok && detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${suffix}`)
}
function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

const fixtureTurns = Array.from({ length: 24 }, (_, i) => ({ kind: 'text' as const, text: `FIXTURE-SEAT-${i + 1}-DONE` }))
const fixture = await startFixtureApi(fixtureTurns)
process.env.ANTHROPIC_BASE_URL = fixture.url
process.env.ANTHROPIC_API_KEY = FIXTURE_API_KEY

process.on('exit', () => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(PROJ)
bootstrap.setCwdState(PROJ)
bootstrap.setProjectRoot(PROJ)
bootstrap.setSessionTrustAccepted(true)
bootstrap.setIsInteractive(false)
process.chdir(PROJ)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
const { initBundledSkills } = await import('../../src/skills/bundled/index.ts')
const { clearCommandsCache, getCommands, getSkillToolCommands } = await import('../../src/commands.ts')
const { MAX_LISTING_DESC_CHARS } = await import('../../src/tools/SkillTool/constants.ts')
const { formatCommandsWithinBudgetDetailed } = await import('../../src/tools/SkillTool/prompt.ts')
const { SkillTool } = await import('../../src/tools/SkillTool/SkillTool.ts')
const { getSkillListingAttachments, resetSentSkillNames } = await import('../../src/utils/attachments/skillListing.ts')
const { bareUsageLine, requiresArgument } = await import('../../src/skills/argumentHint.ts')
const { parseFrontmatter } = await import('../../src/utils/frontmatterParser.ts')
const { processSlashCommand } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const seam = await import('../../src/services/crewBoard/seam.ts')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
const { AgentTool, inputSchema: getAgentInputSchema } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.ts')
const { SYNTHETIC_OUTPUT_TOOL_NAME } = await import('../../src/tools/SyntheticOutputTool/constants.ts')
const { compileJsonSchema } = await import('../../src/services/schema/jsonSchemaEngine.ts')
await import('../../src/tasks.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')

type Command = import('../../src/types/command.ts').Command
type AppState = ReturnType<typeof getDefaultAppState>

initBundledSkills()
clearCommandsCache()

section('1. Discovery, listing fit, argument hints, and expansion with MERCURY_WORKFLOWS=0')

const allCommands = await getCommands(PROJ)
const skillCommands = await getSkillToolCommands(PROJ)
const bySkillName = new Map(skillCommands.map(cmd => [cmd.name, cmd]))
const deepCmd = bySkillName.get('deep-research')
const reviewCmd = bySkillName.get('code-review')

check('deep-research is discovered through getCommands and getSkillToolCommands with MERCURY_WORKFLOWS=0', deepCmd !== undefined && allCommands.some(c => c.name === 'deep-research'))
check('code-review is discovered through getCommands and getSkillToolCommands with MERCURY_WORKFLOWS=0', reviewCmd !== undefined && allCommands.some(c => c.name === 'code-review'))
check(
  'neither command is backed by the retired workflow road',
  deepCmd?.kind !== 'workflow' && reviewCmd?.kind !== 'workflow' && deepCmd?.loadedFrom === 'bundled' && reviewCmd?.loadedFrom === 'bundled',
  { deepKind: deepCmd?.kind, reviewKind: reviewCmd?.kind },
)
check(
  'both skills are user-invocable and model-invocable',
  deepCmd !== undefined && reviewCmd !== undefined && deepCmd.userInvocable !== false && deepCmd.disableModelInvocation !== true && reviewCmd.userInvocable !== false && reviewCmd.disableModelInvocation !== true,
)

const { content: listingContent, truncation } = formatCommandsWithinBudgetDetailed(skillCommands)
resetSentSkillNames()
const attachments = await getSkillListingAttachments({
  options: { tools: [SkillTool], engineModel: 'claude-opus-4-8' },
  getAppState: () => ({ mcp: { commands: [] } }),
} as never)
const attachedText = attachments.map(a => String((a as { content?: unknown }).content ?? '')).join('\n')
check('the full skill listing fits without truncation and matches the attachment builder', truncation === null && attachedText === listingContent, truncation)

for (const [name, siblingNeedle] of [
  ['deep-research', 'research'],
  ['code-review', 'review_receipt'],
] as const) {
  const cmd = bySkillName.get(name)
  const line = listingContent.split('\n').find(r => r.startsWith(`- ${name}: `)) ?? ''
  const listed = line.slice(`- ${name}: `.length)
  const rawDesc = String(cmd?.description ?? '')
  check(`${name}: listed whole within ${MAX_LISTING_DESC_CHARS} chars with no ellipsis`, rawDesc.length > 0 && rawDesc.length <= MAX_LISTING_DESC_CHARS && listed === rawDesc && !listed.includes('…') && !listed.endsWith('...'), { len: rawDesc.length, listed })
  check(`${name}: description opens with trigger and names sibling boundary (${siblingNeedle})`, /^Use when\b/.test(listed) && /\bNot for\b/.test(listed) && listed.includes(siblingNeedle), listed)
}

check('/deep-research requires <question> on bare send and fits the 178-column usage row', deepCmd !== undefined && requiresArgument(deepCmd) && bareUsageLine(deepCmd).length <= 178)
check('/code-review runs bare with optional [target]', reviewCmd !== undefined && !requiresArgument(reviewCmd) && reviewCmd.argumentHint === '[target]')

const makeSlashContext = (commands: Command[]) => ({
  options: { commands, tools: [SkillTool], mcpClients: [], mcpResources: {}, engineModel: 'claude-opus-4-8', agentDefinitions: { activeAgents: getBuiltInAgents(), allAgents: getBuiltInAgents() }, debug: false, verbose: false, isNonInteractiveSession: false },
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
  messages: [],
  agentId: 'main',
})

const bareDeep = await processSlashCommand('/deep-research', [], [], [], makeSlashContext(allCommands) as never, () => {})
check('bare /deep-research answers its usage line without starting a turn', deepCmd !== undefined && bareDeep.shouldQuery === false && bareDeep.resultText === bareUsageLine(deepCmd), bareDeep.resultText)

const argDeep = await processSlashCommand('/deep-research compare sqlite wal and rollback modes', [], [], [], makeSlashContext(allCommands) as never, () => {})
const bareReview = await processSlashCommand('/code-review', [], [], [], makeSlashContext(allCommands) as never, () => {})
const argReview = await processSlashCommand('/code-review xhigh HEAD~1..HEAD', [], [], [], makeSlashContext(allCommands) as never, () => {})

const extractExpandedText = (messages: unknown[]): string =>
  messages
    .flatMap(m => {
      const content = (m as { message?: { content?: unknown } }).message?.content
      if (typeof content === 'string') return [content]
      if (Array.isArray(content)) return content.map(b => String((b as { text?: unknown }).text ?? ''))
      return []
    })
    .join('\n')

const deepExpanded = extractExpandedText(argDeep.messages)
const reviewBareExpanded = extractExpandedText(bareReview.messages)
const reviewArgExpanded = extractExpandedText(argReview.messages)

const deepPath = join(ROOT, 'mercury-skills', 'deep-research', 'SKILL.md')
const reviewPath = join(ROOT, 'mercury-skills', 'code-review', 'SKILL.md')
const deepSource = existsSync(deepPath) ? parseFrontmatter(readFileSync(deepPath, 'utf8')).content.trimStart() : ''
const reviewSource = existsSync(reviewPath) ? parseFrontmatter(readFileSync(reviewPath, 'utf8')).content.trimStart() : ''

check('deep-research expands through processSlashCommand with its full body and appended argument', deepSource !== '' && argDeep.shouldQuery === true && deepExpanded.includes(deepSource) && deepExpanded.endsWith('compare sqlite wal and rollback modes'))
check('bare /code-review expands through processSlashCommand and starts a turn', reviewSource !== '' && bareReview.shouldQuery === true && reviewBareExpanded.includes(reviewSource))
check('/code-review with effort and target appends the argument verbatim', reviewSource !== '' && argReview.shouldQuery === true && reviewArgExpanded.includes(reviewSource) && reviewArgExpanded.endsWith('xhigh HEAD~1..HEAD'))
check(
  'neither bundled skill uses disk-only substitution tokens',
  ![deepSource, reviewSource].some(text => /\$ARGUMENTS|\$[0-9]\b|\$\{MERCURY_SKILL_DIR\}|\$\{MERCURY_SESSION_ID\}/.test(text)),
)

section('2. Schema and registry validation of every code-font tool, parameter, type, op, kind, and JSON Schema')

const allTools = [...getAllBaseTools('main'), seam.swarmCensusTool()]
const registeredToolNames = new Set<string>([...allTools.map(t => t.name), SYNTHETIC_OUTPUT_TOOL_NAME])
const toolByName = new Map(allTools.map(t => [t.name, t]))

const jsonPropsOf = (schema: unknown): { properties: Record<string, Record<string, unknown>>; required: string[] } => {
  const rendered = z.toJSONSchema(schema as z.ZodType) as { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  return { properties: rendered.properties ?? {}, required: rendered.required ?? [] }
}

const agentSchema = getAgentInputSchema()
const agentJson = jsonPropsOf(agentSchema)
const agentParamNames = new Set(Object.keys(agentJson.properties))
const builtInAgentTypes = new Set(getBuiltInAgents().map(a => a.agentType))
const effortEnum = new Set<string>((agentJson.properties.effort?.enum as string[] | undefined) ?? [])

const boardTool = seam.swarmCensusTool()
const boardJson = jsonPropsOf(boardTool.inputSchema)
const boardParamNames = new Set(Object.keys(boardJson.properties))
const boardOps = new Set<string>((boardJson.properties.op?.enum as string[] | undefined) ?? [])
const boardKinds = new Set<string>((boardJson.properties.kind?.enum as string[] | undefined) ?? [])

const gitJson = jsonPropsOf(toolByName.get('Git')!.inputSchema)
const gitOps = new Set<string>((gitJson.properties.op?.enum as string[] | undefined) ?? [])

const codeSpansOf = (markdown: string): string[] => {
  const withoutFences = markdown.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
  const spans: string[] = []
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g)) spans.push(match[1]!.trim())
  return spans
}

const bothTexts = `${deepSource}\n${reviewSource}`
const allSpans = codeSpansOf(bothTexts)

const pascalToolCandidates = allSpans.filter(span => /^[A-Z][A-Za-z0-9]+$/.test(span) && !['HEAD', 'SUPPORTED', 'CONTRADICTED', 'UNSUPPORTED', 'CONFIRMED', 'REFUTED', 'UNPROVEN', 'URL', 'SHA', 'PR'].includes(span))
const unknownTools = [...new Set(pascalToolCandidates.filter(name => !registeredToolNames.has(name)))]
check('every PascalCase tool identifier in code font exists in the product tool registries', unknownTools.length === 0, unknownTools)

const keyValuePairs: Array<{ key: string; rawVal: string; span: string }> = []
for (const span of allSpans) {
  for (const m of span.matchAll(/(?:^|[,{\s])([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*("[^"]*"|'[^']*'|true|false|[0-9]+|\{[\s\S]*\}|\[[^\]]*\])/g)) {
    keyValuePairs.push({ key: m[1]!, rawVal: m[2]!, span })
  }
}

const allKnownInputParams = new Set<string>([
  ...agentParamNames,
  ...boardParamNames,
  ...allTools.flatMap(t => {
    try {
      return Object.keys(jsonPropsOf(t.inputSchema).properties)
    } catch {
      return []
    }
  }),
  'type',
  'required',
  'properties',
  'items',
  'enum',
  'claims',
  'gaps',
  'claim',
  'url',
  'title',
  'date',
  'sourceTier',
  'quote',
  'rulings',
  'verdict',
  'evidence',
  'counterUrl',
  'candidates',
  'file',
  'line',
  'summary',
  'failureScenario',
  'proposedFix',
  'id',
])

const unknownKeys = [...new Set(keyValuePairs.map(p => p.key).filter(k => !allKnownInputParams.has(k)))]
check('every key: value parameter in code font exists in the product tool schemas or embedded output_schema definitions', unknownKeys.length === 0, unknownKeys)

const crewmateTypeMentions = [
  ...bothTexts.matchAll(/`crewmate_type:\s*"([^"]+)"`/g),
  ...bothTexts.matchAll(/`(mercury-[a-z0-9-]+)`/g),
].map(m => m[1]!)
const badAgentTypes = [...new Set(crewmateTypeMentions.filter(t => !builtInAgentTypes.has(t)))]
check('every crewmate_type named in code font exists in getBuiltInAgents()', crewmateTypeMentions.length >= 2 && badAgentTypes.length === 0, { crewmateTypeMentions, badAgentTypes })

const crewmateParamMentions = [
  'description',
  'prompt',
  'crewmate_type',
  'model',
  'effort',
  'run_in_background',
  'name',
  'team',
  'captain',
  'isolation',
  'worktree_at',
  'cwd',
  'review_receipt',
  'output_schema',
]
check(
  'every Crewmate parameter named in the two skills exists on AgentTool.inputSchema',
  crewmateParamMentions.every(p => agentParamNames.has(p)),
  crewmateParamMentions.filter(p => !agentParamNames.has(p)),
)

const boardOpMentions = [...bothTexts.matchAll(/`op:\s*"([^"]+)"`/g)].map(m => m[1]!)
const badOps = boardOpMentions.filter(op => !boardOps.has(op) && !gitOps.has(op))
check('every op: "<value>" in code font exists in CrewBoard or Git schemas', boardOpMentions.length > 0 && badOps.length === 0, { boardOpMentions, badOps })

const boardKindMentions = [...deepSource.matchAll(/`kind:\s*"([^"]+)"`/g)].map(m => m[1]!)
const badKinds = boardKindMentions.filter(k => !boardKinds.has(k))
check('every CrewBoard kind: "<value>" in code font exists in CrewBoard inputSchema', boardKindMentions.length > 0 && badKinds.length === 0, { boardKindMentions, badKinds })

for (const effortWord of ['low', 'medium', 'high', 'xhigh', 'max']) {
  check(`code-review effort word "${effortWord}" is valid in AgentTool.inputSchema`, reviewSource.includes(`\`${effortWord}\``) && effortEnum.has(effortWord))
}

const embeddedJsonSchemas: Array<{ label: string; schema: Record<string, unknown> }> = []
for (const [skillLabel, text] of [
  ['deep-research', deepSource],
  ['code-review', reviewSource],
] as const) {
  for (const m of text.matchAll(/`(?:output_schema:\s*)?(\{\s*"type":\s*"object"[^`]+\})`/g)) {
    const parsed = JSON.parse(m[1]!) as Record<string, unknown>
    embeddedJsonSchemas.push({ label: `${skillLabel}:${Object.keys((parsed.properties as Record<string, unknown>) ?? {}).join(',')}`, schema: parsed })
  }
}
check('all 4 embedded output_schema JSON Schema definitions are extracted from the two skills', embeddedJsonSchemas.length === 4, embeddedJsonSchemas.map(s => s.label))
for (const item of embeddedJsonSchemas) {
  const compiled = compileJsonSchema(item.schema)
  const validDispatch = agentSchema.safeParse({
    description: 'Validate schema dispatch',
    prompt: 'Return structured payload.',
    crewmate_type: 'mercury-crew',
    output_schema: item.schema,
  })
  check(`embedded output_schema (${item.label}) compiles in jsonSchemaEngine and validates on AgentTool.inputSchema`, compiled.ok === true && validDispatch.success === true, compiled.ok ? '' : compiled.error)
}

const sampleCallsValid = [
  agentSchema.safeParse({
    description: 'Captain research team',
    name: 'captain',
    team: 'research-1',
    captain: true,
    crewmate_type: 'mercury-crew',
    run_in_background: true,
    prompt: 'Coordinate research-1.',
  }).success,
  agentSchema.safeParse({
    description: 'Research angle 1',
    name: 'angle-1',
    team: 'research-1',
    crewmate_type: 'mercury-crew',
    run_in_background: true,
    prompt: 'Search angle 1 and report to @captain.',
  }).success,
  agentSchema.safeParse({
    description: 'Finder logic lens',
    crewmate_type: 'mercury-crew',
    effort: 'xhigh',
    isolation: 'worktree',
    worktree_at: 'HEAD',
    review_receipt: join(TMP, 'finder-logic.md'),
    prompt: 'Review logic lens.',
  }).success,
  boardTool.inputSchema.safeParse({ op: 'read', team: 'research-1' }).success,
  boardTool.inputSchema.safeParse({
    op: 'post',
    kind: 'result',
    to: ['captain'],
    clientOpId: 'research-1-angle-1-result',
    text: '@captain Findings ready.',
  }).success,
  boardTool.inputSchema.safeParse({
    op: 'post',
    kind: 'ask',
    to: ['verifier-1'],
    clientOpId: 'research-1-assign-verifier-1',
    text: '@verifier-1 Verify batch 1.',
  }).success,
]
check('prescribed Crewmate and CrewBoard call shapes validate against the product Zod schemas', sampleCallsValid.every(Boolean), sampleCallsValid)

const joinedCodeSpans = (text: string): string => text.replace(/`([a-z_]+)`:\s*`([^`\n]+)`/g, '`$1: $2`')
type DescribedArgument = { tool: string; key: string; value: unknown }
function describedArguments(text: string): DescribedArgument[] {
  const result: DescribedArgument[] = []
  let tool = ''
  for (const line of joinedCodeSpans(text).split('\n')) {
    if (/^#{1,6} /.test(line)) tool = ''
    if (/\bLaunch\b/.test(line)) tool = AgentTool.name
    for (const span of codeSpansOf(line)) {
      if (registeredToolNames.has(span)) tool = span
      const pair = /^([a-z_]+):\s*(.+)$/.exec(span)
      if (!pair || !tool || pair[1] === 'captain' && line.includes('never set')) continue
      try { result.push({ tool, key: pair[1]!, value: JSON.parse(pair[2]!) }) } catch {}
    }
  }
  return result
}
function argumentErrors(text: string): string[] {
  const errors: string[] = []
  for (const { tool, key, value } of describedArguments(text)) {
    const schema = toolByName.get(tool)?.inputSchema as z.ZodObject | undefined
    const property = schema?.shape?.[key] as z.ZodType | undefined
    if (!property) { errors.push(`${tool}.${key}: absent parameter`); continue }
    if (key === 'crewmate_type' && typeof value === 'string' && !builtInAgentTypes.has(value)) errors.push(`${tool}.${key}: unknown type ${value}`)
    if (typeof value === 'string' && /<[^>]+>/.test(value)) continue
    if (!property.safeParse(value).success) errors.push(`${tool}.${key}: refused ${JSON.stringify(value)}`)
  }
  return errors
}
const described = describedArguments(bothTexts)
const describedErrors = argumentErrors(bothTexts)
check('skill-derived arguments validate against their own tool schemas, including split key/value code spans', described.length > 80 && describedErrors.length === 0, { count: described.length, errors: describedErrors })
for (const [label, before, after] of [
  ['nonexistent Crewmate argument', '`run_in_background`: `true`', '`timeout`: `true`'],
  ['nonexistent crewmate_type', '`crewmate_type`: `"mercury-crew"`', '`crewmate_type`: `"mercury-imaginary"`'],
  ['nonexistent CrewBoard kind', '`kind: "ask"`', '`kind: "invented"`'],
  ['Git op used on CrewBoard', '`op: "read"`', '`op: "diff"`'],
] as const) {
  const mutant = deepSource.replace(before, after)
  check(`the instruction validator rejects a scratch ${label} mutation`, mutant !== deepSource && argumentErrors(mutant).length > 0, argumentErrors(mutant))
}
function launchArguments(text: string): Record<string, unknown> {
  return Object.fromEntries(describedArguments(`\`Crewmate\`\n${text}`).filter(arg => arg.tool === 'Crewmate').map(arg => [arg.key, arg.value]))
}
const captainArguments = launchArguments(deepSource.split('**First message')[1]?.split('**Second message')[0] ?? '')
const researcherArguments = launchArguments(deepSource.split('\n').find(line => line.includes('One `Crewmate` call per angle:')) ?? '')
const verifierArguments = launchArguments(deepSource.split('\n').find(line => line.includes('One `Crewmate` call per verifier:')) ?? '')
const captainBrief = deepSource.split('### Captain brief')[1]?.split('```text\n')[1]?.split('```')[0] ?? ''
const researcherBrief = deepSource.split('### Angle researcher brief')[1]?.split('```text\n')[1]?.split('```')[0] ?? ''
const verifierBrief = deepSource.split('### Adversarial verifier brief')[1]?.split('```text\n')[1]?.split('```')[0] ?? ''
check('the live launch inputs and complete briefs are extracted from the skill rather than a parallel example', [captainArguments, researcherArguments, verifierArguments].every(args => args.crewmate_type && args.run_in_background === true) && [captainBrief, researcherBrief, verifierBrief].every(brief => brief.includes('@captain')), { captainArguments, researcherArguments, verifierArguments })

section('3. Design invariants: captain-run vs lead-run, swarm-off, unattended, last look, and zero comms bounds')

check('deep-research names and appoints a captain', deepSource.includes('`captain`: `true`') && deepSource.includes('@captain'))
check('code-review never names a captain anywhere', !/\bcaptain\b/i.test(reviewSource))
check('code-review states in its opening paragraph what it reviews when no target is given', reviewSource.slice(0, 420).includes('uncommitted local changes') && reviewSource.slice(0, 420).includes('current branch against its base'))
check('deep-research detects swarm via CrewBoard presence and not by requiring ToolSearch to exist', deepSource.includes('whether `CrewBoard` is among the tools this session offers') && deepSource.includes('When `CrewBoard` is neither loaded nor listed under deferred tools, the swarm is off'))
check('deep-research forbids AskUserQuestion on unattended runs and bounds the last look to one round ending with What was not verified', deepSource.includes('When no operator is present') && deepSource.includes('never call `AskUserQuestion`') && deepSource.includes('Never run a second revision round') && deepSource.includes('`## What was not verified`'))

const commsBoundPattern = /\b(?:max|maximum|at most|under|fewer than|limit(?:ed)? to)\s+\d+\s+(?:posts?|reads?|messages?|board|tokens?|characters?|chars?|words?|lines?)\b|\bpost\s+(?:less|fewer|shorter|sparingly)\b|\bread\s+(?:less|fewer|sparingly)\b|\bkeep\s+(?:board\s+)?posts?\s+(?:short|brief|concise|under)\b/i
check('neither skill bounds CrewBoard reads or posts by tokens, characters, or count', !commsBoundPattern.test(deepSource) && !commsBoundPattern.test(reviewSource))
check('neither skill contains retired workflow calls or /workflows references', !/\bWorkflow\s*\(|\/workflows\b/i.test(bothTexts))

section('4. Live fixture launch road: 4-seat team and 7-seat team following the one-rule captain-first launch')

updateSettingsForSource('userSettings', { swarm: { enabled: true } })

async function runTeamLaunchProof(sessionUuid: string, teamLabel: string, researcherNames: string[], verifierNames: string[]): Promise<void> {
  const beforeReqCount = fixture.messageRequests().length
  bootstrap.switchSession(sessionUuid as never, PROJ)
  const swarmOut = runSwarmCommand('on')
  check(`${teamLabel}: /swarm on opens the live board`, swarmOut.startsWith('Swarm on'), swarmOut)
  const board = seam.swarmStore()!

  let state = getDefaultAppState() as AppState
  const expectedCount = 1 + researcherNames.length + verifierNames.length
  const launchedIds: string[] = []
  let resolveSettled: (() => void) | null = null
  const checkAllCompleted = (): void => {
    if (launchedIds.length < expectedCount) return
    const done = launchedIds.every(id => {
      const task = state.tasks[id] as { status?: string } | undefined
      return task?.status === 'completed'
    })
    if (done && resolveSettled) {
      const fn = resolveSettled
      resolveSettled = null
      fn()
    }
  }
  const allCompleted = new Promise<void>(resolve => {
    resolveSettled = resolve
  })
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state)
    checkAllCompleted()
  }

  const builtIns = getBuiltInAgents()
  let callSerial = 0
  const callCrewmate = async (input: Record<string, unknown>) => {
    const n = ++callSerial
    const context = {
      abortController: new AbortController(),
      getAppState: () => state,
      setAppState,
      setAppStateForTasks: setAppState,
      options: {
        commands: allCommands,
        tools: getAllBaseTools('main'),
        engineModel: 'claude-opus-4-8',
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        debug: false,
        verbose: false,
        agentDefinitions: { activeAgents: builtIns, allAgents: builtIns },
      },
      messages: [],
      readFileState: createFileStateCacheWithSizeLimit(100),
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      toolUseId: `toolu_${teamLabel}_${n}`,
    }
    const res = await AgentTool.call(
      input as never,
      context as never,
      (async () => ({ behavior: 'allow', updatedInput: input })) as never,
      { requestId: `req-${teamLabel}-${n}`, message: { id: `msg_${teamLabel}_${n}` } } as never,
    )
    return res.data as { status: string; agentId: string; agentName?: string }
  }

  const fill = (text: string, seat: string): string => text.replace(/<([^>]+)>/g, (_match, blank: string) => ({ team: teamLabel, scratchpad: TMP, seat_name: seat, question: 'Compare durability, concurrency and portability.', 'other-family-model-id': 'claude-opus-4-8' } as Record<string, string>)[blank] ?? `Assigned ${blank}`)
  const launch = (args: Record<string, unknown>, seat: string, brief: string) => ({
    ...Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'string' ? fill(value, seat) : value])),
    name: seat,
    team: teamLabel,
    prompt: `You are ${seat} on team ${teamLabel}. Your team captain is captain (@captain).\n${fill(brief, seat)}`,
  })
  const capLaunch = await callCrewmate(launch(captainArguments, 'captain', captainBrief))
  launchedIds.push(capLaunch.agentId)
  check(`${teamLabel}: message 1 launches captain alone in background`, capLaunch.status === 'async_launched' && capLaunch.agentName === 'captain', capLaunch)

  if (!board.captain(teamLabel)) {
    await new Promise<void>(resolve => {
      const stop = board.subscribe(() => {
        if (board.captain(teamLabel)) { stop(); resolve() }
      })
      if (board.captain(teamLabel)) { stop(); resolve() }
    })
  }
  const otherCalls = [
    ...researcherNames.map(seatName => callCrewmate(launch(researcherArguments, seatName, researcherBrief))),
    ...verifierNames.map(seatName => callCrewmate(launch(verifierArguments, seatName, verifierBrief))),
  ]

  const otherResults = await Promise.all(otherCalls)
  for (const r of otherResults) launchedIds.push(r.agentId)
  checkAllCompleted()
  check(
    `${teamLabel}: message 2 launches all ${otherResults.length} remaining seats concurrently without fifth-seat refusal`,
    otherResults.length === expectedCount - 1 && otherResults.every(r => r.status === 'async_launched'),
    otherResults,
  )

  await allCompleted

  const teamSeats = board.seats().filter(s => s.team === teamLabel)
  const capSeat = board.captain(teamLabel)
  check(
    `${teamLabel}: all ${expectedCount} seats enrolled and parked on the board with captain holding standing team wait`,
    teamSeats.length === expectedCount && capSeat?.name === 'captain' && capSeat.captain === true && capSeat.wait?.standing === true,
    { count: teamSeats.length, capSeat },
  )

  const newReqs = fixture.messageRequests().slice(beforeReqCount) as Array<{ body: { system?: unknown; messages?: unknown[]; tools?: Array<{ name?: string }> } }>
  check(`${teamLabel}: fixture received one model request per seat (${expectedCount})`, newReqs.length === expectedCount, newReqs.length)

  const sysTextOf = (req: (typeof newReqs)[number]): string => JSON.stringify(req.body.system ?? '')
  const msgTextOf = (req: (typeof newReqs)[number]): string => JSON.stringify(req.body.messages ?? '')
  const hasBoardTool = (req: (typeof newReqs)[number]): boolean => (req.body.tools ?? []).some(t => t.name === 'CrewBoard')

  const capReq = newReqs.find(r => msgTextOf(r).includes(`You are captain on team ${teamLabel}.`))
  check(
    `${teamLabel}: captain request carries captain standing-wait brief and CrewBoard tool`,
    capReq !== undefined &&
      sysTextOf(capReq).includes(`You are captain of ${teamLabel}, with a standing wait on its traffic. Fold your team's work and send one result to @main.`) &&
      hasBoardTool(capReq),
  )

  for (const peerName of [...researcherNames, ...verifierNames]) {
    const peerReq = newReqs.find(r => msgTextOf(r).includes(`You are ${peerName} on team ${teamLabel}.`))
    check(
      `${teamLabel}: ${peerName} was told captain is its team captain in both system brief and user prompt, with CrewBoard loaded`,
      peerReq !== undefined &&
        sysTextOf(peerReq).includes("captain is your team's captain. Take your team's asks, blockers and results to @captain; the captain reports the team's result to @main.") &&
        msgTextOf(peerReq).includes('Your team captain is captain (@captain).') &&
        hasBoardTool(peerReq),
    )
  }
}

await runTeamLaunchProof('00000000-0000-4000-8000-000000000004', 'team-four', ['angle-1', 'angle-2'], ['verifier-1'])
await runTeamLaunchProof('00000000-0000-4000-8000-000000000007', 'team-seven', ['angle-1', 'angle-2', 'angle-3', 'angle-4'], ['verifier-1', 'verifier-2'])

await fixture.close()
clearTimeout(guard)

console.log(`\n${failures === 0 ? `CREW SKILLS GREEN (${checks} checks)` : `CREW SKILLS RED (${failures} of ${checks})`}`)
process.exit(failures === 0 ? 0 : 1)
