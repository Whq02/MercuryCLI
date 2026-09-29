#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, readJson, record, ROOT, sleep, toolResultOf, TURN_MS } from './team-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'crewmate-start-road-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const tally = makeTally('prove-crewmate-start-road')
const CREW = 'start-road'
const SEAT_ONE = 'folder-mate'
const SEAT_TWO = 'tree-mate'
const SEAT_MODEL = 'claude-opus-4-6'
const SEAT_GATE = 'opus-4-6'
const FIRST = 'START-ONE'
const SECOND = 'START-TWO'
const SPAWN_ONE = 'toolu_start_one'
const SPAWN_TWO = 'toolu_start_two'
const PWD_ONE = 'toolu_pwd_one'
const PWD_TWO = 'toolu_pwd_two'
const WORK_ONE = 'WORK-ONE: run pwd once and reply.'
const WORK_TWO = 'WORK-TWO: run pwd once and reply.'
const DONE_ONE = 'SEAT-ONE-DONE'
const DONE_TWO = 'SEAT-TWO-DONE'

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const initRepo = (dir: string): void => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'tree.txt'), 'one\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
}
const refusal = async (fn: () => unknown): Promise<string> => {
  try {
    await fn()
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
const firstLine = (text: string | undefined): string => (text ?? '').split('\n')[0]?.trim() ?? ''
const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
function agentFilesUnder(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) out.push(...agentFilesUnder(path, suffix))
    else if (entry.startsWith('agent-') && entry.endsWith(suffix)) out.push(path)
  }
  return out.sort()
}

