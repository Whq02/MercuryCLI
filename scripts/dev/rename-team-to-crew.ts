#!/usr/bin/env bun
import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, posix, resolve } from 'node:path'

type Why = { why: string }
type Rule = { name: string } & Why
type Explicit = { from: string; to: string; re: RegExp } & Why
type AliasPatch = { file: string; find: string; replace: string; already: string; optional?: boolean } & Why
type Generator = { command: string[]; touches: string[] } & Why

const SELF = 'scripts/dev/rename-team-to-crew.ts'

const SCOPE_ROOTS = ['src/', 'scripts/', 'docs/', 'design-system/', 'assets/', 'integrations/']
const SCOPE_TOP_FILES = ['README.md', 'AGENTS.md', 'MERCURY.md', 'BUILD-NOTES.md', 'CONTRIBUTING.md', 'CLAUDE.md']

const EXCLUDED_PATHS: Array<{ prefix: string } & Why> = [
  { prefix: 'src/tools/WorkflowTool/', why: 'workflows do not change in any way: not their code' },
  { prefix: 'scripts/workflows/', why: 'workflows do not change in any way: not their proofs' },
  { prefix: 'docs/releases/', why: 'published release pages are history' },
  { prefix: 'src/constants/changelog.ts', why: 'past release notes stay as published' },
  { prefix: 'scripts/mission-runner/corpus/', why: 'fixture repositories of foreign source' },
  { prefix: 'scripts/interview/baselines/', why: 'frozen journey capture records keep their recorded bytes' },
  { prefix: 'scripts/visual-contract/baselines/', why: 'frozen capture records of earlier screens' },
  { prefix: 'scripts/agent-experience/baselines/', why: 'frozen mechanical baselines of earlier prompts' },
  { prefix: SELF, why: 'the script itself carries both spellings by design' },
]

const FROZEN_FILES: Array<{ path: string } & Why> = [
  { path: 'scripts/ui/prove-crew-screens-unchanged.ts', why: 'reads the stored frames of the earlier screens through a table of the old words and drives the old command name on the real screen' },
  { path: 'src/migrations/migrateConfigSpellings.ts', why: 'the table of retired global-config spellings names old keys by design' },
  { path: 'src/migrations/migrateSettingsSpellings.ts', why: 'the table of retired settings spellings names old keys by design' },
  { path: 'src/migrations/retiredCrewSpellings.ts', why: 'the read-side alias tables: every old spelling a saved file or an old caller may still carry' },
  { path: 'scripts/settings/prove-old-settings-keys-read.ts', why: 'the pin writes the old keys by design' },
  { path: 'scripts/substrate/prove-old-env-spellings-read.ts', why: 'the pin sets the old env spellings by design' },
  { path: 'scripts/sessionStorage/prove-old-transcript-kinds-parse.ts', why: 'the pin holds old transcript rows by design' },
  { path: 'scripts/identity/prove-no-old-spelling-remains.ts', why: 'the census names the spellings it hunts' },
  { path: 'scripts/switchboard/prove-crewmates-command.ts', why: 'the pin of the old command name still opening the crew view' },
  { path: 'scripts/crew/prove-saved-crews-convert.ts', why: 'the pin converts saved rosters an older build wrote, in their old shape' },
  { path: 'scripts/crew/prove-crew-tools-removed.ts', why: 'the pin holds an old transcript row of a removed tool' },
  { path: 'scripts/ui/prove-old-transcript-rows.ts', why: 'the pin holds old transcript rows by design' },
  { path: 'scripts/identity/prove-crew-words.ts', why: 'the census composes the old word it hunts' },
  { path: 'scripts/identity/prove-crew-docs-words.ts', why: 'the census composes the old word it hunts' },
  { path: 'scripts/engine-connector/prove-crew-vocabulary.ts', why: 'the census composes the old word it hunts' },
  { path: 'scripts/builtin-tools/prove-builtin-tools-census.ts', why: 'the census names the retired tools it hunts' },
]

const PINNED_PATHS: Array<{ path: string } & Why> = [
  { path: 'scripts/crew/team-world.ts', why: 'a workflow proof and the workflow suite runner name it by this path, and workflows do not change in any way — the one file name kept, listed for the owner' },
  { path: 'scripts/identity/prove-no-old-spelling-remains.ts', why: 'the census names the spelling it hunts' },
]

const REMOVED_PATHS: Array<{ path: string } & Why> = [
  { path: 'src/commands/team/index.ts', why: 'the /team door only opened the runs board, which /runs opens' },
  { path: 'src/services/resources/adapters/team.ts', why: 'the mercury://team kind listed saved rosters; mercury://crew is the living crew and the saved rosters are its records' },
]

