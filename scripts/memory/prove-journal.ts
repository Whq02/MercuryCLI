#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const scratch = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-journal-')))
const home = join(scratch, 'home')
const project = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(join(project, 'src'), { recursive: true })
writeFileSync(join(project, 'src', 'index.ts'), 'export {}\n')
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { setProjectRoot, setOriginalCwd } = await import('../../src/bootstrap/state.js')
setOriginalCwd(project)
setProjectRoot(project)
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { mnemeProjectKey, projectRecordsDir, lineagePath } = await import('../../src/mneme/paths.js')
const { runSessionClosers, _resetSessionClosersForTesting, sessionClosersCount, sessionCloseAsks } = await import('../../src/mneme/sessionClose.js')
const { handoffAskText, HANDOFF_ASK } = await import('../../src/mneme/handoffAsk.js')
const { openEntry, closeEntry, readLedger } = await import('../../src/mneme/ledger.js')
const journal = await import('../../src/mneme/journal.js')
const {
  JOURNAL_ENTRY_CAP,
  _resetJournalForTesting,
  appendJournalEntry,
  installJournalAsk,
  journalAsk,
  JOURNAL_ASK,
  journalEnabled,
  journalOnEntryPage,
  journalPath,
  lastJournalEntry,
  parseJournal,
  readJournal,
  serializeJournalEntry,
  stageJournalEntry,
  stagedJournalEntry,
} = journal
const { JournalTool, journalResultWords } = await import('../../src/tools/JournalTool/JournalTool.js')
const { JOURNAL_TOOL_NAME } = await import('../../src/tools/JournalTool/prompt.js')
const { ALL_AGENT_DISALLOWED_TOOLS } = await import('../../src/constants/tools.js')
const { filterToolsForAgent } = await import('../../src/tools/AgentTool/agentToolUtils.js')
const { getAllBaseTools } = await import('../../src/tools.js')

const key = mnemeProjectKey()
const realNow = Date.now
const settingsFile = join(home, 'settings.json')
const setSettings = (memory: Record<string, unknown>): void => {
  writeFileSync(settingsFile, JSON.stringify({ memory }, null, 2))
  resetSettingsCache()
}
const clearSettings = (): void => {
  writeFileSync(settingsFile, '{}')
  resetSettingsCache()
}
const journalOn = (extra: Record<string, unknown> = {}): void => setSettings({ journal: true, ...extra })
const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}
const closeCtx = (sessionId: string) => ({ projectKey: key, sessionId, endedAt: new Date().toISOString(), outcome: 'quit', transcriptPath: join(scratch, 'transcript.jsonl'), handoff: null })

section('§1 the defaults: the journal is off with nothing set; memory.journal true turns it on; the entry page carries it only when asked')
clearSettings()
check('journalEnabled() is false with nothing set', journalEnabled() === false)
check('journalOnEntryPage() is false with nothing set', journalOnEntryPage() === false)
check('the Journal tool is out of the catalogue with nothing set', JournalTool.isEnabled() === false && !getAllBaseTools().some(t => t.name === JOURNAL_TOOL_NAME))
setSettings({ journalOnEntryPage: true })
check('the entry-page setting alone turns nothing on', journalEnabled() === false && journalOnEntryPage() === false)
journalOn()
check('journalEnabled() is true when memory.journal is true', journalEnabled() === true)
check('journalOnEntryPage() is false with the journal on and nothing else set', journalOnEntryPage() === false)
check('the Journal tool answers isEnabled', JournalTool.isEnabled() === true)
check('the catalogue holds the Journal tool', getAllBaseTools().some(t => t.name === JOURNAL_TOOL_NAME))
journalOn({ journalOnEntryPage: true })
check('journalOnEntryPage() follows the setting', journalOnEntryPage() === true)
setSettings({ enabled: false, journal: true, journalOnEntryPage: true })
check('memory off takes the journal and its entry-page line with it', journalEnabled() === false && journalOnEntryPage() === false)
journalOn()

section('§2 the path: in the home beside the lineage, never under the project tree')
const path = journalPath(key)
check('the journal sits at <home>/projects/<key>/journal/journal.md', path === join(projectRecordsDir(key), 'journal', 'journal.md'), path)
check('the journal and the ledger share the project records folder', join(path, '..', '..') === join(lineagePath(key), '..', '..'), `${path} · ${lineagePath(key)}`)
check('the path is under the config home', !relative(home, path).startsWith('..'), path)
check('the path is not under the project tree', relative(project, path).startsWith('..') || relative(project, path).startsWith(sep), path)