tally.section('§1 the one road: a name, a working folder, an optional worktree, a model — every refusal typed')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'start-road-')))
const plain = join(scratch, 'plain')
mkdirSync(plain)
const repo = join(scratch, 'repo')
initRepo(repo)
const repoSub = join(repo, 'sub')
mkdirSync(repoSub)
type Road = typeof import('../../src/utils/crew/crewStart.ts')
let road: Road | null = null
try {
  road = await import('../../src/utils/crew/crewStart.ts')
} catch (error) {
  tally.check('the one start road exists (src/utils/crew/crewStart.ts)', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
}
if (road !== null) {
  const emptyModel = await refusal(() => road!.resolveCrewStart({ name: 'mate', cwd: plain, model: '' }))
  tally.check('an empty model is refused — nothing is picked by default, the operator names it', emptyModel.includes('model') && emptyModel.includes('operator'), emptyModel)
  const missing = await refusal(() => road!.resolveCrewStart({ name: 'mate', cwd: join(scratch, 'nowhere'), model: SEAT_MODEL }))
  tally.check('a working folder that does not exist is refused by name', missing.includes('nowhere') && missing.includes('exist'), missing)
  const relative = await refusal(() => road!.resolveCrewStart({ name: 'mate', cwd: 'plain', model: SEAT_MODEL }))
  tally.check('a relative working folder is refused (absolute only)', relative.includes('absolute'), relative)
  const badName = await refusal(() => road!.resolveCrewStart({ name: 'a@b', cwd: plain, model: SEAT_MODEL }))
  tally.check('a name SendMessage cannot address (an @) is refused', badName.includes('name'), badName)
  const noRepo = await refusal(() => road!.resolveCrewStart({ name: 'mate', cwd: plain, worktree: {}, model: SEAT_MODEL }))
  tally.check('a worktree asked of a folder that is no git repository is refused', noRepo.toLowerCase().includes('git repository'), noRepo)
  const folder = await road.resolveCrewStart({ name: 'mate', cwd: plain, model: SEAT_MODEL })
  tally.check('a folder start runs IN that folder: runDir is the folder, no worktree', folder.runDir === plain && folder.worktree === null && folder.cwd === plain, JSON.stringify(folder))
  tally.check('the plan carries the model byte-exact', folder.model === SEAT_MODEL, folder.model)
  const tree = await road.resolveCrewStart({ name: 'mate', cwd: repoSub, worktree: {}, model: SEAT_MODEL })
  tally.check("a worktree start cuts the worktree from the folder's repository", tree.worktree !== null && real(tree.worktree.gitRoot ?? '') === real(repo) && existsSync(join(tree.worktree.path, 'tree.txt')), JSON.stringify(tree))
  tally.check('…and the crewmate runs in the worktree (runDir), the folder kept as cwd', tree.worktree !== null && tree.runDir === tree.worktree.path && tree.cwd === repoSub, JSON.stringify(tree))
  const listed = tree.worktree === null ? '' : git(repo, 'worktree', 'list', '--porcelain')
  tally.check('the repository lists the cut worktree', tree.worktree !== null && listed.includes(`worktree ${real(tree.worktree.path)}`), listed)
}

tally.section('§2 the doors: the Agent tool with a name maps cwd, isolation and model onto the road; the daemon seat runs it')
{
  const tool = readFileSync(join(ROOT, 'src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  tally.check('the Agent tool no longer refuses cwd on a named spawn', !tool.includes('cwd applies to a sub-agent launch'), 'the refusal sentence is still in the source')
  const seat = readFileSync(join(ROOT, 'src/daemon/crewSpawn.ts'), 'utf8')
  tally.check('the daemon seat door runs the one road', seat.includes('resolveCrewStart('), 'crewSpawn.ts never calls resolveCrewStart')
  const spawn = readFileSync(join(ROOT, 'src/tools/shared/spawnMultiAgent.ts'), 'utf8')
  tally.check('the in-process crewmate door runs the one road', spawn.includes('resolveCrewStart('), 'spawnMultiAgent.ts never calls resolveCrewStart')
}

tally.section('§3 the drive: a named crewmate started with a cwd runs there; with a worktree it runs in the worktree cut from that folder; its model is the one named')
const hasTeamCreate = existsSync(join(ROOT, 'src/tools/TeamCreateTool'))
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn =>
  ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const world = await makeWorld('crewmate-start-road', [])
const folderOne = join(world.project, 'folder-one')
mkdirSync(folderOne)
const repoTwo = join(world.project, 'repo-two')
initRepo(repoTwo)
const script: ScriptedTurn[] = [
  ...(hasTeamCreate ? [lead({ kind: 'tool_use', id: 'toolu_start_team', name: 'TeamCreate', input: { team_name: CREW, description: 'the start-road team' } }, FIRST)] : []),
  lead({ kind: 'tool_use', id: SPAWN_ONE, name: 'Agent', input: { name: SEAT_ONE, team_name: CREW, model: SEAT_MODEL, cwd: folderOne, subagent_type: 'mercury-general', description: 'the folder mate', prompt: WORK_ONE } }, FIRST),
  lead({ kind: 'text', text: 'SPAWN-ONE-REPORTED' }, FIRST),
  { kind: 'tool_use', id: PWD_ONE, name: 'Bash', input: { command: 'pwd' }, whenModel: SEAT_GATE, whenBody: 'WORK-ONE' },
  { kind: 'text', text: DONE_ONE, whenModel: SEAT_GATE, whenBody: 'WORK-ONE' },
  lead({ kind: 'tool_use', id: SPAWN_TWO, name: 'Agent', input: { name: SEAT_TWO, team_name: CREW, model: SEAT_MODEL, cwd: repoTwo, isolation: 'worktree', subagent_type: 'mercury-general', description: 'the tree mate', prompt: WORK_TWO } }, SECOND),
  lead({ kind: 'text', text: 'SPAWN-TWO-REPORTED' }, SECOND),
  { kind: 'tool_use', id: PWD_TWO, name: 'Bash', input: { command: 'pwd' }, whenModel: SEAT_GATE, whenBody: 'WORK-TWO' },
  { kind: 'text', text: DONE_TWO, whenModel: SEAT_GATE, whenBody: 'WORK-TWO' },
]
await world.fixture.close()
world.fixture = await startFixtureApi(script)
world.env.ANTHROPIC_BASE_URL = world.fixture.url
const session = bootLead(world, [], ['Agent', 'SendMessage', 'Bash', ...(hasTeamCreate ? ['TeamCreate'] : [])])
const projects = join(world.config, 'projects')
try {
  session.submit(`${FIRST}: start the folder mate.`)
  await session.waitFor('the lead never reported the first spawn', () => session.stdout().includes('SPAWN-ONE-REPORTED'), TURN_MS)
  const spawnOne = toolResultOf(world, SPAWN_ONE)
  record('spawn-one-answer.txt', `${spawnOne?.text ?? ''}\nis_error=${String(spawnOne?.isError)}\n`)
  tally.check('the Agent tool started the named crewmate with its cwd (no refusal)', spawnOne !== null && !spawnOne.isError && /spawned/i.test(spawnOne.text), spawnOne?.text.slice(0, 200))
  const pwdSeen = Date.now() + TURN_MS / 2
  while (toolResultOf(world, PWD_ONE) === null && Date.now() < pwdSeen) await sleep(50)
  const pwdOne = toolResultOf(world, PWD_ONE)
  record('pwd-one.txt', `${pwdOne?.text ?? ''}\n`)
  tally.check("the crewmate's shell runs in the folder the start named", pwdOne !== null && real(firstLine(pwdOne.text)) === real(folderOne), `pwd read ${firstLine(pwdOne?.text)}, the folder is ${folderOne}`)
  const sidecarSeen = Date.now() + TURN_MS / 3
  while (agentFilesUnder(projects, '.meta.json').length < 1 && Date.now() < sidecarSeen) await sleep(50)
  const sidecars = agentFilesUnder(projects, '.meta.json').map(file => readJson<{ name?: string; model?: string }>(file))
  const sidecarOne = sidecars.find(row => row?.name === SEAT_ONE) ?? null
  tally.check('its record names the model byte-exact as the start named it', sidecarOne?.model === SEAT_MODEL, JSON.stringify(sidecars))
  const seatRequests = world.fixture.messageRequests().filter(request => String((request.body as { model?: string } | null)?.model ?? '') === SEAT_MODEL)
  tally.check("the crewmate's wire carries that exact model id", seatRequests.length >= 1, `${seatRequests.length} requests on ${SEAT_MODEL}`)

  session.submit(`${SECOND}: start the tree mate in a worktree.`)
  await session.waitFor('the lead never reported the second spawn', () => session.stdout().includes('SPAWN-TWO-REPORTED'), TURN_MS)
  const spawnTwo = toolResultOf(world, SPAWN_TWO)
  record('spawn-two-answer.txt', `${spawnTwo?.text ?? ''}\nis_error=${String(spawnTwo?.isError)}\n`)
  tally.check('the Agent tool started the named crewmate with a worktree (no refusal)', spawnTwo !== null && !spawnTwo.isError && /spawned/i.test(spawnTwo.text), spawnTwo?.text.slice(0, 200))
  const pwdTwoSeen = Date.now() + TURN_MS / 2
  while (toolResultOf(world, PWD_TWO) === null && Date.now() < pwdTwoSeen) await sleep(50)
  const pwdTwo = toolResultOf(world, PWD_TWO)
  record('pwd-two.txt', `${pwdTwo?.text ?? ''}\n`)
  const treeDir = firstLine(pwdTwo?.text)
  const treeRoot = treeDir === '' || !existsSync(treeDir) ? '' : (() => {
    try {
      return git(treeDir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    } catch {
      return ''
    }
  })()
  tally.check("the crewmate's shell runs in a worktree cut from the named folder's repository", treeDir !== '' && real(treeDir) !== real(repoTwo) && real(treeRoot) === real(join(repoTwo, '.git')) && existsSync(join(treeDir, 'tree.txt')), `pwd read ${treeDir}; its common dir ${treeRoot}; the repository is ${repoTwo}`)
  const worktrees = git(repoTwo, 'worktree', 'list', '--porcelain')
  tally.check('the repository lists that worktree', treeDir !== '' && worktrees.includes(`worktree ${real(treeDir)}`), worktrees)
} finally {
  await session.end()
  await closeWorld(world)
  rmSync(HOME, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
}
tally.finish()