const PROTECTED_PATTERNS: Array<{ re: RegExp } & Why> = [
  { re: /formerly: '[^']*'/g, why: 'a flag row names the spelling an older build wrote' },
  { re: /['"]Team(?:Create|Delete)['"]/g, why: 'the quoted name of a removed tool: the old row a pin drives or refuses' },
  { re: /[Cc]laude[ _][Tt]eam|claude_team/g, why: 'the plan of that name is the provider\'s, not the crew' },
  { re: /\b[Rr]ed[- ]team(?:ed|ing|s)?\b/g, why: 'the adversarial verb, not the crew' },
  { re: /TeamMem\b|TEAMMEM\b|teamMemory[A-Za-z]*/g, why: 'team memory is the memory of the people who share a repository, not the crew' },
  { re: /\bteamwork\b/gi, why: 'a plain English word' },
]

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.json', '.jsonl', '.md', '.txt', '.tsv', '.csv', '.sh', '.bash', '.py', '.yml', '.yaml', '.toml', '.sed', '.html', '.css', '.svg', '.xml', '.plist', '.ps1', '.cfg', '.ini'])
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'])

type FileRule = { path: string; protect?: string[]; map?: Record<string, string>; allow?: string[] } & Why
const FILE_RULES: FileRule[] = [
  { path: 'src/services/oauth/types.ts', protect: ['team', 'claude_team'], why: 'the subscription tier the provider names on the wire' },
  { path: 'src/services/oauth/client.ts', protect: ['team', 'claude_team'], why: 'the subscription tier the provider names on the wire' },
  { path: 'src/utils/auth.ts', protect: ['team'], why: 'the Claude Team plan tier keyed by its wire value' },
  { path: 'src/hooks/notifs/useRateLimitWarningNotification.tsx', protect: ['team'], why: 'the plan tier' },
  { path: 'src/services/mcp/channelNotification.ts', protect: ['team'], why: 'the plan tier' },
  { path: 'src/utils/planModeV2.ts', protect: ['team'], why: 'the plan tier' },
  { path: 'src/services/providers/providerUsage.ts', protect: ['team'], why: 'the plan tier' },
  { path: 'src/components/PromptInput/Notifications.tsx', protect: ['team'], why: 'the plan tier' },
  { path: 'src/utils/memoryFileDetection.ts', protect: ['team'], why: 'the memory scope shared with the people of a repository' },
  { path: 'src/components/TrustDialog/TrustDialog.tsx', protect: ['team'], why: 'the trust question speaks of the people whose code it is' },
  { path: 'src/tools/AgentTool/agentMemory.ts', protect: ['team'], why: 'the memory file header speaks of the people who share the repository' },
  { path: 'src/utils/cockpit/fleetGauge.ts', map: { team: 'saved', teamRows: 'savedRows' }, why: 'the saved-roster source beside the living crew the gauge already lists' },
  { path: 'src/components/PromptInput/PromptInput.tsx', map: { viewedTeammate: 'viewedCrewmateTask' }, why: 'the viewed in-process task beside the viewed crewmate of the crew view' },
  { path: 'scripts/crew/prove-resume-by-name.ts', map: { team: 'crewCtx' }, why: 'the crew context beside the crew the proof already names' },
  { path: 'src/components/tasks/BackgroundTasksDialog.tsx', map: { team: 'group' }, why: 'the grouping key beside the crew the board already names' },
  { path: 'src/utils/crewmateMailbox.ts', map: { team: 'targetCrew' }, why: 'the addressed crew beside the crew the mailbox already names' },
  { path: 'src/utils/crew/crewBirth.ts', allow: ['teamName'], why: 'crewName is a parameter of another function in the file, not this scope' },
  ...['src/utils/attachments/types.ts', 'src/fabric/validate.ts', 'scripts/transcript-rows/prove-crew-messages-kind.ts', 'scripts/tools/prove-runaway-output-seams.ts', 'scripts/idiom/prove-body-shape-registry.ts', 'scripts/crew/prove-crew-messages-row.ts', 'scripts/attachments/goldens.json'].map(path => ({ path, protect: ['teammate_mailbox'], why: 'the old kind of the message row: the attachment types read it through their own table, the validator keeps its shape row, the pins drive it' })),
]

const explicit = (from: string, to: string, re: string, why: string): Explicit => ({ from, to, re: new RegExp(re, 'g'), why })
const EXPLICIT: Explicit[] = [
  explicit('TEAMS.md', 'CREW.md', '(?<![A-Za-z0-9])TEAMS\\.md(?![A-Za-z0-9])', 'the crew page name the brief names'),
  explicit('TeamBrief', 'LiveComms', '(?<![A-Za-z0-9_])TeamBrief(?![A-Za-z0-9_])', 'the brief became live communication under its own name; the alias tables and the pins that drive the old name are frozen'),
]

const COLLAPSE: Array<[string, string]> = [
  ['CrewCrewmate', 'Crewmate'],
  ['crewCrewmate', 'crewmate'],
  ['CREW_CREWMATE', 'CREWMATE'],
  ['CrewCrew', 'Crew'],
  ['crewCrew', 'crew'],
  ['CREW_CREW', 'CREW'],
]

const ALIAS_PATCHES: AliasPatch[] = [
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'a flag spec may name the spelling an older build wrote',
    find: '  /** The env spelling. */\n  env: string\n',
    replace: '  /** The env spelling. */\n  env: string\n  formerly?: string\n',
    already: '  formerly?: string\n',
  },
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'the one bounded reader honours the former spelling when the registered one is absent',
    find: '  if (!spec) throw new Error(`flagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  return process.env[spec.env]\n',
    replace: '  if (!spec) throw new Error(`flagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  return process.env[spec.env] ?? (spec.formerly === undefined ? undefined : process.env[spec.formerly])\n',
    already: '  return process.env[spec.env] ?? (spec.formerly === undefined ? undefined : process.env[spec.formerly])\n',
  },
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'stampers and scrubbers carry both spellings so a child of an older build still reads the flag',
    find: '  if (!spec) throw new Error(`flagSpellings: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  return [spec.env]\n',
    replace: '  if (!spec) throw new Error(`flagSpellings: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  return spec.formerly === undefined ? [spec.env] : [spec.env, spec.formerly]\n',
    already: '  return spec.formerly === undefined ? [spec.env] : [spec.env, spec.formerly]\n',
  },
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'the paired delete removes both spellings',
    find: '  if (!spec) throw new Error(`deleteFlagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  delete process.env[spec.env]\n',
    replace: '  if (!spec) throw new Error(`deleteFlagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  for (const spelling of flagSpellings(env)) delete process.env[spelling]\n',
    already: '  for (const spelling of flagSpellings(env)) delete process.env[spelling]\n',
  },
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'the saved-crews home flag honours the spelling saved shells and older builds set',
    find: "  { env: 'MERCURY_CREWS_DIR', kind: 'value',",
    replace: "  { env: 'MERCURY_CREWS_DIR', formerly: 'MERCURY_TEAMS_DIR', kind: 'value',",
    already: "  { env: 'MERCURY_CREWS_DIR', formerly: 'MERCURY_TEAMS_DIR',",
  },
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'the crewmate surfaces flag honours the spelling saved shells and older builds set',
    find: "  { env: 'MERCURY_CREWMATES', kind: 'value',",
    replace: "  { env: 'MERCURY_CREWMATES', formerly: 'MERCURY_TEAMMATES', kind: 'value',",
    already: "  { env: 'MERCURY_CREWMATES', formerly: 'MERCURY_TEAMMATES',",
  },
  {
    file: 'src/migrations/migrateConfigSpellings.ts',
    why: 'a saved global config written under the old keys is read as the current keys',
    find: 'export const RETIRED_GLOBAL_CONFIG_KEYS: Readonly<Record<string, string>> = {\n',
    replace: "export const RETIRED_GLOBAL_CONFIG_KEYS: Readonly<Record<string, string>> = {\n  teammateMode: 'crewmateMode',\n  teammateDefaultModel: 'crewmateDefaultModel',\n",
    already: "  teammateMode: 'crewmateMode',\n",
  },
  {
    file: 'src/migrations/migrateSettingsSpellings.ts',
    why: 'a settings file with hooks under the old event key is read as the current key',
    find: 'export const RETIRED_SETTINGS_KEYS: readonly KeyRename[] = [\n',
    replace: "export const RETIRED_SETTINGS_KEYS: readonly KeyRename[] = [\n  { from: ['hooks', 'TeammateIdle'], to: ['hooks', 'CrewmateIdle'], value: 'same' },\n",
    already: "  { from: ['hooks', 'TeammateIdle'], to: ['hooks', 'CrewmateIdle'], value: 'same' },\n",
  },
  {
    file: 'src/fabric/transcriptDecode.ts',
    why: 'every transcript row read anywhere passes the retired-spellings table once, at the one decode point',
    find: "import { bodyShapeIssue, validateRecord } from './validate.js'\n",
    replace: "import { bodyShapeIssue, validateRecord } from './validate.js'\nimport { readRetiredTranscriptRow } from '../migrations/retiredCrewSpellings.js'\n",
    already: "import { readRetiredTranscriptRow } from '../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/fabric/transcriptDecode.ts',
    why: 'the decoded entries carry the current spellings',
    find: '  const { valid, invalid } = classifyInvalid(values)\n  return { entries: valid as T[], malformed, invalid, totalLines }\n',
    replace: '  const { valid, invalid } = classifyInvalid(values)\n  return { entries: valid.map(row => readRetiredTranscriptRow(row)) as T[], malformed, invalid, totalLines }\n',
    already: '  return { entries: valid.map(row => readRetiredTranscriptRow(row)) as T[], malformed, invalid, totalLines }\n',
  },
  {
    file: 'src/utils/sessionStorage/logs.ts',
    why: 'the lite session listing scans the head line by key and reads the retired key too',
    find: "import { appendEntryToFile, getProject, getSessionMessages } from './writer.js'\n",
    replace: "import { appendEntryToFile, getProject, getSessionMessages } from './writer.js'\nimport { RETIRED_TRANSCRIPT_ROW_KEYS } from '../../migrations/retiredCrewSpellings.js'\n",
    already: "import { RETIRED_TRANSCRIPT_ROW_KEYS } from '../../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/utils/sessionStorage/logs.ts',
    why: 'the lite session listing reads the retired crew-name key',
    find: "  const crewName = extractJsonStringField(head, 'crewName')\n",
    replace: "  const crewName = extractJsonStringField(head, 'crewName') ?? extractJsonStringField(head, Object.keys(RETIRED_TRANSCRIPT_ROW_KEYS).find(k => RETIRED_TRANSCRIPT_ROW_KEYS[k] === 'crewName')!)\n",
    already: "extractJsonStringField(head, Object.keys(RETIRED_TRANSCRIPT_ROW_KEYS).find(k => RETIRED_TRANSCRIPT_ROW_KEYS[k] === 'crewName')!)\n",
  },
  {
    file: 'src/utils/sessionStorage/paths.ts',
    why: 'an agent sidecar written under the old keys still resumes as a crewmate',
    find: "import { RETIRED_AGENT_TYPES } from '../../tools/AgentTool/constants.js'\n",
    replace: "import { RETIRED_AGENT_TYPES } from '../../tools/AgentTool/constants.js'\nimport { readRetiredAgentSidecar } from '../../migrations/retiredCrewSpellings.js'\n",
    already: "import { readRetiredAgentSidecar } from '../../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/utils/sessionStorage/paths.ts',
    why: 'the sidecar reader maps the old keys through the one table',
    find: "    const parsed = JSON.parse(raw) as AgentMetadata & { crewmate?: AgentMetadata['crewmate'] }\n    const meta: AgentMetadata = parsed.crewmate === undefined && parsed.crewmate !== undefined ? { ...parsed, crewmate: parsed.crewmate } : parsed\n",
    replace: '    const meta = readRetiredAgentSidecar(JSON.parse(raw) as AgentMetadata)\n',
    already: '    const meta = readRetiredAgentSidecar(JSON.parse(raw) as AgentMetadata)\n',
  },
  {
    file: 'src/tools/AgentTool/AgentTool.tsx',
    why: 'the Agent tool still accepts the old field name from an old transcript replay or an old caller',
    find: "import { formatEnvelopeBlock } from '../../services/agentResults/normalize.js'\n",
    replace: "import { formatEnvelopeBlock } from '../../services/agentResults/normalize.js'\nimport { readRetiredAgentToolInput } from '../../migrations/retiredCrewSpellings.js'\n",
    already: "import { readRetiredAgentToolInput } from '../../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/tools/AgentTool/AgentTool.tsx',
    why: 'the tool reads its input through the table before validation; the exported schema keeps its shape and the schema the model sees is unchanged',
    find: "  get inputSchema(): ZodType<AgentToolInput, AgentToolInput> {\n    return inputSchema() as unknown as ZodType<AgentToolInput, AgentToolInput>\n  },\n",
    replace: "  get inputSchema(): ZodType<AgentToolInput, AgentToolInput> {\n    const schema = inputSchema()\n    return Object.assign(z.preprocess(readRetiredAgentToolInput, schema), { shape: schema.shape }) as unknown as ZodType<AgentToolInput, AgentToolInput>\n  },\n",
    already: '    return Object.assign(z.preprocess(readRetiredAgentToolInput, schema), { shape: schema.shape }) as unknown as ZodType<AgentToolInput, AgentToolInput>\n',
  },
  {
    file: 'src/utils/envUtils.ts',
    why: 'the saved-crews home an older build wrote is still read',
    find: "import { flagEnv } from '../substrate/flagRegistry.js'\n",
    replace: "import { flagEnv } from '../substrate/flagRegistry.js'\nimport { RETIRED_CREWS_DIR_NAME } from '../migrations/retiredCrewSpellings.js'\n",
    already: "import { RETIRED_CREWS_DIR_NAME } from '../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/utils/envUtils.ts',
    why: 'the reader of the folder an older build wrote',
    find: "  return join(getMercuryHome(), 'crews')\n}\n",
    replace: "  return join(getMercuryHome(), 'crews')\n}\n\nexport function getRetiredCrewsDir(): string | null {\n  const override = flagEnv('MERCURY_CREWS_DIR')\n  if (override !== undefined && override.trim() !== '') return null\n  return join(getMercuryHome(), RETIRED_CREWS_DIR_NAME)\n}\n",
    already: 'export function getRetiredCrewsDir(): string | null {\n',
  },
  {
    file: 'src/utils/swarm/crewHelpers.ts',
    why: 'a roster an older build wrote reads with the current member roles and lead name, from the current folder or the old one',
    find: "import type { BackendType } from './backends/types.js'\n",
    replace: "import type { BackendType } from './backends/types.js'\nimport { readRetiredCrewFile } from '../../migrations/retiredCrewSpellings.js'\nimport { getRetiredCrewsDir } from '../envUtils.js'\n",
    already: "import { readRetiredCrewFile } from '../../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/utils/swarm/crewHelpers.ts',
    why: 'a read falls back to the folder an older build wrote; a write never goes there',
    find: "export function getCrewFilePath(crewName: string): string {\n  return join(getCrewDir(crewName), 'config.json')\n}\n",
    replace: "export function getCrewFilePath(crewName: string): string {\n  return join(getCrewDir(crewName), 'config.json')\n}\n\nfunction readableCrewFilePath(crewName: string): string {\n  const current = getCrewFilePath(crewName)\n  if (existsSync(current)) return current\n  const retired = getRetiredCrewsDir()\n  if (retired === null) return current\n  const old = join(retired, sanitizeName(crewName), 'config.json')\n  return existsSync(old) ? old : current\n}\n",
    already: 'function readableCrewFilePath(crewName: string): string {\n',
  },
  {
    file: 'src/utils/swarm/crewHelpers.ts',
    why: 'the parsed roster passes the retired-spellings table',
    find: '  if (isCrewFile(parsed)) return parsed\n  nameRefusedRoster(path)\n  return null\n',
    replace: '  if (isCrewFile(parsed)) return readRetiredCrewFile(parsed, CREW_LEAD_NAME)\n  nameRefusedRoster(path)\n  return null\n',
    already: '  if (isCrewFile(parsed)) return readRetiredCrewFile(parsed, CREW_LEAD_NAME)\n',
  },
  {
    file: 'src/utils/swarm/crewHelpers.ts',
    why: 'the sync read falls back to the old folder',
    find: "export function readCrewFile(crewName: string): CrewFile | null {\n  const path = getCrewFilePath(crewName)\n",
    replace: "export function readCrewFile(crewName: string): CrewFile | null {\n  const path = readableCrewFilePath(crewName)\n",
    already: "export function readCrewFile(crewName: string): CrewFile | null {\n  const path = readableCrewFilePath(crewName)\n",
  },
  {
    file: 'src/utils/swarm/crewHelpers.ts',
    why: 'the async read falls back to the old folder',
    find: "export async function readCrewFileAsync(crewName: string): Promise<CrewFile | null> {\n  const path = getCrewFilePath(crewName)\n",
    replace: "export async function readCrewFileAsync(crewName: string): Promise<CrewFile | null> {\n  const path = readableCrewFilePath(crewName)\n",
    already: "export async function readCrewFileAsync(crewName: string): Promise<CrewFile | null> {\n  const path = readableCrewFilePath(crewName)\n",
  },
  {
    file: 'src/utils/crew/crewConvert.ts',
    why: 'the conversion of saved rosters keeps reading the folder an older build wrote',
    find: "import { getCrewsDir } from '../envUtils.js'\n",
    replace: "import { getCrewsDir, getRetiredCrewsDir } from '../envUtils.js'\n",
    already: "import { getCrewsDir, getRetiredCrewsDir } from '../envUtils.js'\n",
  },
  {
    file: 'src/utils/crew/crewConvert.ts',
    why: 'both folders are scanned, the old one first',
    find: "  const crewsDir = opts?.crewsDir ?? getCrewsDir()\n  const outcome: ConvertSavedCrewsOutcome = { crewsDir, converted: [], unchanged: [], skipped: [] }\n  let names: string[]\n  try {\n    names = (await readdir(crewsDir)).filter(name => !name.startsWith('.')).sort()\n  } catch {\n    return outcome\n  }\n  const read: Array<Omit<CrewRecordV1, 'convertedAt'>> = []\n  for (const name of names) {\n    let isDir = false\n    try {\n      isDir = (await stat(join(crewsDir, name))).isDirectory()\n    } catch {\n      isDir = false\n    }\n    if (!isDir) {\n      outcome.skipped.push(name)\n      continue\n    }\n    const record = await readSavedCrew(crewsDir, name)\n    if (record === null) {\n      outcome.skipped.push(name)\n      continue\n    }\n    read.push(record)\n  }\n",
    replace: "  const crewsDir = opts?.crewsDir ?? getCrewsDir()\n  const outcome: ConvertSavedCrewsOutcome = { crewsDir, converted: [], unchanged: [], skipped: [] }\n  const retired = opts?.crewsDir === undefined ? getRetiredCrewsDir() : null\n  const folders = retired === null ? [crewsDir] : [retired, crewsDir]\n  const read: Array<Omit<CrewRecordV1, 'convertedAt'>> = []\n  const seen = new Set<string>()\n  for (const folder of folders) {\n    let names: string[]\n    try {\n      names = (await readdir(folder)).filter(name => !name.startsWith('.')).sort()\n    } catch {\n      continue\n    }\n    for (const name of names) {\n      if (seen.has(name)) continue\n      let isDir = false\n      try {\n        isDir = (await stat(join(folder, name))).isDirectory()\n      } catch {\n        isDir = false\n      }\n      if (!isDir) {\n        outcome.skipped.push(name)\n        continue\n      }\n      const record = await readSavedCrew(folder, name)\n      if (record === null) {\n        outcome.skipped.push(name)\n        continue\n      }\n      seen.add(name)\n      read.push(record)\n    }\n  }\n",
    already: '  const folders = retired === null ? [crewsDir] : [retired, crewsDir]\n',
  },
  {
    file: 'src/keybindings/parser.ts',
    why: 'a saved keybinding carrying the old action id still binds',
    find: "import type { Chord, KeybindingBlock, ParsedBinding, ParsedKeystroke } from './types.js'\n",
    replace: "import type { Chord, KeybindingBlock, ParsedBinding, ParsedKeystroke } from './types.js'\nimport { readRetiredKeybindingAction } from '../migrations/retiredCrewSpellings.js'\n",
    already: "import { readRetiredKeybindingAction } from '../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/keybindings/parser.ts',
    why: 'the parsed action id is read through the table',
    find: '      out.push({ chord: parseChord(pattern), action: value, context: block.context })\n',
    replace: '      out.push({ chord: parseChord(pattern), action: typeof value === \'string\' ? readRetiredKeybindingAction(value) : value, context: block.context })\n',
    already: "action: typeof value === 'string' ? readRetiredKeybindingAction(value) : value, context: block.context })\n",
  },
  {
    file: 'src/utils/agentSwarmsEnabled.ts',
    why: 'the old opt-in flag spelling still counts',
    find: "import { flagEnv } from '../substrate/flagRegistry.js'\n\nexport function isAgentSwarmsEnabled(): boolean {\n  return flagEnv('MERCURY_CREWMATES') !== '0' || process.argv.includes('--agent-crews')\n}\n",
    replace: "import { flagEnv } from '../substrate/flagRegistry.js'\nimport { readRetiredCliFlags } from '../migrations/retiredCrewSpellings.js'\n\nexport function isAgentSwarmsEnabled(): boolean {\n  return flagEnv('MERCURY_CREWMATES') !== '0' || readRetiredCliFlags(process.argv).includes('--agent-crews')\n}\n",
    already: "readRetiredCliFlags(process.argv).includes('--agent-crews')\n",
  },
  {
    file: 'src/main.tsx',
    why: 'the command line an older build\'s spawner passes is read through the table before parsing',
    find: "import { refusalEnvelope } from './cli/headless/refusalEnvelope.js'\n",
    replace: "import { refusalEnvelope } from './cli/headless/refusalEnvelope.js'\nimport { readRetiredCliFlags } from './migrations/retiredCrewSpellings.js'\n",
    already: "import { readRetiredCliFlags } from './migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/main.tsx',
    why: 'the three parse calls read the current spellings',
    find: '        await program.parseAsync(process.argv)\n',
    replace: '        await program.parseAsync(readRetiredCliFlags(process.argv))\n',
    already: '        await program.parseAsync(readRetiredCliFlags(process.argv))\n',
  },
  {
    file: 'src/main.tsx',
    why: 'the second parse call',
    find: '      await program.parseAsync(process.argv)\n',
    replace: '      await program.parseAsync(readRetiredCliFlags(process.argv))\n',
    already: '      await program.parseAsync(readRetiredCliFlags(process.argv))\n',
  },
  {
    file: 'src/main.tsx',
    why: 'the third parse call',
    find: '\n  await program.parseAsync(process.argv)\n',
    replace: '\n  await program.parseAsync(readRetiredCliFlags(process.argv))\n',
    already: '\n  await program.parseAsync(readRetiredCliFlags(process.argv))\n',
  },
  {
    file: 'src/tools/SendMessageTool/SendMessageTool.ts',
    why: 'a message addressed to the lead by its old name (an older crewmate still running) reaches the lead',
    find: "import { renderToolResultMessage, renderToolUseMessage } from './UI.js'\n",
    replace: "import { renderToolResultMessage, renderToolUseMessage } from './UI.js'\nimport { isRetiredCrewLeadName } from '../../migrations/retiredCrewSpellings.js'\n",
    already: "import { isRetiredCrewLeadName } from '../../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/tools/SendMessageTool/SendMessageTool.ts',
    why: 'the self check',
    find: '  if (wanted === CREW_LEAD_NAME.toLowerCase()) return null\n',
    replace: '  if (wanted === CREW_LEAD_NAME.toLowerCase() || isRetiredCrewLeadName(wanted)) return null\n',
    already: '  if (wanted === CREW_LEAD_NAME.toLowerCase() || isRetiredCrewLeadName(wanted)) return null\n',
  },
  {
    file: 'src/tools/SendMessageTool/SendMessageTool.ts',
    why: 'the recipient resolution',
    find: '  if (rawTo.toLowerCase() === CREW_LEAD_NAME.toLowerCase()) {\n',
    replace: '  if (rawTo.toLowerCase() === CREW_LEAD_NAME.toLowerCase() || isRetiredCrewLeadName(rawTo)) {\n',
    already: '  if (rawTo.toLowerCase() === CREW_LEAD_NAME.toLowerCase() || isRetiredCrewLeadName(rawTo)) {\n',
  },
  {
    file: 'src/tools/SendMessageTool/SendMessageTool.ts',
    why: 'the addressability check',
    find: '  if (rawTo.toLowerCase() === CREW_LEAD_NAME.toLowerCase()) return true\n',
    replace: '  if (rawTo.toLowerCase() === CREW_LEAD_NAME.toLowerCase() || isRetiredCrewLeadName(rawTo)) return true\n',
    already: '  if (rawTo.toLowerCase() === CREW_LEAD_NAME.toLowerCase() || isRetiredCrewLeadName(rawTo)) return true\n',
  },
  {
    file: 'src/utils/swarm/sendMessageGovernance.ts',
    why: 'the governance reads the lead by its old name too',
    find: "import type { CrewFile } from './crewHelpers.js'\n",
    replace: "import type { CrewFile } from './crewHelpers.js'\nimport { isRetiredCrewLeadName } from '../../migrations/retiredCrewSpellings.js'\n",
    already: "import { isRetiredCrewLeadName } from '../../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/utils/swarm/sendMessageGovernance.ts',
    why: 'the lead check',
    find: '    name.toLowerCase() === CREW_LEAD_NAME.toLowerCase() ||\n',
    replace: '    name.toLowerCase() === CREW_LEAD_NAME.toLowerCase() ||\n    isRetiredCrewLeadName(name) ||\n',
    already: '    isRetiredCrewLeadName(name) ||\n',
  },
  {
    file: 'src/daemon/crewSpawn.ts',
    why: 'a crewmate never takes the lead\'s old name either',
    find: "import type { WorkerModelValidation } from '../services/concourse/workerModels.js'\n",
    replace: "import type { WorkerModelValidation } from '../services/concourse/workerModels.js'\nimport { RETIRED_CREW_LEAD_NAME } from '../migrations/retiredCrewSpellings.js'\n",
    already: "import { RETIRED_CREW_LEAD_NAME } from '../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/daemon/crewSpawn.ts',
    why: 'the reserved names',
    find: "const RESERVED_NAMES = new Set(['crew-lead', ",
    replace: "const RESERVED_NAMES = new Set(['crew-lead', RETIRED_CREW_LEAD_NAME, ",
    already: "const RESERVED_NAMES = new Set(['crew-lead', RETIRED_CREW_LEAD_NAME, ",
  },
  {
    file: 'src/state/AppStateStore.ts',
    why: 'a saved expanded-view value written under the old word still opens the crew tree',
    find: "import type { CrewLedger } from './crewLedger.js'\n",
    replace: "import type { CrewLedger } from './crewLedger.js'\nimport { readRetiredGlobalConfigValue } from '../migrations/retiredCrewSpellings.js'\n",
    already: "import { readRetiredGlobalConfigValue } from '../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/state/AppStateStore.ts',
    why: 'the remembered value passes the table',
    find: "    const remembered = getGlobalConfig().expandedView\n",
    replace: "    const remembered = readRetiredGlobalConfigValue('expandedView', getGlobalConfig().expandedView)\n",
    already: "    const remembered = readRetiredGlobalConfigValue('expandedView', getGlobalConfig().expandedView)\n",
  },
  {
    file: 'src/components/mercury-ui/toolGlyphs.ts',
    why: 'an old transcript row of a removed or renamed tool keeps its glyph family through the table',
    find: "import type { MercuryThemeTokens } from '../../utils/mercuryTokens.js'\n",
    replace: "import type { MercuryThemeTokens } from '../../utils/mercuryTokens.js'\nimport { isRetiredToolName } from '../../migrations/retiredCrewSpellings.js'\n",
    already: "import { isRetiredToolName } from '../../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/components/mercury-ui/toolGlyphs.ts',
    why: 'the three rows of the old names go; the lookup answers them',
    find: "  LiveComms: 'agent',\n  LiveComms: 'agent',\n  CrewCreate: 'agent',\n  CrewDelete: 'agent',\n",
    replace: "  LiveComms: 'agent',\n",
    already: '  if (isRetiredToolName(toolName)) return \'agent\'\n',
  },
  {
    file: 'src/components/mercury-ui/toolGlyphs.ts',
    why: 'the lookup',
    find: '  const known = TOOL_FAMILY_BY_NAME[toolName]\n  if (known) return known\n',
    replace: "  const known = TOOL_FAMILY_BY_NAME[toolName]\n  if (known) return known\n  if (isRetiredToolName(toolName)) return 'agent'\n",
    already: "  if (isRetiredToolName(toolName)) return 'agent'\n",
  },
  {
    file: 'src/tools/LiveCommsTool/constants.ts',
    why: 'the old tool name an old transcript row and an old call still resolve is the table\'s',
    find: "export const LIVE_COMMS_TOOL_NAME = 'LiveComms'\nexport const LIVE_COMMS_OLD_TOOL_NAME = 'LiveComms'\n",
    replace: "import { RETIRED_LIVE_COMMS_TOOL_NAME } from '../../migrations/retiredCrewSpellings.js'\n\nexport const LIVE_COMMS_TOOL_NAME = 'LiveComms'\nexport const LIVE_COMMS_OLD_TOOL_NAME = RETIRED_LIVE_COMMS_TOOL_NAME\n",
    already: 'export const LIVE_COMMS_OLD_TOOL_NAME = RETIRED_LIVE_COMMS_TOOL_NAME\n',
  },
  {
    file: 'src/utils/transcriptSearch.ts',
    why: 'the search facets keep skipping the old tool names an old transcript carries',
    find: "import { isTurnCutText } from './messages.js'\n",
    replace: "import { isTurnCutText } from './messages.js'\nimport { RETIRED_TOOL_NAMES } from '../migrations/retiredCrewSpellings.js'\n",
    already: "import { RETIRED_TOOL_NAMES } from '../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/utils/transcriptSearch.ts',
    why: 'the two rows of the old names come from the table',
    find: "  'LiveComms',\n  'LiveComms',\n  'TeamDelete',\n",
    replace: "  'LiveComms',\n  ...Object.keys(RETIRED_TOOL_NAMES),\n",
    already: '  ...Object.keys(RETIRED_TOOL_NAMES),\n',
  },
  {
    file: 'src/commands/crewmates/index.ts',
    why: 'the old command name still opens the crew view, as an alias the table names',
    find: "import type { Command } from '../../commands.js'\n",
    replace: "import type { Command } from '../../commands.js'\nimport { RETIRED_CREWMATES_COMMAND_NAME } from '../../migrations/retiredCrewSpellings.js'\n",
    already: "import { RETIRED_CREWMATES_COMMAND_NAME } from '../../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/commands/crewmates/index.ts',
    why: 'the alias row',
    find: "  aliases: ['crewmates'],\n",
    replace: '  aliases: [RETIRED_CREWMATES_COMMAND_NAME],\n',
    already: '  aliases: [RETIRED_CREWMATES_COMMAND_NAME],\n',
  },
  {
    file: 'src/substrate/operationJournal.ts',
    why: 'a journal row an older build wrote finds its handler under the current kind',
    find: "import { durableAtomicPublish, faultPoint } from './durablePublish.js'\n",
    replace: "import { durableAtomicPublish, faultPoint } from './durablePublish.js'\nimport { readRetiredJournalKind } from '../migrations/retiredCrewSpellings.js'\n",
    already: "import { readRetiredJournalKind } from '../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/substrate/operationJournal.ts',
    why: 'the handler lookup',
    find: '    const handler = handlers[op.kind]\n',
    replace: '    const handler = handlers[readRetiredJournalKind(op.kind)]\n',
    already: '    const handler = handlers[readRetiredJournalKind(op.kind)]\n',
  },
  {
    file: 'src/utils/swarm/crewOperations.ts',
    why: 'the crew name inside an old journal key still parses',
    find: "import { getCrewDir, getCrewFilePath, readCrewFileAsync } from './crewHelpers.js'\n",
    replace: "import { getCrewDir, getCrewFilePath, readCrewFileAsync } from './crewHelpers.js'\nimport { readRetiredJournalKey } from '../../migrations/retiredCrewSpellings.js'\n",
    already: "import { readRetiredJournalKey } from '../../migrations/retiredCrewSpellings.js'\n",
  },
  {
    file: 'src/utils/swarm/crewOperations.ts',
    why: 'the key parse',
    find: "  return idempotencyKey.replace(new RegExp(`^${kind}:`), '').replace(/:\\d+$/, '')\n",
    replace: "  return readRetiredJournalKey(idempotencyKey).replace(new RegExp(`^${kind}:`), '').replace(/:\\d+$/, '')\n",
    already: "  return readRetiredJournalKey(idempotencyKey).replace(new RegExp(`^${kind}:`), '').replace(/:\\d+$/, '')\n",
  },
  {
    file: 'scripts/engine-connector/prove-crew-vocabulary.ts',
    why: 'the /team door is gone',
    find: "  'src/commands/team/index.ts',\n",
    replace: '',
    already: '\u0000',
    optional: true,
  },
  {
    file: 'scripts/engine-connector/prove-crew-vocabulary.ts',
    why: "the seat's prompt and its roster role say crewmate now; the census keeps no exception for them",
    find: "  ['src/daemon/crewSpawn.ts', 'You are @${name}, a Mercury crew teammate', \"the named agent's own system prompt — model-facing bytes, not operator copy\"],\n  ['src/daemon/crewSpawn.ts', 'Other teammates may be working', 'the same prompt'],\n  ['src/daemon/crewSpawn.ts', \"role: 'teammate'\", \"the team-file member record's role value — a wire spelling\"],\n",
    replace: '',
    already: "  ['src/utils/healthReport.ts', 'terminal-overrides', \"the same row's remedy for that real terminal\"],\n]",
  },
  {
    file: 'scripts/crew/prove-crew-tools-removed.ts',
    why: 'the old journal kinds are read through the alias table now, not carried as handler keys',
    find: "operations.includes(\"'team-create'\") && operations.includes(\"'team-delete'\") && ",
    replace: "src('src/substrate/operationJournal.ts').includes('readRetiredJournalKind(op.kind)') && operations.includes(\"'crew-create'\") && operations.includes(\"'crew-delete'\") && ",
    already: "src('src/substrate/operationJournal.ts').includes('readRetiredJournalKind(op.kind)')",
  },
  {
    file: 'scripts/crew/prove-crew-tools-removed.ts',
    why: 'the marks of the old rows come from the alias table now',
    find: "glyphs.includes('TeamCreate:') && glyphs.includes('TeamDelete:')",
    replace: "glyphs.includes('isRetiredToolName(toolName)') && src('src/migrations/retiredCrewSpellings.ts').includes('TeamCreate') && src('src/migrations/retiredCrewSpellings.ts').includes('TeamDelete')",
    already: "glyphs.includes('isRetiredToolName(toolName)')",
  },
  {
    file: 'scripts/crew/run-all.sh',
    why: 'the gate watches the two files the tools-removed pin now reads',
    find: '# gate-watch: src/ink.ts\n',
    replace: '# gate-watch: src/ink.ts\n# gate-watch: src/migrations/retiredCrewSpellings.ts src/substrate/operationJournal.ts\n',
    already: '# gate-watch: src/migrations/retiredCrewSpellings.ts src/substrate/operationJournal.ts\n',
  },
  {
    file: 'scripts/swarm/prove-livecomms-store.ts',
    why: 'the old name the tool still answers to is the table\'s',
    find: "check('the old name LiveComms is its alias (an old transcript row and an old call still land)', (tool.aliases ?? []).includes('LiveComms'), JSON.stringify(tool.aliases ?? []))\n",
    replace: "const { RETIRED_LIVE_COMMS_TOOL_NAME } = await import('../../src/migrations/retiredCrewSpellings.js')\n  check('the old name is its alias (an old transcript row and an old call still land)', (tool.aliases ?? []).includes(RETIRED_LIVE_COMMS_TOOL_NAME), JSON.stringify(tool.aliases ?? []))\n",
    already: "(tool.aliases ?? []).includes(RETIRED_LIVE_COMMS_TOOL_NAME)",
  },
  {
    file: 'scripts/swarm/run-all.sh',
    why: 'the gate watches the table the store pin now reads',
    find: '# gate-watch: src/tools/SendMessageTool/SendMessageTool.ts\n',
    replace: '# gate-watch: src/tools/SendMessageTool/SendMessageTool.ts\n# gate-watch: src/migrations/retiredCrewSpellings.ts\n',
    already: '# gate-watch: src/migrations/retiredCrewSpellings.ts\n',
  },
  {
    file: 'scripts/compact/prove-prune-set.ts',
    why: 'the old name the prune law still protects is the table\'s',
    find: "const NEVER = ['AskUserQuestion', 'ToolSearch', 'LiveComms', 'LiveComms']\n",
    replace: "const { RETIRED_LIVE_COMMS_TOOL_NAME } = await import('../../src/migrations/retiredCrewSpellings.ts')\nconst NEVER = ['AskUserQuestion', 'ToolSearch', 'LiveComms', RETIRED_LIVE_COMMS_TOOL_NAME]\n",
    already: "const NEVER = ['AskUserQuestion', 'ToolSearch', 'LiveComms', RETIRED_LIVE_COMMS_TOOL_NAME]\n",
  },
  {
    file: 'scripts/compact/run-all.sh',
    why: 'the gate watches the table the prune-set pin now reads',
    find: '# gate-watch: src/context.ts\n',
    replace: '# gate-watch: src/context.ts\n# gate-watch: src/migrations/retiredCrewSpellings.ts\n',
    already: '# gate-watch: src/migrations/retiredCrewSpellings.ts\n',
  },
  {
    file: 'scripts/build-identity/prove-config-home.ts',
    why: 'the pin of the one bounded env reader is trued to the alias law: the registered spelling, then its former one',
    find: "check('flagEnv reads exactly the registered spelling', /return process\\.env\\[spec\\.env\\]\\n\\}/.test(registrySrc))\n",
    replace: "check('flagEnv reads the registered spelling, then the former spelling the registry names, and nothing else', /return process\\.env\\[spec\\.env\\] \\?\\? \\(spec\\.formerly === undefined \\? undefined : process\\.env\\[spec\\.formerly\\]\\)\\n\\}/.test(registrySrc))\n",
    already: "check('flagEnv reads the registered spelling, then the former spelling the registry names, and nothing else'",
  },
]