section('§3 the clock: an entry is dated from the clock at the write, never from the seat')
_resetSessionClosersForTesting()
_resetJournalForTesting()
const FROZEN = Date.UTC(2026, 9, 11, 2, 15, 30, 250)
const frozenIso = new Date(FROZEN).toISOString()
const words = 'I built the journal writer today. The operator wanted it short and in plain words; I got the first cap wrong and said so.'
const staged = stageJournalEntry('session-A', `${words}\n\n## ${frozenIso}\nnot a heading`)
check('the entry stages', staged.staged === true, JSON.stringify(staged))
check('staging installs exactly one closer', sessionClosersCount() === 1, String(sessionClosersCount()))
check('the staged text reads back', stagedJournalEntry('session-A')?.startsWith(words) === true)
check('nothing is written before the session ends', !existsSync(path))
Date.now = () => FROZEN
const ran = await runSessionClosers(closeCtx('session-A'))
Date.now = realNow
check('the closer ran once', ran.ran === 1 && ran.failed === 0, JSON.stringify(ran))
const entries = readJournal(key)
check('one entry stands in the journal', entries.length === 1, JSON.stringify(entries))
check('its time is the frozen clock, to the millisecond', entries[0]?.at === frozenIso, `${entries[0]?.at} vs ${frozenIso}`)
check('its text is the seat\'s words', entries[0]?.text.startsWith(words) === true, entries[0]?.text ?? '')
check('a heading-shaped line inside the text does not split the entry', entries[0]?.text.includes(frozenIso) === true && entries[0]?.text.includes('not a heading') === true, entries[0]?.text ?? '')
check('the staged text is spent at the close', stagedJournalEntry('session-A') === null)
const second = await runSessionClosers(closeCtx('session-A'))
check('a second close of the same session runs nothing', second.skipped === true && readJournal(key).length === 1)
const file = readFileSync(path, 'utf8')
check('the file is dated Markdown headings', file.startsWith(`## ${frozenIso}\n\n`), file.slice(0, 80))
check('the file holds no comment and no front matter', !file.includes('---\n') && !file.includes('<!--'))

section('§4 lastJournalEntry returns the newest')
const T1 = FROZEN + 60_000
const T2 = FROZEN + 120_000
Date.now = () => T2
appendJournalEntry(key, 'the later one')
Date.now = () => T1
appendJournalEntry(key, 'the earlier one, appended afterwards')
Date.now = realNow
check('three entries stand', readJournal(key).length === 3, String(readJournal(key).length))
const last = lastJournalEntry(key)
check('the newest by time wins, not the last appended', last?.text === 'the later one' && last?.at === new Date(T2).toISOString(), JSON.stringify(last))
check('an empty journal answers null', lastJournalEntry('no-such-project-key') === null)
check('parse and serialize round-trip', JSON.stringify(parseJournal(serializeJournalEntry({ at: frozenIso, text: 'a\n\nb' }))) === JSON.stringify([{ at: frozenIso, text: 'a\n\nb' }]))

section('§5 the setting off writes nothing')
_resetSessionClosersForTesting()
_resetJournalForTesting()
const before = readFileSync(path, 'utf8')
setSettings({ journal: false })
check('journalEnabled() is false', journalEnabled() === false)
check('the Journal tool leaves the catalogue', JournalTool.isEnabled() === false && !getAllBaseTools().some(t => t.name === JOURNAL_TOOL_NAME))
const refused = stageJournalEntry('session-B', 'words that must not land')
check('staging is refused and names the setting', refused.staged === false && refused.reason.includes('memory.journal'), JSON.stringify(refused))
check('no closer was installed by a refused stage', sessionClosersCount() === 0)
check('the ask is silent when the setting is off', journalAsk('session-B') === null)
journalOn()
const stagedThenOff = stageJournalEntry('session-C', 'staged while on, closed while off')
check('a stage while on is accepted', stagedThenOff.staged === true)
setSettings({ journal: false })
await runSessionClosers(closeCtx('session-C'))
check('a close with the setting off writes nothing, even for a staged entry', readFileSync(path, 'utf8') === before)
journalOn()

