#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { makeTally, ROOT } from './team-world.ts'

const home = mkdtempSync(join(tmpdir(), 'saved-teams-convert-home-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_CREW_DIR
delete process.env.MERCURY_TEAMS_DIR

const tally = makeTally('prove-saved-teams-convert')
const COPY = process.env.CREW_BIRTH_TEAMS_COPY ?? '/private/tmp/mw/crew-birth-home/teams'
const teamsDir = join(home, 'teams')

function seedSyntheticTeams(dir: string): void {
  const write = (rel: string, value: unknown): void => {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2))
  }
  const member = (name: string, team: string, model: string | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    agentId: `${name}@${team}`,
    name,
    agentType: name === 'team-lead' ? 'team-lead' : 'mercury-general',
    ...(model !== undefined ? { model } : {}),
    joinedAt: 1700000000000,
    tmuxPaneId: name === 'team-lead' ? '' : 'in-process',
    cwd: '/repo',
    subscriptions: [],
    ...extra,
  })
  const row = (from: string, text: string, seq: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ from, text, timestamp: '2026-01-01T00:00:00.000Z', color: 'blue', read: false, id: `msg-${seq}@x`, seq, ...extra })
  write('alpha/config.json', { name: 'alpha', description: 'the first', createdAt: 1700000000000, leadAgentId: 'team-lead@alpha', leadSessionId: 'session-a', charter: { version: 1, teamName: 'alpha', objective: 'o', successCriteria: [], synthesisOwner: 'team-lead', createdAt: 1700000000000 }, members: [member('team-lead', 'alpha', 'claude-opus-5-5'), member('scout', 'alpha', 'claude-fable-5-1', { color: 'blue', backendType: 'in-process', isActive: false, prompt: 'go' }), member('astra', 'alpha', 'gpt-6-astra', { worktreePath: '/repo/.worktrees/astra' })] })
  write('alpha/handoffs.json', [{ id: 'handoff-1@team-lead', from: 'scout', to: 'team-lead', status: 'done', summary: 'done' }])
  write('alpha/inboxes/team-lead.json', [row('scout', 'hello lead', 1), row('astra', 'hello too', 2, { summary: 'hi' })])
  write('alpha/inboxes/scout.json', [row('team-lead', 'hello scout', 1)])
  write('alpha/questions.json', [{ request_id: 'q-1@scout', from: 'astra', to: 'scout', text: 'why?', askedAt: '2026-01-01T00:00:00.000Z' }])
  write('alpha/leases/leases.json', { leases: [], _v: 1 })
  write('beta/config.json', { name: 'beta', createdAt: 1700000000001, leadAgentId: 'team-lead@beta', leadSessionId: 'session-b', members: [member('team-lead', 'beta', 'gpt-6-astra')] })
  write('beta/inboxes/team-lead.json', [row('ping', 'pong', 1, { delivery: 'x' })])
  write('gamma/config.json', { name: 'gamma', createdAt: 1700000000002, leadAgentId: 'team-lead@gamma', members: [member('team-lead', 'gamma', undefined)] })
  write('delta/leases/leases.json', { leases: [], _v: 1 })
  write('epsilon/inboxes/worker.json', [row('team-lead', 'a note', 1)])
  mkdirSync(join(dir, '.journal'), { recursive: true })
  writeFileSync(join(dir, '.journal', 'op-1.json'), JSON.stringify({ schema: 1, kind: 'team-create', idempotencyKey: 'team-create:alpha', state: 'committed' }))
}

const fromCopy = existsSync(join(COPY, 'beta24', 'config.json'))
if (fromCopy) cpSync(COPY, teamsDir, { recursive: true })
else seedSyntheticTeams(teamsDir)
console.log(`  source: ${fromCopy ? `a fresh copy of the byte copy at ${COPY}` : 'the synthetic five-folder fixture (no byte copy on this box)'}`)