type PrePatch = { file: string; find: string; replace: string } & Why
const PRE_PATCHES: PrePatch[] = [
  {
    file: 'scripts/swarm/prove-livecomms-store.ts',
    find: "let tool: AnyTool\nlet toolHome = 'src/tools/LiveCommsTool/LiveCommsTool.js'\ntry {\n  tool = (await import('../../src/tools/LiveCommsTool/LiveCommsTool.js')).LiveCommsTool as unknown as AnyTool\n} catch {\n  toolHome = 'src/tools/TeamBriefTool/TeamBriefTool.js'\n  tool = (await import('../../src/tools/TeamBriefTool/TeamBriefTool.js')).TeamBriefTool as unknown as AnyTool\n}\n",
    replace: "const toolHome = 'src/tools/LiveCommsTool/LiveCommsTool.js'\nconst tool = (await import('../../src/tools/LiveCommsTool/LiveCommsTool.js')).LiveCommsTool as unknown as AnyTool\n",
    why: 'the fallback import of the removed tool folder was dead code',
  },
  {
    file: 'scripts/substrate/prove-coordination-livecomms.ts',
    find: "let liveTool: AnyTool\nlet toolHome = 'src/tools/LiveCommsTool/LiveCommsTool.js'\ntry {\n  liveTool = (await import('../../src/tools/LiveCommsTool/LiveCommsTool.js')).LiveCommsTool as unknown as AnyTool\n} catch {\n  toolHome = 'src/tools/TeamBriefTool/TeamBriefTool.js'\n  liveTool = (await import('../../src/tools/TeamBriefTool/TeamBriefTool.js')).TeamBriefTool as unknown as AnyTool\n}\n",
    replace: "const toolHome = 'src/tools/LiveCommsTool/LiveCommsTool.js'\nconst liveTool = (await import('../../src/tools/LiveCommsTool/LiveCommsTool.js')).LiveCommsTool as unknown as AnyTool\n",
    why: 'the fallback import of the removed tool folder was dead code',
  },
  {
    file: 'scripts/substrate/prove-coordination-livecomms.ts',
    find: "    const crewWords = verbs.filter(t => /\\bteam\\b|teammate|TEAM-ONLY|TeamBrief/i.test(t.description ?? ''))\n    check('no verb description says team, teammate or TeamBrief (RED on the base: TEAM-ONLY, teammates, \"the TeamBrief tool\")', crewWords.length === 0, crewWords.map(t => `${t.name}: ${(t.description ?? '').slice(0, 80)}`).join(' | '))\n",
    replace: "    const OLD_WORD = ['t', 'eam'].join('')\n    const oldWords = verbs.filter(t => new RegExp(`\\\\b${OLD_WORD}\\\\b|${OLD_WORD}mate|${OLD_WORD.toUpperCase()}-ONLY|${OLD_WORD.replace('t', 'T')}Brief`, 'i').test(t.description ?? ''))\n    check('no verb description says the old word (RED on the base: the old-only mark, the old mates, the old brief tool)', oldWords.length === 0, oldWords.map(t => `${t.name}: ${(t.description ?? '').slice(0, 80)}`).join(' | '))\n",
    why: 'the hunter of the old word in the verb descriptions composes the word it hunts, so the rename cannot turn it around',
  },
  {
    file: 'scripts/substrate/prove-coordination-livecomms.ts',
    find: "check('the server instructions speak of the crew and LiveComms, not the team mailbox (RED on the base: \"team brief\", \"team-mailbox\")', /crew/.test(instructions) && /LiveComms/.test(instructions) && !/\\bteam\\b|team-mailbox/i.test(instructions), instructions)\n",
    replace: "check('the server instructions speak of the crew and LiveComms, never the old word (RED on the base: the old brief, the old mailbox)', /crew/.test(instructions) && /LiveComms/.test(instructions) && !new RegExp(`\\\\b${OLD_WORD}\\\\b|${OLD_WORD}-mailbox`, 'i').test(instructions), instructions)\n",
    why: 'the hunter of the old word in the server instructions composes the word it hunts',
  },
  {
    file: 'scripts/crew/prove-crew-from-birth.ts',
    find: "  tally.check('the first brief names the session\\'s crew and lists scout', brief !== null && new RegExp(`# (Team|Crew): ${sessionId}`)",
    replace: "  tally.check('the first brief names the session\\'s crew and lists scout', brief !== null && new RegExp(`# Crew: ${sessionId}`)",
    why: 'the brief header has one spelling now',
  },
  {
    file: 'scripts/crew/prove-crew-from-birth.ts',
    find: "  tally.check('the resumed brief names the same crew and still lists scout', brief !== null && new RegExp(`# (Team|Crew): ${sessionId}`)",
    replace: "  tally.check('the resumed brief names the same crew and still lists scout', brief !== null && new RegExp(`# Crew: ${sessionId}`)",
    why: 'the brief header has one spelling now',
  },
  { file: 'src/components/HelpV2/commandDomains.ts', find: "      'team', 'router', 'invite', 'handoff',\n", replace: "      'router', 'invite', 'handoff',\n", why: 'the /team door goes from the help domains' },
  {
    file: 'scripts/ui/prove-crew-center.ts',
    find: "section('§3 — /team deep link')\n{\n  const crew = (await import('../../src/commands/team/index.js')).default\n  check('command name is team', crew.name === 'team')\n  check('description names the crew board', crew.description.includes('Crew board'))\n  check('not hidden', crew.isHidden !== true)\n  const crewSrc = src('commands', 'team', 'index.ts')\n  check('routes into the CANONICAL surface (no competing dashboard)', crewSrc.includes(\"import('../tasks/tasks.js')\"))\n}\n",
    replace: "section('§3 — the crew board\\'s deep link is /runs')\n{\n  const runs = (await import('../../src/commands/tasks/index.js')).default\n  check('command name is runs', runs.name === 'runs')\n  check('description names the runs board', runs.description.includes('runs board'))\n  check('not hidden', runs.isHidden !== true)\n  const runsSrc = src('commands', 'tasks', 'index.ts')\n  check('routes into the CANONICAL surface (no competing dashboard)', runsSrc.includes(\"import('./tasks.js')\"))\n}\n",
    why: 'the /team door went; the board it opened is /runs',
  },
  { file: 'src/commands.ts', find: "import team from './commands/team/index.js'\n", replace: '', why: 'the /team door goes' },
  { file: 'src/commands.ts', find: '  team,\n', replace: '', why: 'the /team door goes' },
  { file: 'src/services/resources/registry.ts', find: "import { teamAdapter } from './adapters/team.js'\n", replace: '', why: 'the mercury://team kind goes' },
  { file: 'src/services/resources/registry.ts', find: '  teamAdapter,\n', replace: '', why: 'the mercury://team kind goes' },
  {
    file: 'src/utils/swarm/permissionSync.ts',
    find: "import { createPermissionRequestMessage, createPermissionResponseMessage, createSandboxPermissionRequestMessage, createSandboxPermissionResponseMessage } from '../../services/crew/liveMessages.js'\n",
    replace: "import { createPermissionRequestMessage, createSandboxPermissionRequestMessage } from '../../services/crew/liveMessages.js'\n",
    why: 'the two response message makers leave with their senders',
  },
  {
    file: 'src/utils/swarm/permissionSync.ts',
    find: "export async function sendPermissionResponseViaMailbox(\n  workerName: string,\n  resolution: PermissionResolution,\n  requestId: string,\n  teamName?: string,\n): Promise<boolean> {\n  try {\n    const crew = resolveCrew(teamName)\n    if (!crew) {\n      logForDebugging('permission sync: no team — permission response not sent')\n      return false\n    }\n    const message = createPermissionResponseMessage({\n      request_id: requestId,\n      subtype: resolution.decision === 'approved' ? 'success' : 'error',\n      ...(resolution.feedback !== undefined ? { error: resolution.feedback } : {}),\n      ...(resolution.updatedInput !== undefined ? { updated_input: resolution.updatedInput } : {}),\n      ...(resolution.permissionUpdates !== undefined\n        ? { permission_updates: resolution.permissionUpdates }\n        : {}),\n    })\n    return await sendLiveMessage(crew, {\n      to: workerName,\n      from: getAgentName() ?? CREW_LEAD_NAME,\n      text: JSON.stringify(message),\n      timestamp: new Date().toISOString(),\n    })\n  } catch (error) {\n    logError(error)\n    return false\n  }\n}\n\n",
    replace: '',
    why: 'the permission response sender lost its last caller when the mailbox went',
  },
  {
    file: 'src/utils/swarm/permissionSync.ts',
    find: "\nexport async function sendSandboxPermissionResponseViaMailbox(\n  workerName: string,\n  requestId: string,\n  host: string,\n  allow: boolean,\n  teamName?: string,\n): Promise<boolean> {\n  try {\n    const crew = resolveCrew(teamName)\n    if (!crew) {\n      logForDebugging('permission sync: no team — sandbox response not sent')\n      return false\n    }\n    const message = createSandboxPermissionResponseMessage({ requestId, host, allow })\n    return await sendLiveMessage(crew, {\n      to: workerName,\n      from: getAgentName() ?? CREW_LEAD_NAME,\n      text: JSON.stringify(message),\n      timestamp: new Date().toISOString(),\n    })\n  } catch (error) {\n    logError(error)\n    return false\n  }\n}\n",
    replace: '',
    why: 'the sandbox response sender lost its last caller when the mailbox went',
  },
  {
    file: 'src/hooks/useSwarmPermissionPoller.ts',
    find: "export function processSandboxPermissionResponse({\n  requestId,\n  host,\n  allow,\n}: {\n  requestId: string\n  host: string\n  allow: boolean\n}): boolean {\n  void host\n  const callback = sandboxCallbacks.get(requestId)\n  if (callback === undefined) {\n    logForDebugging(`sandbox response for unregistered request ${requestId}`)\n    return false\n  }\n  sandboxCallbacks.delete(requestId)\n  callback.resolve(allow)\n  return true\n}\n\n",
    replace: '',
    why: 'the sandbox response dispatcher lost its last caller when the mailbox went',
  },
]