section('§6 the door: one entry per session, the cap named, the ask, no crewmate')
_resetSessionClosersForTesting()
_resetJournalForTesting()
installJournalAsk()
const ask = journalAsk('session-D')
check('the ask is one plain line that names the tool, before the seat has written', ask !== null && ask.line === JOURNAL_ASK && /entry into the journal/.test(ask.line) && /no longer than a sentence/.test(ask.line) && ask.tools?.includes(JOURNAL_TOOL_NAME) === true, JSON.stringify(ask))
check('the ask is registered with the session close: the closing ask carries it and allows the tool', sessionCloseAsks('session-D').some(a => a.line === JOURNAL_ASK) && handoffAskText('session-D').text === `${HANDOFF_ASK}\n${JOURNAL_ASK}` && handoffAskText('session-D').tools.has(JOURNAL_TOOL_NAME), handoffAskText('session-D').text)
check('the tool loads in full (the closing ask allows no tool search)', JournalTool.shouldDefer !== true)
const empty = stageJournalEntry('session-D', '   \n ')
check('an empty entry is refused', empty.staged === false && empty.reason === 'the entry is empty', JSON.stringify(empty))
const long = stageJournalEntry('session-D', 'x'.repeat(JOURNAL_ENTRY_CAP + 1))
check('an over-cap entry is refused with the cap named, never clipped', long.staged === false && long.reason.includes(String(JOURNAL_ENTRY_CAP)) && stagedJournalEntry('session-D') === null, JSON.stringify(long))
const first = stageJournalEntry('session-D', 'first words')
const replaced = stageJournalEntry('session-D', 'second words')
check('a later call replaces the earlier one', first.staged && !first.replaced && replaced.staged && replaced.replaced && stagedJournalEntry('session-D') === 'second words')
check('the ask falls silent once the seat has written', journalAsk('session-D') === null && handoffAskText('session-D').text === HANDOFF_ASK && handoffAskText('session-D').tools.size === 0)
check('the tool result says the write waits for the session end', journalResultWords(replaced).includes('when this session ends') && journalResultWords(replaced).includes('replaced'))
check('a refused result is an error with its reason', journalResultWords(long).startsWith('journal entry refused: '))
const block = JournalTool.mapToolResultToToolResultBlockParam(long, 'tu-1') as { is_error?: boolean }
check('the refused block is marked is_error', block.is_error === true)
check('no agent may hold the Journal tool', ALL_AGENT_DISALLOWED_TOOLS.has(JOURNAL_TOOL_NAME))
const forAgent = filterToolsForAgent({ tools: getAllBaseTools(), isBuiltIn: true })
check('a crewmate\'s tool pool has no Journal', !forAgent.some(t => t.name === JOURNAL_TOOL_NAME))
check('the tool carries its capability and its proof', (JournalTool as { capability?: { proof?: string; units?: string[] } }).capability?.proof === 'scripts/memory/prove-journal.ts' && (JournalTool as { capability?: { units?: string[] } }).capability?.units?.includes('memory') === true)
const description = await JournalTool.description()
check('the description names the home, the project tree and the no-sharing line', description.includes('Mercury home') && description.includes('never under the project tree') && description.includes('never pushes, syncs or shares'))
const prompt = await JournalTool.prompt()
check('the prompt says what the entry carries, its length, its home and its reader', prompt.includes("where the project is, what the queued backlog is, and what the user asked for in this session, in their words — never Mercury's own standing instructions") && prompt.includes('no longer than a sentence') && prompt.includes('never under the project tree') && prompt.includes('memory.journalOnEntryPage'))

