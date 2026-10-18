#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'env-ask-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'env-ask-proj-')))
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'env-ask-outside-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.chdir(PROJ)

const file = (relative: string, text: string): string => {
  const path = join(PROJ, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}
file('.env', 'API_KEY=sk-live-fixture-0001\nDB_URL=postgres://u:p@host/db\n')
file('.env.local', 'API_KEY=sk-local-fixture-0002\n')
file('.env.production', 'API_KEY=sk-prod-fixture-0003\n')
file('.env.example', 'API_KEY=\nDB_URL=\n')
file('.env.sample', 'API_KEY=sample\n')
file('.env.template', 'API_KEY=template\n')
file('.env.production.example', 'API_KEY=\n')
file('.envrc', 'export API_KEY=direnv-fixture\n')
file('env/config.ts', 'export const API_KEY = "in-code"\n')
file('environment.ts', 'export const API_KEY = "in-code"\n')
file('notes.txt', 'API_KEY is read from the environment\n')
file('api/.env', 'API_KEY=sk-api-fixture-0004\n')
file('setup.sh', 'export PATH=$PATH\n')
symlinkSync(join(PROJ, '.env'), join(PROJ, 'link-to-env'))
symlinkSync(join(PROJ, 'api'), join(PROJ, 'linkdir'))
writeFileSync(join(OUTSIDE, '.env'), 'API_KEY=sk-outside-fixture-0005\n')
writeFileSync(join(OUTSIDE, 'notes.txt'), 'API_KEY outside\n')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const j = (value: unknown): string => JSON.stringify(value)

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const filesystem = await import('../../src/utils/permissions/filesystem.ts')
const { checkReadPermissionForTool } = filesystem
const isProjectEnvFileName: (path: string) => boolean = filesystem.isProjectEnvFileName ?? (() => false)
const envFileTargetsInGlob: (glob: string) => string[] = filesystem.envFileTargetsInGlob ?? (() => [])
const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { GlobTool } = await import('../../src/tools/GlobTool/GlobTool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { checkParsedPaths } = await import('../bash/floor-proof-helpers.ts')
const powershell = await import('../../src/tools/PowerShellTool/pathValidation.ts')

type Mode = 'default' | 'implement' | 'sovereign' | 'apollo'
type Rules = { allow?: string[]; deny?: string[]; ask?: string[] }
type Decision = { behavior: string; message?: string; decisionReason?: { type?: string; reason?: string; operatorOnly?: boolean; mode?: string; road?: string } }
type Outcome = { decision: Decision; trace: { decidedBy: string } }

function permissionOf(mode: Mode, rules: Rules = {}) {
  return {
    ...getEmptyToolPermissionContext(),
    mode,
    isBypassPermissionsModeAvailable: mode === 'sovereign',
    alwaysAllowRules: rules.allow ? { localSettings: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { localSettings: rules.deny } : {},
    alwaysAskRules: rules.ask ? { localSettings: rules.ask } : {},
  }
}
function contextOf(mode: Mode, rules: Rules = {}) {
  const state = { toolPermissionContext: permissionOf(mode, rules), tasks: {}, sessionHooks: new Map() }
  return {
    options: { tools: [], commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(),
    messages: [],
    readFileState: new Map(),
    getAppState: () => state,
    setAppState: () => undefined,
    setResponseLength: () => undefined,
    updateFileHistoryState: () => undefined,
    updateAttributionState: () => undefined,
  } as never
}

const ENV_WORDS = 'a .env file usually holds secrets'
const isEnvAsk = (decision: Decision): boolean =>
  decision.behavior === 'ask' &&
  decision.decisionReason?.type === 'safetyCheck' &&
  decision.decisionReason.operatorOnly === false &&
  (decision.message ?? '').includes(ENV_WORDS)

const readVerdict = (path: string, mode: Mode = 'default', rules: Rules = {}): Decision =>
  checkReadPermissionForTool(FileReadTool as never, { file_path: path }, permissionOf(mode, rules) as never) as unknown as Decision

section('§0 the name law: .env and .env.* are the row; the templates, .envrc and look-alikes are not')
{
  for (const name of ['.env', '.env.local', '.env.production', '.ENV', 'api/.env', 'C:\\proj\\.env', '/proj/.env.test', '.env.staging.local']) {
    check(`an env-file name: ${name}`, isProjectEnvFileName(name))
  }
  for (const name of ['.env.example', '.env.sample', '.env.template', '.env.production.example', '.env.example.local', '.envrc', 'env', 'env/config.ts', 'environment.ts', 'notes.txt', 'foo.env', 'production.env', '']) {
    check(`not this row: ${name === '' ? '(empty)' : name}`, !isProjectEnvFileName(name))
  }
  const targets = (glob: string): string => j(envFileTargetsInGlob(glob))
  check('a glob naming the file: .env → [.env]', targets('.env') === j(['.env']), targets('.env'))
  check('an anchored spelling names the same file: /.env and ./.env → [.env]', targets('/.env') === j(['.env']) && targets('./.env') === j(['.env']), targets('/.env'))
  check('a glob naming the file under a folder keeps the folder: api/.env → [api/.env]', targets('api/.env') === j(['api/.env']), targets('api/.env'))
  check('a glob naming the family: .env* → the file and a sibling no single-file rule covers', targets('.env*') === j(['.env', '.env.__wildcard__']), targets('.env*'))
  check('a glob naming the siblings: .env.* → the sibling alone', targets('.env.*') === j(['.env.__wildcard__']), targets('.env.*'))
  check('a brace glob names the siblings: .env.{local,production}', targets('.env.{local,production}') === j(['.env.__wildcard__']), targets('.env.{local,production}'))
  check('a folder wildcard reaches every folder: **/.env → the root file and a sibling under any folder', targets('**/.env') === j(['.env', '__wildcard__/.env']), targets('**/.env'))
  check('a folder wildcard below the root: src/*/.env → a sibling under any folder, never the root file', targets('src/*/.env') === j(['src/__wildcard__/.env']), targets('src/*/.env'))
  check('a glob naming one sibling: .env.local → [.env.local]', targets('.env.local') === j(['.env.local']), targets('.env.local'))
  check('a sibling with a wildcard tail: .env.local* → the file and the wider siblings', targets('.env.local*') === j(['.env.local', '.env.local__wildcard__']), targets('.env.local*'))
  check('a wildcard that cannot spell the file itself: .env*rc → the siblings alone', targets('.env*rc') === j(['.env.__wildcard__']), targets('.env*rc'))
  check('every synthetic sibling is an env-file name by the name law', ['.env.__wildcard__', '__wildcard__/.env', '.env.local__wildcard__'].every(isProjectEnvFileName))
  check('an exclusion is not a target: !.env, !.env*', targets('!.env') === j([]) && targets('!.env*') === j([]), targets('!.env*'))
  check('a template glob is not a target: .env.example, .env.example*', targets('.env.example') === j([]) && targets('.env.example*') === j([]), targets('.env.example*'))
  check('an ordinary glob is not a target: *.ts', targets('*.ts') === j([]), targets('*.ts'))
  check('a glob that only happens to match (*.env) is not a named target — its hits are withheld instead', targets('*.env') === j([]), targets('*.env'))
}

section('§1 the file tools: Read of the project .env asks with the reason in default and implement; the look-alikes never ask')
{
  for (const mode of ['default', 'implement', 'apollo'] as Mode[]) {
    const verdict = readVerdict(join(PROJ, '.env'), mode)
    check(`${mode}: Read .env asks with the .env reason`, isEnvAsk(verdict), j(verdict))
  }
  check('the ask names the file', (readVerdict(join(PROJ, '.env')).message ?? '').startsWith(`Reading ${join(PROJ, '.env')} needs approval`), readVerdict(join(PROJ, '.env')).message)
  check('the ask carries no suggestion that would widen to the folder', !('suggestions' in readVerdict(join(PROJ, '.env'))))
  for (const relative of ['.env.local', '.env.production', 'api/.env']) {
    check(`Read ${relative} asks`, isEnvAsk(readVerdict(join(PROJ, relative))), j(readVerdict(join(PROJ, relative))))
  }
  check('a relative spelling asks the same', isEnvAsk(readVerdict('.env')), j(readVerdict('.env')))
  check('a ./ spelling asks the same', isEnvAsk(readVerdict('./.env')), j(readVerdict('./.env')))
  check('a symlink to .env asks (the real target decides)', isEnvAsk(readVerdict(join(PROJ, 'link-to-env'))), j(readVerdict(join(PROJ, 'link-to-env'))))
  check('.env through a symlinked folder asks', isEnvAsk(readVerdict(join(PROJ, 'linkdir', '.env'))), j(readVerdict(join(PROJ, 'linkdir', '.env'))))
  check('a traversal spelling that lands on .env asks', isEnvAsk(readVerdict(join(PROJ, 'api', '..', '.env'))), j(readVerdict(join(PROJ, 'api', '..', '.env'))))
  for (const relative of ['.env.example', '.env.sample', '.env.template', '.env.production.example', '.envrc', 'env/config.ts', 'environment.ts', 'notes.txt']) {
    const verdict = readVerdict(join(PROJ, relative))
    check(`refusal: Read ${relative} never asks (allowed as today)`, verdict.behavior === 'allow' && verdict.decisionReason?.type === 'mode', j(verdict))
  }
  const outside = readVerdict(join(OUTSIDE, '.env'))
  check('a .env outside the project keeps its own road (the outside-folder ask, not this row)', outside.behavior === 'ask' && outside.decisionReason?.type === 'workingDir', j(outside))
  const outsideNotes = readVerdict(join(OUTSIDE, 'notes.txt'))
  check('control: an outside ordinary file asks as before', outsideNotes.behavior === 'ask' && outsideNotes.decisionReason?.type === 'workingDir', j(outsideNotes))
}

section('§2 rules: the user\'s own allow rule is honoured; a deny rule still refuses')
{
  const byFile = readVerdict(join(PROJ, '.env'), 'default', { allow: ['Read(.env)'] })
  check('an allow rule for the file reads it without a card', byFile.behavior === 'allow', j(byFile))
  const byFolder = readVerdict(join(PROJ, '.env'), 'default', { allow: [`Read(//${PROJ.replace(/^\/+/, '')}/**)`] })
  check('an allow rule for the whole project folder reads it without a card', byFolder.behavior === 'allow', j(byFolder))
  const byEdit = readVerdict(join(PROJ, '.env'), 'default', { allow: ['Edit(.env)'] })
  check('an edit allow rule for the file counts as the user\'s own grant (edit implies read)', byEdit.behavior === 'allow', j(byEdit))
  const sibling = readVerdict(join(PROJ, '.env.local'), 'default', { allow: ['Read(.env)'] })
  check('the rule for .env does not cover .env.local', isEnvAsk(sibling), j(sibling))
  const denied = readVerdict(join(PROJ, '.env'), 'default', { deny: ['Read(.env)'] })
  check('a deny rule refuses before the ask', denied.behavior === 'deny' && denied.decisionReason?.type === 'rule', j(denied))
  const askRule = readVerdict(join(PROJ, '.env'), 'default', { ask: ['Read(.env)'] })
  check('an ask rule keeps its own sentence (the rule road comes first)', askRule.behavior === 'ask' && askRule.decisionReason?.type === 'rule', j(askRule))
}

section('§3 the engine: default and implement ask at the safety road; sovereign runs it; a deny rule refuses under sovereign too')
{
  const decide = (tool: unknown, input: Record<string, unknown>, mode: Mode, rules: Rules = {}): Promise<Outcome> =>
    decideToolPermission(tool as never, input, contextOf(mode, rules)) as unknown as Promise<Outcome>
  const input = { file_path: join(PROJ, '.env') }
  for (const mode of ['default', 'implement'] as Mode[]) {
    const out = await decide(FileReadTool, input, mode)
    check(`${mode}: the engine asks at safetyCheckAsk`, out.decision.behavior === 'ask' && out.trace.decidedBy === 'safetyCheckAsk' && isEnvAsk(out.decision), j(out))
  }
  const under = await decide(FileReadTool, input, 'sovereign')
  check('sovereign: allowed at the safety road, the stood-down ask named in the reason (never a card)', under.decision.behavior === 'allow' && under.trace.decidedBy === 'safetyCheckAsk' && under.decision.decisionReason?.type === 'bypassedAsk' && under.decision.decisionReason.road === 'safetyCheckAsk', j(under))
  const deniedUnder = await decide(FileReadTool, input, 'sovereign', { deny: ['Read(.env)'] })
  check('sovereign + deny rule: refused (a refusal is not a card)', deniedUnder.decision.behavior === 'deny' && deniedUnder.trace.decidedBy === 'toolVerdictDeny', j(deniedUnder))
  const control = await decide(FileReadTool, { file_path: join(PROJ, 'notes.txt') }, 'default')
  check('control: an ordinary read is allowed by the mode as before', control.decision.behavior === 'allow' && control.trace.decidedBy === 'resolution', j(control))
  const globList = await decide(GlobTool, { pattern: '.env*', path: PROJ }, 'default')
  check('Glob listing .env names is not a read of them (allowed as before)', globList.decision.behavior === 'allow', j(globList))
}

section('§4 the Grep tool: a search that names .env asks first; a folder-wide search withholds the .env lines and says so; sovereign and the user\'s rule see them')
{
  const grepVerdict = (input: Record<string, unknown>, mode: Mode = 'default', rules: Rules = {}): Promise<Decision> =>
    GrepTool.checkPermissions(GrepTool.inputSchema.parse(input) as never, contextOf(mode, rules)) as unknown as Promise<Decision>
  check('Grep with path .env asks', isEnvAsk(await grepVerdict({ pattern: 'API', path: join(PROJ, '.env') })), j(await grepVerdict({ pattern: 'API', path: join(PROJ, '.env') })))
  for (const glob of ['.env', '**/.env', '.env*', '.env.*', '.env.local', '*.ts .env']) {
    check(`Grep with glob ${j(glob)} asks`, isEnvAsk(await grepVerdict({ pattern: 'API', path: PROJ, glob })), j(await grepVerdict({ pattern: 'API', path: PROJ, glob })))
  }
  for (const glob of ['*.ts', '!.env', '.env.example', '*.env']) {
    const verdict = await grepVerdict({ pattern: 'API', path: PROJ, glob })
    check(`refusal: Grep with glob ${j(glob)} does not ask (its .env hits are withheld instead)`, verdict.behavior === 'allow', j(verdict))
  }
  const deniedGlob = await grepVerdict({ pattern: 'API', path: PROJ, glob: '.env' }, 'default', { deny: ['Read(.env)'] })
  check('Grep with glob .env under a deny rule is refused by the rule', deniedGlob.behavior === 'deny', j(deniedGlob))
  const allowedGlob = await grepVerdict({ pattern: 'API', path: PROJ, glob: '.env' }, 'default', { allow: ['Read(.env)'] })
  check('Grep with glob .env under the user\'s allow rule runs', allowedGlob.behavior === 'allow', j(allowedGlob))

  const narrow: Rules = { allow: ['Read(.env)'] }
  const rootOnly: Rules = { allow: [`Read(//${PROJ.replace(/^\/+/, '')}/.env)`] }
  for (const glob of ['.env*', '.env.*', '.env .env.local', '.env,.env.local', '.env.{local,production}', '*.ts .env.local', '**/.env*']) {
    const verdict = await grepVerdict({ pattern: 'API', path: PROJ, glob }, 'default', narrow)
    check(`the rule for .env does not cover glob ${j(glob)}: it asks`, isEnvAsk(verdict) && !(verdict.message ?? '').includes('__wildcard__'), j(verdict))
  }
  const family = await grepVerdict({ pattern: 'API', path: PROJ, glob: '.env*' }, 'default', narrow)
  check('the ask for .env* under the rule names the siblings as a family', (family.message ?? '').startsWith(`Reading ${join(PROJ, '.env.*')} needs approval`), family.message)
  const second = await grepVerdict({ pattern: 'API', path: PROJ, glob: '.env .env.local' }, 'default', narrow)
  check('the ask for ".env .env.local" under the rule names the second file', (second.message ?? '').startsWith(`Reading ${join(PROJ, '.env.local')} needs approval`), second.message)
  const folder = await grepVerdict({ pattern: 'API', path: PROJ, glob: 'api/.env' }, 'default', rootOnly)
  check('a rule for the root .env alone does not cover api/.env: the ask names the file under its folder', isEnvAsk(folder) && (folder.message ?? '').startsWith(`Reading ${join(PROJ, 'api', '.env')} needs approval`), j(folder))
  const rootGlob = await grepVerdict({ pattern: 'API', path: PROJ, glob: '/.env' }, 'default', rootOnly)
  check('control: the root rule covers the anchored glob /.env', rootGlob.behavior === 'allow', j(rootGlob))
  const familyRule = await grepVerdict({ pattern: 'API', path: PROJ, glob: '.env*' }, 'default', { allow: ['Read(.env)', 'Read(.env.*)'] })
  check('the user\'s rule for the siblings beside the file lets .env* run', familyRule.behavior === 'allow', j(familyRule))
  const wideRule = await grepVerdict({ pattern: 'API', path: PROJ, glob: '.env* .env.{local,production}' }, 'default', { allow: ['Read(.env*)'] })
  check('the user\'s rule spelled as the family lets .env* run', wideRule.behavior === 'allow', j(wideRule))
  const folderRule = await grepVerdict({ pattern: 'API', path: PROJ, glob: '.env* **/.env src/*/.env' }, 'default', { allow: [`Read(//${PROJ.replace(/^\/+/, '')}/**)`] })
  check('a folder-wide rule covers every target', folderRule.behavior === 'allow', j(folderRule))
  const anchored = await grepVerdict({ pattern: 'API', path: PROJ, glob: '**/.env' }, 'default', { allow: [`Read(//${PROJ.replace(/^\/+/, '')}/.env)`] })
  check('a rule for the root .env alone does not cover **/.env (api/.env is in reach): it asks', isEnvAsk(anchored) && (anchored.message ?? '').startsWith(`Reading ${join(PROJ, '*', '.env')} needs approval`), j(anchored))
  const anywhere = await grepVerdict({ pattern: 'API', path: PROJ, glob: '**/.env' }, 'default', narrow)
  check('the rule Read(.env) covers .env in every folder, so **/.env runs', anywhere.behavior === 'allow', j(anywhere))
  const denyFamily = await grepVerdict({ pattern: 'API', path: PROJ, glob: '.env*' }, 'default', { deny: ['Read(.env.*)'] })
  check('a deny rule for the siblings refuses .env* before the ask for .env', denyFamily.behavior === 'deny' && denyFamily.decisionReason?.type === 'rule', j(denyFamily))
  const denySecond = await grepVerdict({ pattern: 'API', path: PROJ, glob: '.env .env.local' }, 'default', { deny: ['Read(.env.local)'] })
  check('a deny rule on the second token refuses before the first token asks', denySecond.behavior === 'deny' && denySecond.decisionReason?.type === 'rule', j(denySecond))
  const decideGrep = (input: Record<string, unknown>, mode: Mode, rules: Rules = {}): Promise<Outcome> =>
    decideToolPermission(GrepTool as never, input, contextOf(mode, rules)) as unknown as Promise<Outcome>
  const familyUnder = await decideGrep({ pattern: 'API', path: PROJ, glob: '.env*' }, 'sovereign', narrow)
  check('sovereign: the family ask stands down (never a card)', familyUnder.decision.behavior === 'allow' && familyUnder.decision.decisionReason?.type === 'bypassedAsk', j(familyUnder))
  const familyAsked = await decideGrep({ pattern: 'API', path: PROJ, glob: '.env*' }, 'implement', narrow)
  check('implement: the family ask reaches the engine as the safety road', familyAsked.decision.behavior === 'ask' && familyAsked.trace.decidedBy === 'safetyCheckAsk', j(familyAsked))

  const search = async (input: Record<string, unknown>, mode: Mode = 'default', rules: Rules = {}): Promise<string> => {
    const parsed = GrepTool.inputSchema.parse(input)
    const result = (await GrepTool.call(parsed as never, contextOf(mode, rules))) as { data: unknown }
    const block = GrepTool.mapToolResultToToolResultBlockParam(result.data as never, 'toolu_env') as { content: string }
    return block.content
  }
  const content = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'content' })
  check('content mode: the .env lines are withheld', !content.includes('sk-live-fixture') && !content.includes('sk-local-fixture') && !content.includes('sk-prod-fixture') && !content.includes('sk-api-fixture'), content)
  check('content mode: the template lines still show', content.includes('.env.example:1:API_KEY='), content)
  check('content mode: the ordinary files still show', content.includes('notes.txt:1:API_KEY') && content.includes('environment.ts:1:'), content)
  check('content mode: the note names every withheld file with its line count', /\(Withheld: .*— Mercury asks before reading a \.env file; search it by name \(path or glob\) to be asked\.\)/.test(content) && content.includes(' .env (1 line)') && content.includes('.env.local (1 line)') && content.includes('api/.env (1 line)') && content.includes('.env.production (1 line)'), content)
  const both = await search({ pattern: 'API_KEY|DB_URL', path: PROJ, output_mode: 'content' })
  check('content mode: a file with two withheld lines is counted as two', both.includes(' .env (2 lines)'), both)
  check('content mode: no NUL byte reaches the model', !content.includes('\0'), j(content))
  check('content mode: the .envrc line still shows (not this row)', content.includes('.envrc:1:export API_KEY'), content)

  const files = await search({ pattern: 'API_KEY', path: PROJ })
  check('files mode: the .env names are withheld from the list', !/^\.env$/m.test(files) && !/^\.env\.local$/m.test(files) && !/^api\/\.env$/m.test(files), files)
  check('files mode: the template and ordinary files are listed', /^\.env\.example$/m.test(files) && /^notes\.txt$/m.test(files), files)
  const filesNote = /\(Withheld: (.*) — Mercury asks before reading a \.env file; search it by name \(path or glob\) to be asked\.\)/.exec(files)
  const filesNamed = (filesNote?.[1] ?? '').split(', ').sort()
  check('files mode: the note names the withheld files', j(filesNamed) === j(['.env', '.env.local', '.env.production', 'api/.env']), files)

  const counts = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'count' })
  check('count mode: the .env counts are withheld and the totals exclude them', !/^\.env:/m.test(counts) && !/^api\/\.env:/m.test(counts) && /\.env\.example:1/.test(counts) && /\(Withheld: /.test(counts), counts)

  const context = await search({ pattern: 'DB_URL', path: PROJ, output_mode: 'content', '-C': 1, '-n': false })
  check('context lines without numbers keep today\'s shape (path:text and path-text) for the files that show', context.includes('.env.example-API_KEY=') && context.includes('.env.example:DB_URL=') && !/\.env\.example[:-]\d+[:-]/.test(context), context)
  check('context mode: the withheld group leaves no doubled or dangling separators', !/--\n--/.test(context) && !context.startsWith('--') && !/\n--\n\(/.test(context) && !/\n--$/.test(context), context)
  check('context mode: the .env line itself is withheld', !content.includes('postgres://') && !context.includes('postgres://'), context)
  const shownLines = (text: string): string[] =>
    text.split('\n').filter(line =>
      !line.startsWith('(Withheld:') && line !== '--' && !/^Found \d+ files?/.test(line) && !/^\d+ match(?:es)? across \d+ files?/.test(line) &&
      !isProjectEnvFileName(line.split(/[:-]/)[0] ?? '')).sort()
  for (const input of [
    { pattern: 'API_KEY', path: PROJ, output_mode: 'content' },
    { pattern: 'DB_URL', path: PROJ, output_mode: 'content', '-C': 1, '-n': false },
    { pattern: 'API_KEY', path: PROJ, output_mode: 'content', '-C': 1 },
    { pattern: 'API_KEY', path: PROJ, output_mode: 'count' },
    { pattern: 'API_KEY', path: PROJ },
  ]) {
    const today = shownLines(await search(input, 'sovereign'))
    const now = shownLines(await search(input, 'default'))
    check(`control: the withholding road prints every shown line byte for byte as today's road (${j(input.output_mode ?? 'files')}${input['-C'] ? ', context' : ''}${input['-n'] === false ? ', no numbers' : ''})`, j(today) === j(now), `today ${j(today)} vs now ${j(now)}`)
  }

  const under = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'content' }, 'sovereign')
  check('sovereign: the folder-wide search shows the .env lines with no note (the posture never asks, so nothing is withheld)', under.includes('.env:1:API_KEY=sk-live-fixture') && !under.includes('Withheld'), under)
  const allowed = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'content' }, 'default', { allow: ['Read(.env)'] })
  check('the user\'s allow rule for .env shows its lines; the siblings without a rule stay withheld and named', allowed.includes('.env:1:API_KEY=sk-live-fixture') && !allowed.includes('sk-local-fixture') && /Withheld: .*\.env\.local/.test(allowed) && !/Withheld: \.env \(/.test(allowed), allowed)
  const named = await search({ pattern: 'API_KEY', path: join(PROJ, '.env'), output_mode: 'content' })
  check('a search that named .env (and so was asked) shows it whole, with no note', named.includes('API_KEY=sk-live-fixture') && !named.includes('Withheld'), named)
  const namedGlob = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'content', glob: '.env' })
  check('a search whose glob named .env shows it, with no note', namedGlob.includes('.env:1:API_KEY=sk-live-fixture') && !namedGlob.includes('Withheld'), namedGlob)
  const plain = await search({ pattern: 'in-code', path: PROJ, output_mode: 'content' })
  check('control: a search with no .env hit carries no note', plain.includes('environment.ts:1:') && !plain.includes('Withheld'), plain)

  const control = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'content', glob: '/.env' }, 'default', narrow)
  check('control: the narrow rule with the anchored glob /.env reads .env alone, with no note', control.includes('.env:1:API_KEY=sk-live-fixture') && !control.includes('sk-local-fixture') && !control.includes('sk-prod-fixture') && !control.includes('sk-api-fixture') && !control.includes('Withheld'), control)
  const anyDepth = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'content', glob: '.env' }, 'default', narrow)
  check('control: the rule Read(.env) and the glob .env both reach .env in every folder, so api/.env shows too, with no note', anyDepth.includes('.env:1:API_KEY=sk-live-fixture') && anyDepth.includes('api/.env:1:') && !anyDepth.includes('sk-local-fixture') && !anyDepth.includes('Withheld'), anyDepth)
  const beside = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'content', glob: '* .env' }, 'default', narrow)
  check('a glob naming .env beside a catch-all shows .env and withholds the siblings the catch-all reached, naming them', beside.includes('.env:1:API_KEY=sk-live-fixture') && !beside.includes('sk-local-fixture') && !beside.includes('sk-prod-fixture') && /Withheld: .*\.env\.local \(1 line\)/.test(beside) && /\.env\.production \(1 line\)/.test(beside) && !/Withheld: \.env \(/.test(beside) && !/Withheld: .*api\/\.env/.test(beside), beside)
  const besideFiles = await search({ pattern: 'API_KEY', path: PROJ, glob: '* .env' }, 'default', narrow)
  check('files mode: the same search lists .env and names the withheld siblings', /^\.env$/m.test(besideFiles) && !/^\.env\.local$/m.test(besideFiles) && /Withheld: .*\.env\.local/.test(besideFiles), besideFiles)
  const familyShown = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'content', glob: '.env*' }, 'default', narrow)
  check('a search whose glob named the family (and so was asked for it) shows every sibling, with no note', familyShown.includes('sk-live-fixture') && familyShown.includes('sk-local-fixture') && familyShown.includes('sk-prod-fixture') && familyShown.includes('api/.env:1:') && !familyShown.includes('Withheld'), familyShown)
  const twoNamed = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'content', glob: '.env .env.local' }, 'default', narrow)
  check('a search naming two files shows the two and nothing else, with no note', twoNamed.includes('sk-live-fixture') && twoNamed.includes('sk-local-fixture') && !twoNamed.includes('sk-prod-fixture') && !twoNamed.includes('Withheld'), twoNamed)
  const braces = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'content', glob: '.env.{local,production}' }, 'default', narrow)
  check('a brace glob shows the siblings it names, with no note', braces.includes('sk-local-fixture') && braces.includes('sk-prod-fixture') && !braces.includes('sk-live-fixture') && !braces.includes('Withheld'), braces)
  const nested = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'content', glob: '**/.env' }, 'default', narrow)
  check('**/.env shows the root file and api/.env, with no note', nested.includes('.env:1:API_KEY=sk-live-fixture') && nested.includes('api/.env:1:') && !nested.includes('sk-local-fixture') && !nested.includes('Withheld'), nested)
  const counted = await search({ pattern: 'API_KEY', path: PROJ, output_mode: 'count', glob: '* .env' }, 'default', narrow)
  check('count mode: the named .env is counted, the siblings withheld and named', /^\.env:1$/m.test(counted) && !/^\.env\.local:/m.test(counted) && /Withheld: .*\.env\.local/.test(counted), counted)
  check('the synthetic sibling never reaches a result', ![control, beside, besideFiles, familyShown, twoNamed, braces, nested, counted].some(text => text.includes('__wildcard__')))
}