const filesOf = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesOf(path))
    else out.push(path)
  }
  return out
}
const digestOf = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const snapshot = (): Record<string, string> => Object.fromEntries(filesOf(teamsDir).map(path => [relative(teamsDir, path), digestOf(path)]))
const teamFolders = readdirSync(teamsDir).filter(name => !name.startsWith('.') && statSync(join(teamsDir, name)).isDirectory()).sort()
const readJson = <T,>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}
type Member = { name: string; model?: string; worktreePath?: string; cwd: string }
type Config = { name: string; members: Member[] }
const expected = Object.fromEntries(
  teamFolders.map(name => {
    const config = readJson<Config>(join(teamsDir, name, 'config.json'))
    const inboxDir = join(teamsDir, name, 'inboxes')
    const inboxRows = existsSync(inboxDir) ? readdirSync(inboxDir).filter(f => f.endsWith('.json')).reduce((n, f) => n + ((readJson<unknown[]>(join(inboxDir, f)) ?? []).length), 0) : 0
    const handoffs = (readJson<unknown[]>(join(teamsDir, name, 'handoffs.json')) ?? []).length
    const questions = (readJson<unknown[]>(join(teamsDir, name, 'questions.json')) ?? []).length
    return [name, { members: config?.members ?? [], inboxRows, handoffs, questions, leases: existsSync(join(teamsDir, name, 'leases', 'leases.json')) }]
  }),
)
const before = snapshot()

tally.section('§1 the converter: every saved team becomes a crew record; nothing is deleted or rewritten')
type Convert = typeof import('../../src/utils/crew/crewConvert.ts')
let convert: Convert | null = null
try {
  convert = await import('../../src/utils/crew/crewConvert.ts')
} catch (error) {
  tally.check('src/utils/crew/crewConvert.ts exists (the converter)', false, error instanceof Error ? error.message : String(error))
}
if (convert !== null) {
  const first = await convert.convertSavedTeams({ teamsDir })
  tally.check(`every folder of the teams home became a crew record (${teamFolders.length} folders)`, first.converted.length === teamFolders.length && first.converted.slice().sort().join(',') === teamFolders.join(','), JSON.stringify(first))
  const crews = await convert.listConvertedCrews()
  const byName = Object.fromEntries(crews.map(crew => [crew.name, crew]))
  tally.check('the crew store holds one record per saved team, named by the team', teamFolders.every(name => byName[name] !== undefined) && crews.length === teamFolders.length, JSON.stringify(Object.keys(byName)))
  for (const name of teamFolders) {
    const want = expected[name]!
    const crew = byName[name]
    if (crew === undefined) continue
    tally.check(`${name}: member count equal (${want.members.length})`, crew.members.length === want.members.length, `${crew.members.length}`)
    tally.check(`${name}: every model byte-exact as saved, absent stays absent`, want.members.every(m => crew.members.find(c => c.name === m.name)?.model === m.model), JSON.stringify(crew.members.map(c => [c.name, c.model])))
    tally.check(`${name}: every worktree and working folder carried`, want.members.every(m => crew.members.find(c => c.name === m.name)?.cwd === m.cwd && crew.members.find(c => c.name === m.name)?.worktree === m.worktreePath))
    tally.check(`${name}: the lead is the lead, every other member a crewmate, none live`, crew.members.every(c => (c.name === 'team-lead' ? c.kind === 'lead' : c.kind === 'crewmate') && c.state === 'stopped'))
    tally.check(`${name}: every inbox message kept as history (${want.inboxRows}), every handoff (${want.handoffs}), every question (${want.questions}), the leases (${String(want.leases)})`, crew.history.messages.length === want.inboxRows && crew.history.handoffs.length === want.handoffs && crew.history.questions.length === want.questions && (want.leases ? crew.history.leases !== null : crew.history.leases === null), JSON.stringify({ messages: crew.history.messages.length, handoffs: crew.history.handoffs.length, questions: crew.history.questions.length, leases: crew.history.leases !== null }))
    const sourceFiles = Object.keys(crew.source.files).sort()
    const folderFiles = Object.keys(before).filter(rel => rel.startsWith(`${name}/`)).map(rel => rel.slice(name.length + 1)).sort()
    tally.check(`${name}: the record names every source file with its checksum`, sourceFiles.join(',') === folderFiles.join(',') && folderFiles.every(rel => crew.source.files[rel] === before[`${name}/${rel}`]), `${sourceFiles.length} vs ${folderFiles.length}`)
  }
  const after = snapshot()
  tally.check('the originals are byte-exact after the conversion (every file, same checksum; nothing removed, nothing added)', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(Object.keys(after).filter(k => after[k] !== before[k])))
  const storePath = join(home, 'crew', 'crews.json')
  tally.check('the crew store lives under the crew store root of the config home', existsSync(storePath), storePath)
  const storeBytes = readFileSync(storePath, 'utf8')
  const second = await convert.convertSavedTeams({ teamsDir })
  tally.check('a second run converts nothing and changes nothing (idempotent)', second.converted.length === 0 && second.unchanged.length === teamFolders.length && readFileSync(storePath, 'utf8') === storeBytes, JSON.stringify(second))
  tally.check('the originals are still byte-exact after the second run', JSON.stringify(snapshot()) === JSON.stringify(before))
  const withJournal = readdirSync(teamsDir).includes('.journal')
  tally.check('the teams journal folder is not a crew and is left alone', !withJournal || (byName['.journal'] === undefined && existsSync(join(teamsDir, '.journal'))))
  const receipt = await convert.readConversionReceipt()
  tally.check('the receipt names the teams home it read and the crews it wrote', receipt !== null && receipt.teamsDir === teamsDir && receipt.crews.slice().sort().join(',') === teamFolders.join(','), JSON.stringify(receipt))
}