const PRE_PATCHED: string[] = []

function prePatched(rel: string, text: string): string {
  let out = text
  for (const p of PRE_PATCHES) {
    if (p.file !== rel) continue
    const at = out.indexOf(p.find)
    if (at === -1 || out.indexOf(p.find, at + 1) !== -1) continue
    out = out.slice(0, at) + p.replace + out.slice(at + p.find.length)
    PRE_PATCHED.push(`${rel}: ${p.why}`)
  }
  return out
}

const GENERATORS: Generator[] = [
  { command: ['scripts/ownership/prove-contract-inventory.ts', '--record'], touches: ['scripts/ownership/contract-inventory.json'], why: 'the export inventory is sorted by name' },
  { command: ['scripts/consistency-census/gen-basename-census.ts'], touches: ['scripts/consistency-census/basename-census.json'], why: 'the basename census is sorted' },
  { command: ['scripts/settings/gen-settings-schema.ts', '--out', 'scripts/settings/settings-schema.json'], touches: ['scripts/settings/settings-schema.json'], why: 'the settings schema follows the hook event key' },
  { command: ['scripts/engine-durability/prove-write-route-ratchet.ts', '--regen'], touches: ['scripts/engine-durability/write-routes.baseline.json'], why: 'the write-route baseline is keyed by file path' },
  { command: ['scripts/vulcan/regen-optable.mjs'], touches: ['src/utils/vulcan/optable.generated.ts', 'assets/vulcan/addon/core/op_classes.gd'], why: 'the op table is generated from its JSON source, which the rename touches' },
  { command: ['scripts/consistency-census/gen-shellstring-census.ts'], touches: ['scripts/consistency-census/shellstring-census.json'], why: 'the shell-string census records the strings the rename touches' },
  { command: ['scripts/orphans/prove-no-orphans.ts', '--regen'], touches: ['scripts/orphans/baseline.json'], why: 'the orphan baseline names files the rename removes or renames' },
]