section('§5 the Bash road: a command that cats, pipes, sources or copies the project .env asks the same way; the look-alikes and the metadata commands do not')
{
  const bashPath = async (command: string, mode: Mode = 'default', rules: Rules = {}): Promise<Decision> =>
    (await checkParsedPaths({ command }, PROJ, permissionOf(mode, rules) as never)) as unknown as Decision
  const asks = [
    'cat .env', 'cat ./.env', `cat ${join(PROJ, '.env')}`, 'cat api/.env', 'cat link-to-env', 'cat linkdir/.env', 'cat api/../.env',
    'head -n 3 .env', 'tail .env', 'grep API .env', 'rg API .env', "awk '{print}' .env", 'sed -n p .env', 'cut -d= -f2 .env', 'sort .env',
    'base64 .env', 'strings .env', 'nl .env', 'od -c .env', 'hexdump .env', 'diff .env .env.example', 'cat .env.local', 'cat .env.production',
    'cat < .env', 'source .env', '. .env', '. ./.env', 'source api/.env',
    'rg -g .env API', 'rg --glob .env API', "rg -g '**/.env' API", 'grep -r --include=.env API .', 'grep -r --include .env API .', "rg --glob=.env* API",
  ]
  for (const mode of ['default', 'implement'] as Mode[]) {
    for (const command of asks) {
      const verdict = await bashPath(command, mode)
      check(`${mode}: ${command} asks with the .env reason`, isEnvAsk(verdict), j(verdict))
    }
  }
  for (const command of ['cp .env copy.txt', 'mv .env renamed.txt', 'cp api/.env copy.txt']) {
    const verdict = await bashPath(command, 'implement')
    check(`implement: ${command} asks (a copy is a read in disguise)`, isEnvAsk(verdict), j(verdict))
  }
  const never = [
    'cat .env.example', 'cat .env.sample', 'cat .env.template', 'cat .env.production.example', 'cat .envrc', 'cat environment.ts', 'cat env/config.ts', 'cat notes.txt',
    'ls -la .env', 'stat .env', 'wc -l .env', 'file .env', 'sha256sum .env', 'find . -name .env', 'rg API', 'grep -r API .', "rg -g '!.env' API", 'grep -r --include=*.ts API .',
    'source setup.sh', '. setup.sh', 'cat < notes.txt', 'head notes.txt',
  ]
  for (const command of never) {
    const verdict = await bashPath(command)
    check(`refusal: ${command} does not ask for this row (passthrough as today)`, verdict.behavior === 'passthrough', j(verdict))
  }
  for (const command of ['cp notes.txt copy.txt', 'mv notes.txt renamed.txt']) {
    const verdict = await bashPath(command, 'implement')
    check(`control: implement ${command} passes through as today`, verdict.behavior === 'passthrough', j(verdict))
  }
  const denied = await bashPath('cat .env', 'default', { deny: ['Read(.env)'] })
  check('a deny rule refuses cat .env', denied.behavior === 'deny' && denied.decisionReason?.type === 'rule', j(denied))
  const deniedSource = await bashPath('source .env', 'default', { deny: ['Read(.env)'] })
  check('a deny rule refuses source .env', deniedSource.behavior === 'deny' && deniedSource.decisionReason?.type === 'rule', j(deniedSource))
  const allowedCat = await bashPath('cat .env', 'default', { allow: ['Read(.env)'] })
  check('the user\'s allow rule lets cat .env pass', allowedCat.behavior === 'passthrough', j(allowedCat))
  const outsideCat = await bashPath(`cat ${join(OUTSIDE, '.env')}`)
  check('a .env outside the project keeps the outside-folder ask', outsideCat.behavior === 'ask' && !isEnvAsk(outsideCat) && (outsideCat.message ?? '').includes('outside the starting folder'), j(outsideCat))

  const narrow: Rules = { allow: ['Read(.env)'] }
  for (const command of ["rg -g '.env*' API", "rg --glob='.env.*' API", 'rg -g .env -g .env.local API', "grep -r --include='.env*' API .", "rg -g '**/.env*' API"]) {
    const verdict = await bashPath(command, 'default', narrow)
    check(`the rule for .env does not cover ${command}: it asks`, isEnvAsk(verdict) && !(verdict.message ?? '').includes('__wildcard__'), j(verdict))
  }
  const folderRg = await bashPath('rg -g api/.env API', 'default', { allow: [`Read(//${PROJ.replace(/^\/+/, '')}/.env)`] })
  check('a rule for the root .env alone does not cover rg -g api/.env: it asks for the file under its folder', isEnvAsk(folderRg) && (folderRg.message ?? '').startsWith(`Reading ${join(PROJ, 'api', '.env')} needs approval`), j(folderRg))
  const familyRg = await bashPath("rg -g '.env*' API", 'default', narrow)
  check('the ask for rg -g .env* under the rule names the siblings as a family', (familyRg.message ?? '').startsWith(`Reading ${join(PROJ, '.env.*')} needs approval`), familyRg.message)
  const secondRg = await bashPath('rg -g .env -g .env.local API', 'default', narrow)
  check('the ask for the second -g value names its file', (secondRg.message ?? '').startsWith(`Reading ${join(PROJ, '.env.local')} needs approval`), secondRg.message)
  const controlRg = await bashPath('rg -g .env API', 'default', narrow)
  check('control: the narrow rule lets rg -g .env pass (it reads .env alone)', controlRg.behavior === 'passthrough', j(controlRg))
  const familyRuleRg = await bashPath("rg -g '.env*' API", 'default', { allow: ['Read(.env)', 'Read(.env.*)'] })
  check('the user\'s rule for the siblings beside the file lets rg -g .env* pass', familyRuleRg.behavior === 'passthrough', j(familyRuleRg))
  const denyFamilyRg = await bashPath("rg -g '.env*' API", 'default', { allow: ['Read(.env)'], deny: ['Read(.env.*)'] })
  check('a deny rule for the siblings refuses rg -g .env*', denyFamilyRg.behavior === 'deny' && denyFamilyRg.decisionReason?.type === 'rule', j(denyFamilyRg))

  const whole = async (command: string, mode: Mode = 'default', rules: Rules = {}): Promise<Decision> =>
    (await bashToolHasPermission({ command } as never, permissionOf(mode, rules) as never)) as unknown as Decision
  check('the whole Bash decision for cat .env is the .env ask', isEnvAsk(await whole('cat .env')), j(await whole('cat .env')))
  check('the whole Bash decision for a compound with cat .env asks', (await whole('cat .env && echo done')).behavior === 'ask', j(await whole('cat .env && echo done')))
  check('cat .env* (a wildcard) is not run unproven', (await whole('cat .env*')).behavior !== 'allow', j(await whole('cat .env*')))
  check('the whole Bash decision for cat notes.txt is the read-only allow as before', (await whole('cat notes.txt')).behavior === 'allow', j(await whole('cat notes.txt')))
  const decide = (input: Record<string, unknown>, mode: Mode, rules: Rules = {}): Promise<Outcome> =>
    decideToolPermission(BashTool as never, input, contextOf(mode, rules)) as unknown as Promise<Outcome>
  const asked = await decide({ command: 'cat .env' }, 'default')
  check('through the engine in default: cat .env asks at the safety road', asked.decision.behavior === 'ask' && asked.trace.decidedBy === 'safetyCheckAsk', j(asked))
  const ran = await decide({ command: 'cat .env' }, 'sovereign')
  check('through the engine in sovereign: cat .env runs (the ask stands down, named in the reason)', ran.decision.behavior === 'allow' && ran.decision.decisionReason?.type === 'bypassedAsk', j(ran))
  const refused = await decide({ command: 'cat .env' }, 'sovereign', { deny: ['Read(.env)'] })
  check('through the engine in sovereign with a deny rule: cat .env is refused', refused.decision.behavior === 'deny', j(refused))
}