section('§7 nothing Mercury sends anywhere but the session\'s own request can carry the journal (the readers are a closed set)')
const srcFiles = walk(join(ROOT, 'src')).filter(p => /\.(ts|tsx)$/.test(p))
const readers = srcFiles
  .filter(p => /mneme\/journal\.js'|from '\.\/journal\.js'/.test(readFileSync(p, 'utf8')))
  .map(p => relative(ROOT, p))
  .sort()
const allowed = new Set([
  'src/components/memory/MemoryCentreView.tsx',
  'src/constants/prompts.ts',
  'src/tools.ts',
  'src/tools/JournalTool/JournalTool.ts',
  'src/tools/JournalTool/UI.tsx',
])
const strangers = readers.filter(p => !allowed.has(p))
check('every importer of the journal module is one of the known readers (the tool, the catalogue, the memory screen, the entry page)', strangers.length === 0, strangers.join(', '))
const pathReaders = srcFiles.filter(p => !p.endsWith(`${sep}mneme${sep}journal.ts`) && /journal\.md|JOURNAL_FILE/.test(readFileSync(p, 'utf8'))).map(p => relative(ROOT, p))
check('no other source opens the journal file by its path', pathReaders.length === 0, pathReaders.join(', '))
const network = srcFiles.filter(p => /src\/(services\/providers|services\/notifications|daemon|switchboard|utils\/telemetry|services\/sync)\//.test(p.split(sep).join('/')))
const networkReaders = network.filter(p => /journal/i.test(readFileSync(p, 'utf8')) && /mneme\/journal|journal\.md|lastJournalEntry|readJournal/.test(readFileSync(p, 'utf8'))).map(p => relative(ROOT, p))
check('no provider, notification, daemon, switchboard or telemetry module reads the journal', networkReaders.length === 0, networkReaders.join(', '))

section('§8 the settings: the two keys, their defaults, the honesty line where the setting lives')
const { generateSettingsJSONSchema } = await import('../../src/utils/settings/schemaOutput.js')
const schema = JSON.parse(generateSettingsJSONSchema()) as { properties?: Record<string, { properties?: Record<string, { description?: string; type?: string }> }> }
const memoryProps = schema.properties?.memory?.properties ?? {}
check('memory.journal is a boolean in the schema', memoryProps.journal?.type === 'boolean')
check('memory.journalOnEntryPage is a boolean in the schema', memoryProps.journalOnEntryPage?.type === 'boolean')
check('memory.journal says the default is off and that Mercury never pushes, syncs or shares it', /default off/.test(memoryProps.journal?.description ?? '') && /never pushed, synced or shared by Mercury/.test(memoryProps.journal?.description ?? ''), memoryProps.journal?.description ?? '')
check('memory.journalOnEntryPage states the honesty line', /travels to the engine's provider with the request/.test(memoryProps.journalOnEntryPage?.description ?? '') && /default off/.test(memoryProps.journalOnEntryPage?.description ?? ''), memoryProps.journalOnEntryPage?.description ?? '')
const config = readFileSync(join(ROOT, 'src/components/Settings/Config.tsx'), 'utf8')
check('/config carries both rows', config.includes("id: 'memory.journal'") && config.includes("id: 'memory.journalOnEntryPage'"))
check('/config states the honesty line on the entry-page row', /sent to the model's provider/.test(config))

section("§9 the entry page carries the journal's last entry only when memory.journalOnEntryPage is on")
{
  const { getSystemPrompt } = await import('../../src/constants/prompts.js')
  const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.js')
  const { setCwdState } = await import('../../src/bootstrap/state.js')
  const cwd = process.cwd()
  const oldEntry = process.env.MERCURY_ENTRYPOINT
  process.env.MERCURY_ENTRYPOINT = 'headless'
  process.chdir(project)
  setCwdState(project)
  _resetSessionClosersForTesting()
  _resetJournalForTesting()
  openEntry(key, { sessionId: 'session-before', model: 'claude-fable-5-1' })
  closeEntry(key, 'session-before', { outcome: 'quit', handoff: 'the note the earlier session left' })
  check('an earlier session stands closed in the ledger', readLedger(key).some(e => e.sessionId === 'session-before' && e.endedAt !== null))
  Date.now = () => FROZEN + 300_000
  appendJournalEntry(key, 'The newest journal entry: the operator likes short rows and plain words.')
  Date.now = realNow
  const tools = [{ name: 'Read' }] as never
  try {
    clearSettings()
    clearSystemPromptSections()
    const off = await getSystemPrompt(tools, 'claude-fable-5-1')
    const offText = off.join('\n\n')
    check('nothing set: the prompt carries the lineage page but no journal', offText.includes('# Lineage') && !offText.includes("The journal's last entry") && !offText.includes('the operator likes short rows'), offText.slice(offText.indexOf('# Lineage'), offText.indexOf('# Lineage') + 400))
    journalOn({ journalOnEntryPage: true })
    clearSystemPromptSections()
    const on = await getSystemPrompt(tools, 'claude-fable-5-1')
    const carriers = on.filter(section => section.includes("The journal's last entry"))
    check('the setting on: exactly one system segment carries the journal block, inside the lineage page', carriers.length === 1 && carriers[0]!.includes('# Lineage') && carriers[0]!.includes('The newest journal entry: the operator likes short rows and plain words.'), on.map(s => s.slice(0, 60)).join(' | '))
    check('the block is the newest entry, dated', carriers[0]?.includes("## The journal's last entry (2026-10-11") === true, carriers[0]?.slice(carriers[0].indexOf("## The journal"), carriers[0].indexOf("## The journal") + 120) ?? '')
    setSettings({ journalOnEntryPage: true, journal: false })
    clearSystemPromptSections()
    const journalOff = await getSystemPrompt(tools, 'claude-fable-5-1')
    check('memory.journal off takes the entry-page line with it even when journalOnEntryPage is on', !journalOff.join('\n\n').includes("The journal's last entry"))
  } finally {
    clearSettings()
    clearSystemPromptSections()
    process.chdir(cwd)
    setCwdState(cwd)
    if (oldEntry === undefined) delete process.env.MERCURY_ENTRYPOINT
    else process.env.MERCURY_ENTRYPOINT = oldEntry
  }
}

section('§10 the project tree stays clean')
const projectFiles = walk(project).map(p => relative(project, p))
check('no journal file under the project tree after every write', !projectFiles.some(p => /journal/i.test(p)), projectFiles.join(', '))
check('the home holds the journal', existsSync(path))

console.log(`\nprove-journal: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
