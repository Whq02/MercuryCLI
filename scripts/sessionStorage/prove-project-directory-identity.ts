#!/usr/bin/env bun
// gate-watch: src/utils/projectStoreIdentity.ts src/utils/directoryIdentity.ts src/utils/sessionStoragePortable.ts
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'project-identity-')))
const CASE_MOUNT = join(ROOT, 'case-sensitive')
const HOME = join(ROOT, 'home')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_HOME
const PORTABLE = join(import.meta.dir, '..', '..', 'src', 'utils', 'sessionStoragePortable.ts')
const portable = await import(PORTABLE)
const { getProjectDir, findProjectDir, projectSlug, projectSlugMatches, sanitizePath } = portable
const { listSessionsImpl } = await import('../../src/utils/listSessionsImpl.ts')
const facts = await import('../../src/utils/bootCardFacts.ts')
const tests = await import('../../src/services/ide/pythonTests.ts')
const PROJECTS = join(HOME, 'projects')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

function treeHash(root: string): string {
  const rows: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const st = statSync(path)
      if (st.isDirectory()) {
        rows.push(`d ${relative(root, path)}`)
        walk(path)
      } else {
        rows.push(`f ${relative(root, path)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`)
      }
    }
  }
  walk(root)
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

const inode = (path: string): string => String(statSync(path, { bigint: true }).ino)

let aliasCount = 0
function olderSpelling(path: string, casing: 'upper' | 'lower' = 'upper'): string {
  const variant = casing === 'upper' ? path.toUpperCase() : path.toLowerCase()
  try {
    if (variant !== path && inode(variant) === inode(path)) return variant
  } catch {
  }
  const alias = join(dirname(path), `${basename(variant)}-ALIAS-${aliasCount++}`)
  symlinkSync(path, alias, 'dir')
  return alias
}

function trySymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'dir')
    return true
  } catch {
    return false
  }
}