const TOKEN_RE = /TEAMMATES|TEAMMATE|TEAMNAME|TEAMS|TEAM|Teammates|Teammate|Teams|Team|proofteam|proveteam|teammates|teammate|teamcreate|teamdelete|teamname|teams|team/g
const TOKEN_TO: Record<string, string> = {
  proofteam: 'proofcrew',
  proveteam: 'provecrew',
  TEAMNAME: 'CREWNAME',
  teamcreate: 'crewcreate',
  teamdelete: 'crewdelete',
  teamname: 'crewname',
  TEAMMATES: 'CREWMATES',
  TEAMMATE: 'CREWMATE',
  TEAMS: 'CREWS',
  TEAM: 'CREW',
  Teammates: 'Crewmates',
  Teammate: 'Crewmate',
  Teams: 'Crews',
  Team: 'Crew',
  teammates: 'crewmates',
  teammate: 'crewmate',
  teams: 'crews',
  team: 'crew',
}

type Context = 'identifier' | 'property' | 'string' | 'path' | 'prose' | 'filename'

const isLower = (c: string): boolean => c >= 'a' && c <= 'z'
const isUpper = (c: string): boolean => c >= 'A' && c <= 'Z'
const isLetter = (c: string): boolean => isLower(c) || isUpper(c)
const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isAlnum = (c: string): boolean => isLetter(c) || isDigit(c)
const isWordChar = (c: string): boolean => isAlnum(c) || c === '_'
const isRunChar = (c: string): boolean => isWordChar(c) || c === '-'