section('§6 the Windows twin: the PowerShell content cmdlets ask for the project .env; the metadata cmdlets and the templates do not')
{
  const parsed = (name: string, args: string[]) => ({
    valid: true,
    statements: [{ statementType: 'PipelineAst', text: [name, ...args].join(' '), commands: [{ name, text: [name, ...args].join(' '), nameType: 'cmdlet' as const, args, elementType: 'CommandAst' }], nestedCommands: [], redirections: [] }],
    variables: [],
    errors: [],
    hasStopParsing: false,
    originalCommand: [name, ...args].join(' '),
  })
  const psPath = (name: string, args: string[], mode: Mode = 'default', rules: Rules = {}): Decision =>
    powershell.checkPathConstraints({ command: [name, ...args].join(' ') }, parsed(name, args) as never, permissionOf(mode, rules) as never) as unknown as Decision
  for (const [name, args] of [['Get-Content', ['.env']], ['gc', ['.env']], ['cat', ['.env']], ['type', ['.env']], ['Get-Content', ['-Path', '.env']], ['Get-Content', ['api/.env']], ['Select-String', ['-Pattern', 'API', '-Path', '.env']], ['Format-Hex', ['.env']], ['Get-Content', ['.env.local']]] as Array<[string, string[]]>) {
    const verdict = psPath(name, args)
    check(`${[name, ...args].join(' ')} asks with the .env reason`, isEnvAsk(verdict), j(verdict))
  }
  for (const [name, args] of [['Copy-Item', ['.env', 'copy.txt']], ['Move-Item', ['.env', 'renamed.txt']]] as Array<[string, string[]]>) {
    const verdict = psPath(name, args, 'implement')
    check(`implement: ${[name, ...args].join(' ')} asks`, isEnvAsk(verdict), j(verdict))
  }
  for (const [name, args] of [['Get-Content', ['.env.example']], ['Get-Content', ['.envrc']], ['Get-Content', ['notes.txt']], ['Test-Path', ['.env']], ['Get-ChildItem', ['.env']], ['Get-Item', ['.env']], ['Resolve-Path', ['.env']], ['Get-FileHash', ['.env']]] as Array<[string, string[]]>) {
    const verdict = psPath(name, args)
    check(`refusal: ${[name, ...args].join(' ')} does not ask for this row`, verdict.behavior === 'passthrough', j(verdict))
  }
  const denied = psPath('Get-Content', ['.env'], 'default', { deny: ['Read(.env)'] })
  check('a deny rule refuses Get-Content .env', denied.behavior === 'deny', j(denied))
  const allowed = psPath('Get-Content', ['.env'], 'default', { allow: ['Read(.env)'] })
  check('the user\'s allow rule lets Get-Content .env pass', allowed.behavior === 'passthrough', j(allowed))
}

for (const dir of [HOME, PROJ, OUTSIDE]) rmSync(dir, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