const UUID = (tail: string): string => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`
function transcriptLine(cwd: string, words: string): string {
  return `${JSON.stringify({ schemaVersion: 1, cwd, timestamp: new Date().toISOString(), payload: { kind: 'input', content: words } })}\n`
}
function seedStore(store: string, cwd: string, words = 'old words', sessionId = UUID('a111')): string {
  mkdirSync(store, { recursive: true })
  const file = join(store, `${sessionId}.jsonl`)
  writeFileSync(file, transcriptLine(cwd, words))
  return file
}
function seedCard(store: string, dir: string): void {
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'project.json'), `${JSON.stringify({ schema: 1, dir, firstChatAt: 1, firstSessionId: UUID('c0de') })}\n`)
}
const sessionIds = async (dir: string): Promise<string[]> => (await listSessionsImpl({ dir })).map(row => row.sessionId).sort()

const childCode = `const { getProjectDir } = await import(${JSON.stringify(PORTABLE)}); for (const dir of process.argv.slice(1)) console.log(getProjectDir(dir))`
function childAnswers(...dirs: string[]): string[] {
  const run = spawnSync(process.execPath, ['-e', childCode, ...dirs], { env: process.env, encoding: 'utf8' })
  if (run.status !== 0) return [`exit ${run.status}: ${run.stderr}`]
  return run.stdout.trim().split('\n')
}

function runRecord(cwd: string, id: string): import('../../src/services/ide/pythonTests.ts').TestRunRecord {
  return { schema: 1, id, framework: 'unittest', selection: 'all', command: ['python3', '-m', 'unittest'], cwd, interpreter: 'python3', startedAt: 1, durationMs: 1, counts: { passed: 1, failed: 0, skipped: 0, errored: 0 }, cases: [], failures: [], outputTail: [], exitCode: 0 }
}

try {
  section('A — two spellings of one directory read one store, and the reads write nothing (RED on the base: the newer spelling keys its own empty store)')
  const project = join(ROOT, 'MixedCaseProject')
  mkdirSync(project)
  const older = olderSpelling(project)
  check('A0 fixture: the two spellings name one native directory', older !== project && inode(older) === inode(project), `${older} vs ${project}`)
  const olderStore = join(PROJECTS, projectSlug(older))
  seedStore(olderStore, older)
  check('A0 fixture: the older store is keyed by the older spelling alone (its name is not the native slug)', basename(olderStore) !== projectSlug(project))
  const homeBefore = treeHash(HOME)
  check('A1 the native spelling resolves to the older spelling\'s store', getProjectDir(project) === olderStore, getProjectDir(project))
  check('A1 the older spelling resolves there too', getProjectDir(older) === olderStore, getProjectDir(older))
  check('A1 findProjectDir agrees for both spellings', (await findProjectDir(project)) === olderStore && (await findProjectDir(older)) === olderStore)
  const listedNew = await sessionIds(project)
  const listedOld = await sessionIds(older)
  check('A2 both spellings list the same sessions', listedNew.length === 1 && listedNew[0] === UUID('a111') && JSON.stringify(listedNew) === JSON.stringify(listedOld), JSON.stringify({ listedNew, listedOld }))
  const identity = facts.projectIdentity(project)
  check('A2 the boot card reads the project as catalogued with its newest chat, through the same resolver', identity.key === olderStore && identity.catalogued === true && identity.newestChat?.sessionId === UUID('a111'), JSON.stringify(identity))
  check('A3 no read wrote a file: the config home is byte-identical after every read door', treeHash(HOME) === homeBefore)
  check('A3 the projects dir holds the one older store and nothing else', JSON.stringify(readdirSync(PROJECTS)) === JSON.stringify([basename(olderStore)]), JSON.stringify(readdirSync(PROJECTS)))
  const fresh = childAnswers(project, older)
  check('A4 a fresh process resolves both spellings to the same store', fresh.length === 2 && fresh[0] === olderStore && fresh[1] === olderStore, fresh.join(' | '))
  check('A4 the fresh process wrote nothing either', treeHash(HOME) === homeBefore)

  section('B — adoption is the first write landing in the older store, once; a second write from the other spelling lands there too')
  facts.catalogFirstChat(project, UUID('b222'))
  const card = join(olderStore, 'project.json')
  check('B1 the birth stamp (the first write) put the project card inside the older store', existsSync(card) && (JSON.parse(readFileSync(card, 'utf8')) as { dir: string }).dir === project, existsSync(card) ? readFileSync(card, 'utf8') : 'no card')
  check('B1 no second store appeared under projects', JSON.stringify(readdirSync(PROJECTS)) === JSON.stringify([basename(olderStore)]), JSON.stringify(readdirSync(PROJECTS)))
  const cardBytes = existsSync(card) ? readFileSync(card, 'utf8') : ''
  await tests.persistTestRun(project, runRecord(project, 'run-one'))
  check('B2 the run-record writer lands in the older store', existsSync(join(olderStore, 'test-runs', 'run-one.json')) && existsSync(join(olderStore, 'test-runs', 'latest.json')))
  check('B2 the run-record reader through the other spelling reads it', tests.latestRunAtRoot(older)?.id === 'run-one', JSON.stringify(tests.latestRunAtRoot(older)))
  facts.catalogFirstChat(older, UUID('b333'))
  check('B3 a second birth from the other spelling leaves the card untouched (adoption happened once)', readFileSync(card, 'utf8') === cardBytes)
  writeFileSync(join(getProjectDir(older), `${UUID('b333')}.jsonl`), transcriptLine(older, 'new words'))
  const after = await sessionIds(project)
  check('B3 a transcript written through the other spelling is listed from the native spelling', JSON.stringify(after) === JSON.stringify([UUID('a111'), UUID('b333')]), JSON.stringify(after))
  check('B3 still one store under projects', JSON.stringify(readdirSync(PROJECTS)) === JSON.stringify([basename(olderStore)]), JSON.stringify(readdirSync(PROJECTS)))

  section('C — a symlinked spelling is the same project; older stores keyed by a structurally different spelling are found through their own card or newest transcript')
  const door = join(ROOT, 'door-to-project')
  if (trySymlink(project, door)) {
    check('C1 a symlinked spelling resolves to the adopted store', getProjectDir(door) === olderStore, getProjectDir(door))
    const linked = join(ROOT, 'LinkedProject')
    mkdirSync(linked)
    const linkDoor = join(ROOT, 'linked-door')
    symlinkSync(linked, linkDoor, 'dir')
    const linkedStore = join(PROJECTS, projectSlug(linkDoor))
    seedStore(linkedStore, linkDoor, 'linked words', UUID('c111'))
    seedCard(linkedStore, linkDoor)
    const aliased = join(ROOT, 'AliasedProject')
    mkdirSync(aliased)
    const aliasDoor = join(ROOT, 'alias-door')
    symlinkSync(aliased, aliasDoor, 'dir')
    const aliasedStore = join(PROJECTS, projectSlug(aliasDoor))
    const foreign = seedStore(aliasedStore, join(ROOT, 'some-worktree'), 'worker words', UUID('c222'))
    utimesSync(foreign, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    seedStore(aliasedStore, aliasDoor, 'alias words', UUID('c333'))
    const before = treeHash(HOME)
    check('C2 a store keyed by a symlink spelling is adopted through its project card', getProjectDir(linked) === linkedStore && (await findProjectDir(linked)) === linkedStore, getProjectDir(linked))
    check('C3 a cardless store keyed by a symlink spelling is adopted through its newest transcript\'s cwd (the older foreign-cwd transcript is not read)', getProjectDir(aliased) === aliasedStore, getProjectDir(aliased))
    check('C4 those reads wrote nothing', treeHash(HOME) === before)
  } else {
    console.log('  [SKIP] C — no symlinks on this platform')
  }

  section('D — what is never adopted')
  const sibling = join(ROOT, 'SiblingProject')
  mkdirSync(sibling)
  const hashless = join(PROJECTS, sanitizePath(olderSpelling(sibling)))
  seedStore(hashless, sibling, 'hashless words', UUID('d111'))
  const wrongHash = join(PROJECTS, `${sanitizePath(olderSpelling(sibling))}-deadbeef`)
  seedStore(wrongHash, olderSpelling(sibling), 'wrong hash words', UUID('d222'))
  const other = join(ROOT, 'OtherProject')
  mkdirSync(other)
  const otherStore = join(PROJECTS, projectSlug(olderSpelling(other)))
  seedStore(otherStore, sibling, 'other words', UUID('d333'))
  seedCard(otherStore, other)
  const workspace = join(ROOT, 'Workspace')
  mkdirSync(workspace)
  const workspaceStore = join(PROJECTS, projectSlug(workspace))
  seedStore(workspaceStore, sibling, 'hosted worker words', UUID('d444'))
  check('D1 a hash-less directory is never adopted, a case variant whose hash is not its own is never adopted, a store whose card names another directory is never adopted, a store whose transcript merely visited the directory is never adopted', getProjectDir(sibling) === join(PROJECTS, projectSlug(sibling)), getProjectDir(sibling))
  check('D1 the sibling reads "no store" (an absent canonical path), as an unknown directory does today', !existsSync(getProjectDir(sibling)) && (await findProjectDir(sibling)) === undefined)
  check('D2 the other project keeps its own older store (the card names it)', getProjectDir(other) === otherStore && getProjectDir(workspace) === workspaceStore, JSON.stringify({ other: getProjectDir(other), otherStore, workspace: getProjectDir(workspace), workspaceStore }))
  for (const leaf of ['app.1', 'app_1']) mkdirSync(join(ROOT, leaf))
  check('D3 punctuation siblings mint distinct stores', getProjectDir(join(ROOT, 'app.1')) !== getProjectDir(join(ROOT, 'app_1')))
  const brokenHome = join(ROOT, 'broken-home')
  mkdirSync(brokenHome)
  writeFileSync(join(brokenHome, 'projects'), 'a file wearing the store directory name')
  process.env.MERCURY_CONFIG_DIR = brokenHome
  let brokenAnswer = ''
  let threw: unknown = null
  try {
    brokenAnswer = getProjectDir(project)
  } catch (error) {
    threw = error
  }
  process.env.MERCURY_CONFIG_DIR = HOME
  check('D4 a projects path that is a file never throws from the resolver: the writer meets the plain unwritable-store refusal', threw === null && brokenAnswer === join(brokenHome, 'projects', projectSlug(project)), threw === null ? brokenAnswer : String(threw))
  check('D5 the resolution is keyed by the config home as well as the spelling', getProjectDir(project) === olderStore)

  section('E — two verified older stores: the newest-modified wins, the choice is taken once per process')
  const twin = join(ROOT, 'TwinProject')
  mkdirSync(twin)
  const twinUpper = olderSpelling(twin)
  const twinLower = olderSpelling(twin, 'lower')
  const storeUpper = join(PROJECTS, projectSlug(twinUpper))
  const storeLower = join(PROJECTS, projectSlug(twinLower))
  seedStore(storeUpper, twinUpper, 'upper words', UUID('e111'))
  seedStore(storeLower, twinLower, 'lower words', UUID('e222'))
  const old = new Date(Date.now() - 120_000)
  utimesSync(storeUpper, old, old)
  const chosen = getProjectDir(twin)
  check('E1 the newest-modified verified store is chosen', chosen === storeLower, chosen)
  const freshTwin = childAnswers(twin, twinUpper, twinLower)
  check('E1 a fresh process makes the same choice for every spelling', freshTwin.length === 3 && freshTwin.every(answer => answer === storeLower), freshTwin.join(' | '))
  const now = new Date()
  utimesSync(storeUpper, now, now)
  utimesSync(storeLower, old, old)
  check('E2 within the process the answer does not flap when the other store becomes newer (the memo holds the one choice)', getProjectDir(twin) === storeLower && getProjectDir(twinUpper) === storeLower && getProjectDir(twinLower) === storeLower)
  check('E2 neither store was copied, renamed or removed', existsSync(join(storeUpper, `${UUID('e111')}.jsonl`)) && existsSync(join(storeLower, `${UUID('e222')}.jsonl`)) && readdirSync(PROJECTS).filter(name => name === basename(storeUpper) || name === basename(storeLower)).length === 2)

  section('F — the sibling search is bounded: a few hundred stores, one pass, memoised for the process')
  const crowdHome = join(ROOT, 'crowd-home')
  const crowdProjects = join(crowdHome, 'projects')
  const crowdDirs = join(ROOT, 'crowd')
  mkdirSync(crowdDirs)
  for (let index = 0; index < 400; index++) {
    const dir = join(crowdDirs, `project-${index}`)
    mkdirSync(dir)
    const store = join(crowdProjects, projectSlug(dir))
    if (index % 4 === 0) seedStore(store, dir, `words ${index}`, UUID(index.toString(16)))
    else {
      seedStore(store, dir, `words ${index}`, UUID(index.toString(16)))
      seedCard(store, dir)
    }
  }
  const needle = join(ROOT, 'NeedleProject')
  mkdirSync(needle)
  const needleOlder = olderSpelling(needle)
  const needleStore = join(crowdProjects, projectSlug(needleOlder))
  seedStore(needleStore, needleOlder, 'needle words', UUID('f111'))
  process.env.MERCURY_CONFIG_DIR = crowdHome
  const startedAt = performance.now()
  const found = getProjectDir(needle)
  const firstMs = performance.now() - startedAt
  check(`F1 the older store is found among ${readdirSync(crowdProjects).length} stores in one bounded pass (${firstMs.toFixed(1)} ms)`, found === needleStore && firstMs < 3000, `${found} in ${firstMs.toFixed(1)} ms`)
  const strangerStart = performance.now()
  const stranger = join(ROOT, 'StrangerProject')
  mkdirSync(stranger)
  const strangerAnswer = getProjectDir(stranger)
  const strangerMs = performance.now() - strangerStart
  check(`F1 a directory with no store anywhere scans once and answers its own absent path (${strangerMs.toFixed(1)} ms)`, strangerAnswer === join(crowdProjects, projectSlug(stranger)) && strangerMs < 3000, `${strangerMs.toFixed(1)} ms`)
  rmSync(crowdProjects, { recursive: true, force: true })
  check('F2 the answer is memoised for the process: with every store gone the spelling still resolves where it did (no rescan on a listing)', getProjectDir(needle) === needleStore && getProjectDir(olderSpelling(needle)) === needleStore)
  process.env.MERCURY_CONFIG_DIR = HOME

  section('G — a recreated scratch root never inherits a removed root\'s store (the Linux inode-reuse case)')
  const rootA = join(ROOT, 'RootA')
  mkdirSync(rootA)
  const inodeA = inode(rootA)
  await tests.persistTestRun(rootA, runRecord(rootA, 'run-a'))
  const storeA = getProjectDir(rootA)
  check('G0 fixture: root A has a store with a run record', existsSync(join(storeA, 'test-runs', 'run-a.json')))
  rmSync(rootA, { recursive: true, force: true })
  const rootB = join(ROOT, 'RootB')
  mkdirSync(rootB)
  console.log(`  (root B ${inode(rootB) === inodeA ? 'reused' : 'did not reuse'} root A's inode on this filesystem)`)
  check('G1 root B resolves to its own store, never root A\'s', getProjectDir(rootB) === join(PROJECTS, projectSlug(rootB)) && getProjectDir(rootB) !== storeA, getProjectDir(rootB))
  check('G1 root B has no run record', tests.latestRunAtRoot(rootB) === null)
  const freshB = childAnswers(rootB)
  check('G1 a fresh process agrees', freshB[0] === getProjectDir(rootB), freshB.join(' | '))
  mkdirSync(rootA)
  check('G2 root A recreated at its own path finds its own store again', childAnswers(rootA)[0] === storeA)

  section('H — the slug grammar the older stores were keyed by, Windows shapes included')
  for (const path of ['C:\\Work\\Project', 'c:\\WORK\\PROJECT', '\\\\Server\\Share\\Project', '\\\\?\\C:\\Work\\Project', '/home/someone/Dev/App', 'Z:\\App']) {
    check(`H1 ${path.replace(/\\/g, '/')}: its own slug matches and a stranger\'s does not`, projectSlugMatches(projectSlug(path), path) && !projectSlugMatches(projectSlug(path), `${path}-other`) && !projectSlugMatches(`${sanitizePath(path)}-deadbeef`, path))
  }
  const long = join(ROOT, ...Array.from({ length: 30 }, () => 'Segment'), 'LongProject')
  check('H2 an overlong spelling matches its capped slug through the tail hash alone', projectSlugMatches(projectSlug(long), long) && !projectSlugMatches(projectSlug(long), `${long}x`))

  section('I — a project card names the owner independently of the store spelling')
  const cardProject = join(ROOT, 'CardProject')
  mkdirSync(cardProject)
  const cardDoor = join(ROOT, 'CARD-DOOR')
  symlinkSync(cardProject, cardDoor, process.platform === 'win32' ? 'junction' : 'dir')
  const cardStore = join(PROJECTS, projectSlug(cardDoor))
  seedStore(cardStore, sibling, 'worker words', UUID('a444'))
  seedCard(cardStore, cardProject)
  const casedProject = join(ROOT, 'CasedProject')
  mkdirSync(casedProject)
  const casedOlder = join(ROOT, 'CASEDPROJECT')
  const casedStore = join(PROJECTS, projectSlug(casedOlder))
  seedCard(casedStore, casedProject)
  const vetoProject = join(ROOT, 'VetoProject')
  mkdirSync(vetoProject)
  const vetoOlder = join(ROOT, 'VETOPROJECT')
  if (!existsSync(vetoOlder)) symlinkSync(vetoProject, vetoOlder, process.platform === 'win32' ? 'junction' : 'dir')
  const vetoStore = join(PROJECTS, projectSlug(vetoOlder))
  seedStore(vetoStore, vetoOlder, 'wrong owner', UUID('a555'))
  seedCard(vetoStore, other)
  const cardsBefore = treeHash(HOME)
  const cardAnswers = childAnswers(cardProject, cardDoor, casedProject, vetoProject)
  check('I1 a fresh process adopts an alias-keyed store whose card names the native directory, despite a foreign transcript cwd', cardAnswers[0] === cardStore && cardAnswers[1] === cardStore, cardAnswers.join(' | '))
  check('I2 a card adopts a case-variant store even when that spelling is not a live path', cardAnswers[2] === casedStore, cardAnswers[2])
  check('I3 a card naming another directory vetoes a live case variant and its transcript', cardAnswers[3] === join(PROJECTS, projectSlug(vetoProject)), cardAnswers[3])
  check('I4 card ownership reads wrote nothing', treeHash(HOME) === cardsBefore)

  if (process.platform === 'darwin' && existsSync(join(ROOT, 'mixedcaseproject'))) {
    section('J — the same laws on case-sensitive APFS')
    const image = join(ROOT, 'case-sensitive.dmg')
    const diskOptions = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
    const created = spawnSync('hdiutil', ['create', '-size', '400m', '-fs', 'Case-sensitive APFS', '-volname', 'project-identity', image], diskOptions)
    check('J1 the case-sensitive image is created unattended', created.status === 0, created.stderr || String(created.error ?? created.status))
    if (created.status === 0) {
      mkdirSync(CASE_MOUNT)
      const attached = spawnSync('hdiutil', ['attach', '-nobrowse', '-mountpoint', CASE_MOUNT, image], diskOptions)
      check('J2 the image mounts unattended', attached.status === 0, attached.stderr || String(attached.error ?? attached.status))
      if (attached.status === 0) {
        const temp = join(CASE_MOUNT, 'tmp')
        mkdirSync(temp)
        const run = spawnSync(process.execPath, [import.meta.path], { ...diskOptions, timeout: 120_000, env: { ...process.env, TMPDIR: temp, MERCURY_CONFIG_DIR: join(CASE_MOUNT, 'home') } })
        console.log(run.stdout)
        check('J3 the full identity proof passes on case-sensitive APFS', run.status === 0, run.stderr || String(run.error ?? run.status))
      }
    }
  }
} finally {
  if (existsSync(CASE_MOUNT) && statSync(CASE_MOUNT).dev !== statSync(ROOT).dev) {
    const detached = spawnSync('hdiutil', ['detach', CASE_MOUNT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
    if (detached.status !== 0) throw new Error(`case-sensitive image remains mounted at ${CASE_MOUNT}: ${detached.stderr || detached.error || detached.status}`)
  }
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-project-directory-identity: ALL LAWS HOLD' : `\nprove-project-directory-identity: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