function runAround(text: string, start: number, end: number, pred: (c: string) => boolean): [number, number] {
  let lo = start
  while (lo > 0 && pred(text[lo - 1]!)) lo--
  let hi = end
  while (hi < text.length && pred(text[hi]!)) hi++
  return [lo, hi]
}

type Skip = { reason: string; token: string; run: string }
type Tally = { renamed: Map<string, number>; skipped: Map<string, number>; skips: Skip[] }

const tally = (): Tally => ({ renamed: new Map(), skipped: new Map(), skips: [] })

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

function mergeTally(into: Tally, from: Tally, label: string): void {
  for (const [k, v] of from.renamed) bump(into.renamed, k, v)
  for (const [k, v] of from.skipped) bump(into.skipped, k, v)
  for (const s of from.skips) into.skips.push({ ...s, run: `${label}: ${s.run}` })
}

function applyExplicit(text: string, t: Tally): string {
  if (!text.includes('TEAMS.md') && !text.includes('TeamBrief')) return text
  let out = text
  for (const e of EXPLICIT) {
    out = out.replace(e.re, () => {
      bump(t.renamed, `${e.from}→${e.to}`)
      return e.to
    })
  }
  return out
}

function collapse(run: string): string {
  let out = run
  for (const [from, to] of COLLAPSE) if (out.includes(from)) out = out.split(from).join(to)
  return out
}

class Renamer {
  fileProtect = new Set<string>()
  fileMap: Record<string, string> = {}
  collisionProtect = new Set<string>()

  fileAllow = new Set<string>()

  forFile(rel: string): void {
    this.fileProtect = new Set()
    this.collisionProtect = new Set()
    this.fileAllow = new Set()
    this.fileMap = {}
    for (const r of FILE_RULES) {
      if (r.path !== rel) continue
      for (const n of r.protect ?? []) this.fileProtect.add(n)
      for (const n of r.allow ?? []) this.fileAllow.add(n)
      Object.assign(this.fileMap, r.map ?? {})
    }
  }