tally.section('§2 the drive: the built bundle carries the saved teams into the crew store at a session\'s birth')
if (existsSync(join(ROOT, 'dist', 'mercury.mjs'))) {
  const { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeWorld, TURN_MS } = await import('./team-world.ts')
  const world = await makeWorld('saved-teams-convert-drive', [{ kind: 'text', text: 'BORN-DONE', model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: 'BORN' } as never])
  cpSync(teamsDir, world.teams, { recursive: true })
  const driveBefore = Object.fromEntries(filesOf(world.teams).map(path => [relative(world.teams, path), digestOf(path)]))
  const session = bootLead(world, [], ['Agent'])
  try {
    session.submit('BORN: say the word.')
    await session.waitFor('the session never answered', () => session.stdout().includes('BORN-DONE'), TURN_MS)
    const storePath = join(world.config, 'crew', 'crews.json')
    const until = Date.now() + TURN_MS / 3
    while (!existsSync(storePath) && Date.now() < until) await new Promise(r => setTimeout(r, 100))
    const store = readJson<{ crews?: Record<string, { members: unknown[] }> }>(storePath)
    const names = Object.keys(store?.crews ?? {}).sort()
    tally.check('the built bundle wrote the crew store at the session\'s birth with every saved team', names.join(',') === teamFolders.join(','), `${storePath}: ${names.join(',') || '(absent)'}`)
    tally.check('the member counts match the saved teams', teamFolders.every(name => (store?.crews?.[name]?.members.length ?? -1) === expected[name]!.members.length), JSON.stringify(teamFolders.map(name => [name, store?.crews?.[name]?.members.length])))
    const driveAfter = Object.fromEntries(filesOf(world.teams).map(path => [relative(world.teams, path), digestOf(path)]))
    tally.check('the product left the saved teams byte-exact', JSON.stringify(driveAfter) === JSON.stringify(driveBefore))
    if (names.length === 0) console.log(`  drive stderr tail: ${session.stderr().slice(-600)}`)
    await session.end()
  } catch (error) {
    tally.check('the drive ran', false, error instanceof Error ? error.message : String(error))
    await session.terminate()
  } finally {
    await closeWorld(world)
  }
} else {
  console.log('  (no dist/mercury.mjs — the drive needs a build; the pure laws above stand)')
}

tally.section('§3 the boot road: the conversion runs once per process from the session\'s birth, never against a teammate session')
{
  const birth = existsSync(join(ROOT, 'src/utils/crew/crewBirth.ts')) ? readFileSync(join(ROOT, 'src/utils/crew/crewBirth.ts'), 'utf8') : ''
  tally.check('the birth arms the boot-time conversion (fire-and-forget, non-blocking)', birth.includes('bootCrewConversion()'))
  const converter = existsSync(join(ROOT, 'src/utils/crew/crewConvert.ts')) ? readFileSync(join(ROOT, 'src/utils/crew/crewConvert.ts'), 'utf8') : ''
  tally.check('the converter never writes into the teams home (no write, no rename, no removal under the teams dir)', converter !== '' && !/writeFile|rm\(|rmSync|unlink|rename\(/.test(converter))
  tally.check('the converter reads the teams home through the one resolver (MERCURY_TEAMS_DIR honoured)', converter.includes('getTeamsDir()'))
}
tally.finish()