  rewrite(text: string, ctx: Context, t: Tally): string {
    if (!/team/i.test(text)) return text
    let out = ''
    let last = 0
    const re = new RegExp(TOKEN_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index < last) continue
      const [lo, hi] = runAround(text, m.index, m.index + m[0].length, isRunChar)
      const run = text.slice(lo, hi)
      const around = { text: text.slice(Math.max(0, lo - 24), Math.min(text.length, hi + 24)), at: lo - Math.max(0, lo - 24), escaped: lo > 0 && text[lo - 1] === '\\' }
      const newRun = this.rewriteRun(run, ctx, t, around)
      out += text.slice(last, lo) + newRun
      last = hi
      re.lastIndex = hi
    }
    return out + text.slice(last)
  }

  private rewriteRun(run: string, ctx: Context, t: Tally, around: { text: string; at: number; escaped: boolean }): string {
    const mapped = this.fileMap[run]
    if (mapped !== undefined && (ctx === 'identifier' || ctx === 'property')) {
      bump(t.renamed, `${run}→${mapped}`)
      return mapped
    }
    let out = ''
    let last = 0
    let changed = false
    const re = new RegExp(TOKEN_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(run)) !== null) {
      const token = m[0]
      const start = m.index
      const end = start + token.length
      const verdict = this.decide(run, start, end, token, ctx, around)
      if (verdict.to === null) {
        bump(t.skipped, token)
        t.skips.push({ reason: verdict.reason, token, run })
        continue
      }
      out += run.slice(last, start) + verdict.to
      last = end
      changed = true
      bump(t.renamed, `${token}→${verdict.to}`)
    }
    if (!changed) return run
    return collapse(out + run.slice(last))
  }

  private decide(run: string, start: number, end: number, token: string, ctx: Context, around: { text: string; at: number; escaped: boolean }): { to: string | null; reason: string } {
    let prev = start > 0 ? run[start - 1]! : ''
    const next = end < run.length ? run[end]! : ''
    const form = token === token.toUpperCase() ? 'upper' : token[0] === 'T' ? 'cap' : 'lower'
    const no = (reason: string): { to: null; reason: string } => ({ to: null, reason })
    if (start === 1 && around.escaped && /[nrtbfv]/.test(prev)) prev = ''
    const joined = token === 'proofteam' || token === 'proveteam'
    if (form === 'lower' && !joined && (isLetter(prev) || isLower(next))) return no('inside another word')
    if (joined && isLetter(prev)) return no('inside another word')
    if (form === 'cap' && isLower(next)) return no('inside another word')
    if (form === 'upper' && (isUpper(prev) || isUpper(next))) return no('inside another word')
    const [wlo, whi] = runAround(run, start, end, isWordChar)
    const word = run.slice(wlo, whi)
    if (this.fileProtect.has(word)) return no(`protected in this file: ${word}`)
    if ((ctx === 'identifier' || ctx === 'property') && this.collisionProtect.has(word)) return no(`COLLISION in this file: ${word} (its crew name is declared here; add a per-file map)`)
    const tokenAt = around.at + start
    for (const p of PROTECTED_PATTERNS) {
      const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`)
      let hit: RegExpExecArray | null
      while ((hit = re.exec(around.text)) !== null) {
        if (hit.index <= tokenAt && tokenAt < hit.index + hit[0].length) return no(`not the crew: ${p.why}`)
      }
    }
    return { to: TOKEN_TO[token]!, reason: '' }
  }
}

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })

function inScope(rel: string): boolean {
  return SCOPE_TOP_FILES.includes(rel) || SCOPE_ROOTS.some(r => rel.startsWith(r))
}

function excluded(rel: string): string | null {
  for (const e of EXCLUDED_PATHS) if (rel === e.prefix || rel.startsWith(e.prefix)) return e.why
  return null
}

function frozen(rel: string): string | null {
  for (const f of FROZEN_FILES) if (rel === f.path) return f.why
  return null
}

function removed(rel: string): string | null {
  for (const r of REMOVED_PATHS) if (rel === r.path) return r.why
  return null
}

function pinned(rel: string): string | null {
  for (const p of PINNED_PATHS) if (rel === p.path || rel.startsWith(p.path)) return p.why
  return null
}

function renamePath(rel: string, renamer: Renamer, t: Tally): string {
  if (pinned(rel) !== null) return rel
  const parts = rel.split('/')
  return parts
    .map((segment, i) => {
      const isFile = i === parts.length - 1
      const ext = isFile ? extname(segment) : ''
      const stem = isFile ? segment.slice(0, segment.length - ext.length) : segment
      const viaExplicit = applyExplicit(segment, t)
      if (viaExplicit !== segment) return viaExplicit
      return renamer.rewrite(stem, 'filename', t) + ext
    })
    .join('/')
}

type FilePlan = { rel: string; newRel: string; text: string | null; newText: string | null; replacements: number }

function scriptKindOf(rel: string): ts.ScriptKind {
  const ext = extname(rel)
  if (ext === '.tsx') return ts.ScriptKind.TSX
  if (ext === '.jsx') return ts.ScriptKind.JSX
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

type Leaf = { start: number; end: number; ctx: Context }

const KEY_TYPES = new Set(['Pick', 'Omit', 'Extract', 'Exclude'])

function propertyName(node: ts.Node): boolean {
  const p = node.parent
  if (p === undefined) return false
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isEnumMember(p) || ts.isShorthandPropertyAssignment(p) || ts.isJsxAttribute(p)) && p.name === node) return true
  if (ts.isPropertyAccessExpression(p) && p.name === node) return true
  if (ts.isBindingElement(p) && p.propertyName === node) return true
  return false
}

function keyPosition(node: ts.Node): boolean {
  const p = node.parent
  if (p === undefined) return false
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isEnumMember(p)) && p.name === node) return true
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InKeyword && p.left === node) return true
  if (!ts.isLiteralTypeNode(p)) return false
  let t: ts.Node = p
  while (t.parent !== undefined && (ts.isUnionTypeNode(t.parent) || ts.isParenthesizedTypeNode(t.parent))) t = t.parent
  const q = t.parent
  if (q === undefined) return false
  if (ts.isIndexedAccessTypeNode(q) && q.indexType === t) return true
  if (ts.isTypeReferenceNode(q) && q.typeArguments !== undefined && ts.isIdentifier(q.typeName)) {
    const idx = q.typeArguments.indexOf(t as ts.TypeNode)
    if (KEY_TYPES.has(q.typeName.text) && idx === 1) return true
    if (q.typeName.text === 'Record' && idx === 0) return true
  }
  return false
}

function leavesOf(sf: ts.SourceFile): Leaf[] {
  const out: Leaf[] = []
  const visit = (node: ts.Node): void => {
    let hasChild = false
    ts.forEachChild(node, child => {
      hasChild = true
      visit(child)
    })
    if (hasChild) return
    const k = node.kind
    let ctx: Context | null = null
    if (k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.PrivateIdentifier) ctx = propertyName(node) ? 'property' : 'identifier'
    else if (k === ts.SyntaxKind.StringLiteral && keyPosition(node) && /^[A-Za-z_$][\w$]*$/.test((node as ts.StringLiteral).text)) ctx = 'property'
    else if (
      k === ts.SyntaxKind.StringLiteral ||
      k === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      k === ts.SyntaxKind.TemplateHead ||
      k === ts.SyntaxKind.TemplateMiddle ||
      k === ts.SyntaxKind.TemplateTail ||
      k === ts.SyntaxKind.RegularExpressionLiteral
    ) ctx = 'string'
    else if (k === ts.SyntaxKind.JsxText) ctx = 'prose'
    if (ctx === null) return
    out.push({ start: node.getStart(sf), end: node.getEnd(), ctx })
  }
  visit(sf)
  return out.sort((a, b) => a.start - b.start)
}

const REPO_PATH_RE = /^(\.\.?\/|src\/|scripts\/|docs\/|design-system\/|assets\/|integrations\/)/
const TEXT_PATH_RE = /(?:\.\.?\/|(?<![A-Za-z0-9_./-])(?:src|scripts|docs|design-system|assets|integrations)\/)[A-Za-z0-9_./*-]+/g

class Planner {
  readonly renamer = new Renamer()
  readonly renameMap = new Map<string, string>()
  readonly dirMap = new Map<string, string>()
  readonly plans: FilePlan[] = []
  readonly t = tally()
  readonly perFile = new Map<string, number>()
  readonly files: string[]
  readonly fileSet: Set<string>
  readonly collisions: string[] = []

  constructor(readonly root: string) {
    this.files = git(root, 'ls-files', '-z').split('\0').filter(Boolean)
    this.fileSet = new Set(this.files)
  }

  planRenames(): void {
    const existing = new Set(this.files)
    const targets = new Map<string, string>()
    for (const rel of this.files) {
      if (!inScope(rel) || excluded(rel) !== null || removed(rel) !== null) continue
      const newRel = renamePath(rel, this.renamer, tally())
      if (newRel === rel) continue
      this.renameMap.set(rel, newRel)
      if (targets.has(newRel)) this.collisions.push(`${rel} and ${targets.get(newRel)} both become ${newRel}`)
      targets.set(newRel, rel)
      let from = posix.dirname(rel)
      let to = posix.dirname(newRel)
      while (from !== '.' && from !== to) {
        this.dirMap.set(from, to)
        from = posix.dirname(from)
        to = posix.dirname(to)
      }
    }
    for (const [from, to] of this.renameMap) {
      if (existing.has(to) && !this.renameMap.has(to)) this.collisions.push(`${from} would become ${to}, which exists`)
    }
  }

  private mapRepoPath(path: string): string {
    const exact = this.renameMap.get(path)
    if (exact !== undefined) return exact
    const star = path.indexOf('*')
    if (star !== -1) {
      const head = path.slice(0, star)
      const slash = head.lastIndexOf('/')
      const dirPart = slash === -1 ? '' : head.slice(0, slash)
      const stemPart = head.slice(slash + 1)
      const mappedDir = dirPart === '' ? '' : this.mapDir(dirPart)
      const renamedStem = stemPart !== '' && [...this.renameMap].some(([from]) => posix.dirname(from) === dirPart && basename(from).startsWith(stemPart))
      const stem = renamedStem ? this.renamer.rewrite(applyExplicit(stemPart, tally()), 'filename', tally()) : stemPart
      return (mappedDir === '' ? '' : `${mappedDir}/`) + stem + path.slice(star)
    }
    return this.mapDir(path)
  }

  private mapDir(path: string): string {
    let best: [string, string] | null = null
    for (const [from, to] of this.dirMap) {
      if (path === from || path.startsWith(`${from}/`)) if (best === null || from.length > best[0].length) best = [from, to]
    }
    if (best !== null) return best[1] + path.slice(best[0].length)
    return path
  }

  private mapPathString(raw: string, fromRel: string): string {
    if (!raw.includes('/') || !REPO_PATH_RE.test(raw)) return raw
    if (!raw.startsWith('.')) return this.mapRepoPath(raw)
    const dir = posix.dirname(fromRel)
    const target = posix.normalize(posix.join(dir, raw))
    const ext = extname(raw)
    const stems = ext === '.js' ? ['.ts', '.tsx', '.js'] : ext === '.mjs' ? ['.mts', '.mjs'] : ext === '' ? ['', '.ts', '.tsx'] : [ext]
    const bare = ext === '' ? target : target.slice(0, target.length - ext.length)
    for (const s of stems) {
      const mapped = this.renameMap.get(bare + s)
      if (mapped === undefined) continue
      const mappedBare = s === '' ? mapped : mapped.slice(0, mapped.length - extname(mapped).length)
      const back = posix.relative(dir, mappedBare) + ext
      return back.startsWith('.') ? back : `./${back}`
    }
    const mappedDir = this.mapRepoPath(target)
    if (mappedDir !== target) {
      const back = posix.relative(dir, mappedDir)
      return back.startsWith('.') ? back : `./${back}`
    }
    return raw
  }

  private basenameFallback(path: string): string | null {
    const name = basename(path)
    const stem = name.replace(/\.(js|mjs|ts|tsx|mts)$/, '')
    const hits = [...this.renameMap].filter(([from]) => basename(from).replace(/\.(ts|tsx|mts)$/, '') === stem)
    if (hits.length !== 1) return null
    const toStem = basename(hits[0]![1]).replace(/\.(ts|tsx|mts)$/, '')
    if (toStem === stem) return null
    return path.slice(0, path.length - name.length) + name.replace(stem, toStem)
  }

  private resolvesToTracked(raw: string, fromRel: string): boolean {
    const target = raw.startsWith('.') ? posix.normalize(posix.join(posix.dirname(fromRel), raw)) : raw
    const star = target.indexOf('*')
    if (star !== -1) {
      const head = target.slice(0, star)
      return this.files.some(f => f.startsWith(head))
    }
    const stem = target.replace(/\.(js|mjs|ts|tsx|mts)$/, '')
    const candidates = [target, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.js`, `${stem}.mjs`, `${target}/index.ts`, `${stem}/index.ts`]
    if (candidates.some(c => this.fileSet.has(c))) return true
    const dir = target.endsWith('/') ? target.slice(0, -1) : target
    return this.files.some(f => f.startsWith(`${dir}/`))
  }

  private resolvesToPinned(raw: string, fromRel: string): boolean {
    if (!raw.includes('/')) return false
    const target = raw.startsWith('.') ? posix.normalize(posix.join(posix.dirname(fromRel), raw)) : raw
    const stem = target.replace(/\.(js|mjs|ts|tsx|mts)$/, '')
    return pinned(target) !== null || pinned(`${stem}.ts`) !== null || pinned(`${stem}.tsx`) !== null || pinned(`${stem}.mts`) !== null
  }

  private rewriteString(literal: string, fromRel: string, t: Tally): string {
    const q = literal[0]!
    const quoted = q === '\'' || q === '"' || q === '`'
    const body = quoted ? literal.slice(1, -1) : literal
    const wholeLiteral = quoted ? PROTECTED_PATTERNS.find(p => new RegExp(`^(?:${p.re.source})$`).test(literal)) : undefined
    if (wholeLiteral !== undefined) {
      t.skips.push({ reason: `not the crew: ${wholeLiteral.why}`, token: body, run: body })
      return literal
    }
    if (/\s/.test(body)) {
      const rewrittenText = this.rewriteText(fromRel, body, t)
      return quoted ? q + rewrittenText + literal[literal.length - 1]! : rewrittenText
    }
    if (this.resolvesToPinned(body, fromRel)) {
      t.skips.push({ reason: 'a path to a pinned file', token: body, run: body })
      return literal
    }
    const lineSuffix = /(:\d+)+$/.exec(body)?.[0] ?? ''
    const pathBody = lineSuffix === '' ? body : body.slice(0, body.length - lineSuffix.length)
    if (pathBody.includes('/') && REPO_PATH_RE.test(pathBody) && !this.resolvesToTracked(pathBody, fromRel)) {
      const byBasename = this.basenameFallback(pathBody)
      if (byBasename !== null) {
        bump(t.renamed, `${basename(pathBody)}→${basename(byBasename)}`)
        return quoted ? q + byBasename + lineSuffix + literal[literal.length - 1]! : byBasename + lineSuffix
      }
    }
    const mapped = this.mapPathString(pathBody, fromRel) + lineSuffix
    const pathLike = body.includes('/') && REPO_PATH_RE.test(body)
    const rewritten = this.renamer.rewrite(applyExplicit(mapped, t), pathLike ? 'path' : 'string', t)
    return quoted ? q + rewritten + literal[literal.length - 1]! : rewritten
  }

  private masks(text: string): Array<[number, number]> {
    const out: Array<[number, number]> = []
    for (const p of PROTECTED_PATTERNS.slice(0, 1)) {
      const re = new RegExp(p.re.source, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length])
    }
    return out
  }

  readonly collisionKept: string[] = []

  private collisionProtect(rel: string, sf: ts.SourceFile): void {
    const declared = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (
        (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name)
      ) declared.add(node.name.text)
      if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) declared.add(node.name.text)
      if (ts.isImportClause(node) && node.name !== undefined) declared.add(node.name.text)
      ts.forEachChild(node, visit)
    }
    visit(sf)
    for (const name of declared) {
      if (!/team/i.test(name) || this.renamer.fileProtect.has(name)) continue
      const renamed = this.renamer.rewrite(name, 'identifier', tally())
      if (renamed !== name && declared.has(renamed) && this.renamer.fileMap[name] === undefined && !this.renamer.fileAllow.has(name)) {
        this.renamer.collisionProtect.add(name)
        this.collisionKept.push(`${rel}: ${name} → ${renamed} collides with a name declared there`)
      }
    }
  }

  private rewriteCode(rel: string, text: string, t: Tally): string {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindOf(rel))
    this.collisionProtect(rel, sf)
    const leaves = leavesOf(sf)
    const masks = this.masks(text)
    const masked = (a: number, b: number): boolean => masks.some(([lo, hi]) => a < hi && b > lo)
    let out = ''
    let last = 0
    const piece = (a: number, b: number, ctx: Context): string => {
      const raw = text.slice(a, b)
      if (masked(a, b)) return raw
      if (ctx === 'string') return this.rewriteString(raw, rel, t)
      return this.renamer.rewrite(applyExplicit(raw, t), ctx, t)
    }
    for (const leaf of leaves) {
      if (leaf.start < last) continue
      out += piece(last, leaf.start, 'prose')
      out += piece(leaf.start, leaf.end, leaf.ctx)
      last = leaf.end
    }
    return out + piece(last, text.length, 'prose')
  }

  private rewriteText(rel: string, text: string, t: Tally): string {
    let out = ''
    let last = 0
    const re = new RegExp(TEXT_PATH_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      out += this.renamer.rewrite(applyExplicit(text.slice(last, m.index), t), 'prose', t)
      out += this.rewriteString(m[0], rel, t)
      last = m.index + m[0].length
    }
    return out + this.renamer.rewrite(applyExplicit(text.slice(last), t), 'prose', t)
  }

  planContents(): void {
    for (const rel of this.files) {
      if (!inScope(rel) || excluded(rel) !== null || removed(rel) !== null) continue
      const newRel = this.renameMap.get(rel) ?? rel
      const textual = TEXT_EXTENSIONS.has(extname(rel)) || rel.endsWith('members.txt') || rel.endsWith('run-all.sh')
      if (!textual || frozen(rel) !== null) {
        if (newRel !== rel) this.plans.push({ rel, newRel, text: null, newText: null, replacements: 0 })
        continue
      }
      const original = readFileSync(join(this.root, rel), 'utf8')
      const text = prePatched(rel, original)
      if (!/team/i.test(text)) {
        if (newRel !== rel || text !== original) this.plans.push({ rel, newRel, text: original, newText: text, replacements: 0 })
        continue
      }
      const t = tally()
      this.renamer.forFile(rel)
      const newText = CODE_EXTENSIONS.has(extname(rel)) ? this.rewriteCode(rel, text, t) : this.rewriteText(rel, text, t)
      let replacements = 0
      for (const n of t.renamed.values()) replacements += n
      mergeTally(this.t, t, rel)
      if (newText !== original || newRel !== rel) {
        this.plans.push({ rel, newRel, text: original, newText, replacements })
        if (replacements > 0) this.perFile.set(rel, replacements)
      }
    }
  }
}

function applyAliasPatches(root: string, renameMap: Map<string, string>, log: string[]): { applied: number; already: number; missing: string[] } {
  let applied = 0
  let already = 0
  const missing: string[] = []
  for (const p of ALIAS_PATCHES) {
    const rel = renameMap.get(p.file) ?? p.file
    const abs = join(root, rel)
    if (!existsSync(abs)) {
      missing.push(`${p.file}: file absent (${p.why})`)
      continue
    }
    const text = readFileSync(abs, 'utf8')
    if (text.includes(p.already)) {
      already++
      continue
    }
    const at = text.indexOf(p.find)
    if (at === -1 && p.optional === true) {
      log.push(`  not needed in ${rel}: ${p.why}`)
      continue
    }
    if (at === -1 || text.indexOf(p.find, at + 1) !== -1) {
      missing.push(`${p.file}: anchor ${at === -1 ? 'absent' : 'ambiguous'} for: ${p.why}`)
      continue
    }
    writeFileSync(abs, text.slice(0, at) + p.replace + text.slice(at + p.find.length))
    applied++
    log.push(`  patched ${rel}: ${p.why}`)
  }
  return { applied, already, missing }
}

function pruneEmptyDirs(root: string, rels: Iterable<string>): void {
  const dirs = new Set<string>()
  for (const rel of rels) {
    let d = posix.dirname(rel)
    while (d !== '.' && d !== '') {
      dirs.add(d)
      d = posix.dirname(d)
    }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    const abs = join(root, d)
    try {
      if (existsSync(abs) && readdirSync(abs).length === 0) rmdirSync(abs)
    } catch {
      continue
    }
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const reportAt = args.indexOf('--report')
  const reportPath = reportAt !== -1 ? args[reportAt + 1] : undefined
  const rootAt = args.indexOf('--root')
  const root = resolve(rootAt !== -1 ? args[rootAt + 1]! : join(import.meta.dir, '..', '..'))
  const skipGenerators = args.includes('--no-generators')
  const showSkips = args.includes('--skips')

  const dirty = git(root, 'status', '--porcelain', '--untracked-files=no').trim()
  if (dirty !== '') {
    console.error(`refused: the tree at ${root} has uncommitted changes to tracked files:\n${dirty}`)
    process.exit(2)
  }
  const head = git(root, 'rev-parse', 'HEAD').trim()
  const lines: string[] = []
  const say = (s: string): void => {
    lines.push(s)
    console.log(s)
  }
  say(`# rename team → crew — ${apply ? 'APPLY' : 'PLAN'} on ${root} at ${head}`)

  const planner = new Planner(root)
  planner.planRenames()
  planner.planContents()

  say('')
  say(`## files renamed: ${planner.renameMap.size}`)
  for (const [from, to] of [...planner.renameMap].sort()) say(`  ${from} → ${to}`)
  if (planner.collisions.length > 0) {
    say('## collisions')
    for (const c of planner.collisions) say(`  ${c}`)
  }
  const contentPlans = planner.plans.filter(p => p.newText !== null && p.newText !== p.text)
  let total = 0
  for (const n of planner.perFile.values()) total += n
  say('')
  say(`## contents: ${contentPlans.length} files rewritten, ${total} token replacements`)
  say('### distinct replacements (count, old→new)')
  for (const [k, v] of [...planner.t.renamed].sort((a, b) => b[1] - a[1])) say(`  ${v}\t${k}`)
  say('### replacements per file')
  for (const [k, v] of [...planner.perFile].sort((a, b) => b[1] - a[1])) say(`  ${v}\t${k}`)
  say('### skipped (token, count)')
  for (const [k, v] of [...planner.t.skipped].sort((a, b) => b[1] - a[1])) say(`  ${v}\t${k}`)
  const reasons = new Map<string, number>()
  for (const s of planner.t.skips) bump(reasons, s.reason)
  say('### skipped by reason')
  for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1])) say(`  ${v}\t${k}`)
  if (showSkips) {
    say('### every skip')
    for (const s of planner.t.skips) say(`  [${s.reason}] ${s.run}`)
  }
  say('')
  say('## keys and flags')
  say('  settings.json: hooks.TeammateIdle → hooks.CrewmateIdle (a RETIRED_SETTINGS_KEYS row: the old key is read and rewritten once)')
  say('  global config: teammateMode → crewmateMode, teammateDefaultModel → crewmateDefaultModel (RETIRED_GLOBAL_CONFIG_KEYS rows: the old keys are read)')
  say('  env: MERCURY_TEAMS_DIR → MERCURY_CREWS_DIR (MERCURY_CREW_DIR already names the crew store), MERCURY_TEAMMATES → MERCURY_CREWMATES, and MERCURY_TEAMMATE_COMMAND → MERCURY_CREWMATE_COMMAND where that row still exists (the former spelling is read when the current one is unset; stamps carry both)')
  say('## exclusions')
  for (const e of EXCLUDED_PATHS) say(`  never touched: ${e.prefix} — ${e.why}`)
  for (const f of FROZEN_FILES) say(`  content kept: ${f.path} — ${f.why}`)
  for (const p of PINNED_PATHS) say(`  name kept: ${p.path} — ${p.why}`)
  for (const r of REMOVED_PATHS) say(`  removed: ${r.path} — ${r.why}`)
  for (const p of PROTECTED_PATTERNS) say(`  not the crew: ${p.re.source} — ${p.why}`)
  for (const r of FILE_RULES) say(`  in ${r.path}: ${r.protect ? `kept ${r.protect.join(', ')}` : ''}${r.map ? Object.entries(r.map).map(([a, b]) => `${a} → ${b}`).join(', ') : ''} — ${r.why}`)
  say(`### COLLISIONS: names whose crew form is already declared in the same file — each needs a per-file map (${planner.collisionKept.length})`)
  for (const c of planner.collisionKept) say(`  ${c}`)
  say('  every other spelling in every context (identifiers, keys, strings, comments, docs, file names, paths, snake_case keys, dashed names) becomes the crew word; the old spellings survive only in the read-side alias tables (frozen files above)')

  if (planner.collisions.length > 0 || planner.collisionKept.length > 0) {
    say('refused: rename collisions above')
    if (reportPath !== undefined) writeFileSync(reportPath, lines.join('\n') + '\n')
    process.exit(3)
  }
  if (!apply) {
    if (reportPath !== undefined) writeFileSync(reportPath, lines.join('\n') + '\n')
    return
  }

  say('')
  say('## applying')
  const touched: string[] = []
  for (const r of REMOVED_PATHS) {
    if (!planner.fileSet.has(r.path)) {
      say(`  already gone: ${r.path}`)
      continue
    }
    git(root, 'rm', '-q', '--', r.path)
    say(`  removed ${r.path} — ${r.why}`)
  }
  pruneEmptyDirs(root, REMOVED_PATHS.map(r => r.path))
  for (const [from, to] of planner.renameMap) {
    mkdirSync(dirname(join(root, to)), { recursive: true })
    git(root, 'mv', '-k', from, to)
    touched.push(to)
  }
  pruneEmptyDirs(root, planner.renameMap.keys())
  for (const p of planner.plans) {
    if (p.newText === null || p.newText === p.text) continue
    writeFileSync(join(root, p.newRel), p.newText)
    touched.push(p.newRel)
  }
  const patchLog: string[] = []
  const patches = applyAliasPatches(root, planner.renameMap, patchLog)
  for (const l of patchLog) say(l)
  say(`  alias patches: ${patches.applied} applied, ${patches.already} already present, ${patches.missing.length} missing`)
  for (const m of patches.missing) say(`  MISSING ANCHOR: ${m}`)
  say(`  pre-patches: ${PRE_PATCHED.length} applied`)
  for (const l of PRE_PATCHED) say(`  pre-patched ${l}`)
  for (const p of ALIAS_PATCHES) touched.push(planner.renameMap.get(p.file) ?? p.file)
  if (!skipGenerators) {
    for (const g of GENERATORS) {
      const cmd = g.command[0]!
      const abs = join(root, cmd)
      if (!existsSync(abs)) {
        say(`  generator absent: ${cmd}`)
        continue
      }
      try {
        execFileSync(process.execPath, ['run', abs, ...g.command.slice(1)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 })
        say(`  regenerated: ${g.touches.join(', ')} — ${g.why}`)
      } catch (error) {
        say(`  GENERATOR FAILED: ${cmd} — ${String((error as Error).message).split('\n')[0]}`)
      }
      touched.push(...g.touches)
    }
  }
  const unique = [...new Set(touched)].filter(p => existsSync(join(root, p)))
  for (let i = 0; i < unique.length; i += 200) git(root, 'add', '--', ...unique.slice(i, i + 200))

  say('')
  say('## after')
  const status = git(root, 'status', '--porcelain', '-z').split('\0').filter(Boolean)
  const changed = status.map(s => s.slice(3))
  const forbidden = changed.filter(p => EXCLUDED_PATHS.some(e => p.startsWith(e.prefix) && e.prefix !== SELF))
  say(`  changed paths: ${status.length}`)
  say(`  paths changed inside an excluded area: ${forbidden.length}${forbidden.length > 0 ? ' — ' + forbidden.join(', ') : ''}`)
  const again = new Planner(root)
  again.planRenames()
  again.planContents()
  const againChanges = again.plans.filter(p => p.newText !== null && p.newText !== p.text).length + again.renameMap.size
  say(`  a second pass would change: ${againChanges} (0 means the rewrite is idempotent)`)
  if (againChanges > 0) for (const p of again.plans.slice(0, 20)) say(`    ${p.rel}${p.newRel !== p.rel ? ` → ${p.newRel}` : ''}`)
  if (reportPath !== undefined) writeFileSync(reportPath, lines.join('\n') + '\n')
  if (forbidden.length > 0 || patches.missing.length > 0 || againChanges > 0) process.exit(4)
}

main()
