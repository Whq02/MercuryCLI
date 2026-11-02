#!/usr/bin/env bun
// gate-watch: src/mneme/** src/utils/projectStoreIdentity.ts src/utils/directoryIdentity.ts
// gate-watch: src/utils/sessionStoragePortable.ts src/bootstrap/state.ts src/utils/config/globalConfig.ts src/utils/git.ts
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = realpathSync.native(mkdtempSync(join(tmpdir(), 'memory-identity-')))
const HOME = join(ROOT, 'home')
const PROJECTS = join(HOME, 'projects')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setProjectRoot } = await import('../../src/bootstrap/state.ts')
const { mnemeProjectKeyFor, getMnemeHome, lineagePath } = await import('../../src/mneme/paths.ts')
const { loadMemoryPrompt } = await import('../../src/mneme/mnemeFrontPage.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { retainItems } = await import('../../src/mneme/memoryVerbs.ts')
const { readPins } = await import('../../src/mneme/mnemeUsage.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { openEntry, readLedger } = await import('../../src/mneme/ledger.ts')
const { resolveDirectoryIdentity } = await import('../../src/utils/projectStoreIdentity.ts')
const { capSanitizedName } = await import('../../src/utils/sessionStoragePortable.ts')
const RULE = 'always keep the hatch clear'
const spellingKey = (dir: string): string => capSanitizedName(dir.replace(/[^A-Za-z0-9_-]/g, '-'), dir)
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function treeHash(root: string): string {
  const rows: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) { rows.push(`d ${relative(root, path)}`); walk(path) }
      else rows.push(`f ${relative(root, path)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`)
    }
  }
  walk(root)
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}
function alias(target: string, name: string): string {
  const path = join(ROOT, name)
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  return path
}
function seedEstate(spelling: string, evidence: 'card' | 'transcript' | 'none' = 'card'): string {
  const estate = join(PROJECTS, spellingKey(spelling))
  mkdirSync(join(estate, 'memory', 'library'), { recursive: true })
  if (evidence === 'card') writeFileSync(join(estate, 'project.json'), JSON.stringify({ dir: spelling }))
  if (evidence === 'transcript') writeFileSync(join(estate, '00000000-0000-4000-8000-000000000001.jsonl'), JSON.stringify({ cwd: spelling }) + '\n')
  return estate
}
function at(dir: string): { key: string; home: string; prompt: string | null } {
  setProjectRoot(dir)
  return { key: mnemeProjectKeyFor(dir), home: getMnemeHome(), prompt: loadMemoryPrompt() }
}
const sourceRoot = join(import.meta.dir, '..', '..', 'src')
const childCode = `globalThis.MACRO={VERSION:'1.0.0'}; const {enableConfigs}=await import(${JSON.stringify(join(sourceRoot, 'utils/config/globalConfig.ts'))}); enableConfigs(); const {setProjectRoot}=await import(${JSON.stringify(join(sourceRoot, 'bootstrap/state.ts'))}); const {mnemeProjectKeyFor}=await import(${JSON.stringify(join(sourceRoot, 'mneme/paths.ts'))}); const {loadMemoryPrompt}=await import(${JSON.stringify(join(sourceRoot, 'mneme/mnemeFrontPage.ts'))}); for(const dir of process.argv.slice(1)){setProjectRoot(dir); console.log(JSON.stringify({key:mnemeProjectKeyFor(dir),prompt:loadMemoryPrompt()}))}`
function fresh(...dirs: string[]): Array<{ key: string; prompt: string | null }> {
  const run = spawnSync(process.execPath, ['-e', childCode, ...dirs], { env: process.env, encoding: 'utf8', windowsHide: true })
  if (run.status !== 0) throw new Error(`fresh process rc ${run.status}: ${run.stderr}`)
  return run.stdout.trim().split('\n').map(line => JSON.parse(line))
}

try {
  const project = join(ROOT, 'MixedProject')
  mkdirSync(project)
  const older = alias(project, 'old-door')
  const estate = seedEstate(older)
  const library = join(estate, 'memory', 'library')
  const seeded = retainItems([{ content: RULE, pin: true }], { session: 'seed-rule', pin: true, asked: true }, library)
  if (seeded[0]?.status !== 'stored') throw new Error(`fixture rule not stored: ${JSON.stringify(seeded)}`)
  const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
  maybeConsolidate({ force: true, dir: library })
  if (readPins(library).length !== 1) throw new Error('fixture rule did not reach the pinned shelf')
  const before = treeHash(HOME)
  const native = at(project)
  const other = at(older)
  check('A1 the pinned rule at session start is identical under both spellings, verbatim and asked for by the user', native.prompt === other.prompt && native.prompt?.includes(RULE) === true && native.prompt.includes('asked for by the user'), JSON.stringify({ native: native.prompt, other: other.prompt }))
  check('A2 both spellings read the older estate key and memory home', native.key === basename(estate) && other.key === native.key && native.home === other.home, JSON.stringify({ native: native.key, other: other.key }))
  check('A3 every file is byte-identical after those reads; no new estate exists', treeHash(HOME) === before && readdirSync(PROJECTS).length === 1)
  const boot = fresh(project, older)
  check('A4 a fresh process loads the same pinned rule through either spelling', boot.length === 2 && boot.every(row => row.key === basename(estate) && row.prompt === native.prompt) && boot[0]?.prompt?.includes(RULE) === true)
  check('A5 the fresh-process reads did not write either', treeHash(HOME) === before)

  setProjectRoot(project)
  const written = retainItems([{ content: 'the boathouse has two blue doors' }], { session: 'first-write' })
  check('B1 the first write lands in the older estate, not a new one', written[0]?.status === 'stored' && pendingRows(library).some(row => row.text === 'the boathouse has two blue doors') && readdirSync(PROJECTS).length === 1)
  openEntry(mnemeProjectKeyFor(older), { sessionId: 'after-alias', model: 'fixture' })
  check('B2 the lineage writer and reader agree through both spellings', readLedger(mnemeProjectKeyFor(project)).some(row => row.sessionId === 'after-alias') && existsSync(join(estate, 'lineage', 'ledger.jsonl')))
  check('B3 the pin remains once, with the original words and asked mark', readPins(library).length === 1 && readPins(library)[0]?.asked === true && at(older).prompt?.includes(RULE) === true)
  check('B4 adoption neither copied nor renamed the estate', existsSync(library) && readdirSync(PROJECTS).length === 1)

  const third = alias(project, 'third-door')
  check('C1 another symlinked spelling reads the same estate', at(third).key === basename(estate) && mnemeLibraryDir() === library)
  const cardlessProject = join(ROOT, 'Cardless')
  mkdirSync(cardlessProject)
  const cardlessAlias = alias(cardlessProject, 'cardless-door')
  const cardless = seedEstate(cardlessAlias, 'transcript')
  const cardlessBefore = treeHash(HOME)
  check('C2 a cardless older spelling is verified by its newest transcript', mnemeProjectKeyFor(cardlessProject) === basename(cardless))
  check('C3 that read wrote nothing', treeHash(HOME) === cardlessBefore)

  const caseProject = join(ROOT, 'CaseProject')
  mkdirSync(caseProject)
  const upper = caseProject.toUpperCase()
  if (resolveDirectoryIdentity(upper).key === resolveDirectoryIdentity(caseProject).key) {
    const caseEstate = seedEstate(upper, 'none')
    const answers = fresh(caseProject, upper)
    check('D1 a hash-less case-variant estate without metadata reads one key', answers[0]?.key === answers[1]?.key && existsSync(join(PROJECTS, answers[0]!.key, 'memory')))
    check('D2 case-variant reads do not create a second estate', statSync(join(PROJECTS, answers[0]!.key)).ino === statSync(caseEstate).ino)
  } else console.log('  [SKIP] D — case-sensitive filesystem; symlink cases above still run')

  const twin = join(ROOT, 'Twin')
  mkdirSync(twin)
  const doorA = alias(twin, 'twin-a')
  const doorB = alias(twin, 'twin-b')
  const estateA = seedEstate(doorA)
  const estateB = seedEstate(doorB)
  const old = new Date(Date.now() - 120_000)
  utimesSync(estateA, old, old)
  check('E1 two verifiable estates: newest-modified wins', mnemeProjectKeyFor(twin) === basename(estateB))
  utimesSync(estateB, old, old)
  utimesSync(estateA, new Date(), new Date())
  check('E2 the process holds one choice across spellings despite changed timestamps', [twin, doorA, doorB].every(dir => mnemeProjectKeyFor(dir) === basename(estateB)))
  rmSync(estateB, { recursive: true, force: true })
  check('E3 no rescan even with the chosen estate gone; a new alias uses the same memo', mnemeProjectKeyFor(alias(twin, 'twin-c')) === basename(estateB))
  check('E4 a fresh process sees current disk state', fresh(twin)[0]?.key === basename(estateA))

  const missing = join(ROOT, 'not-created')
  const absentHome = join(ROOT, 'absent-home')
  process.env.MERCURY_CONFIG_DIR = absentHome
  check('F1 an absent root returns its canonical key without creating a home', mnemeProjectKeyFor(missing) === spellingKey(missing) && !existsSync(absentHome))
  check('F2 getMnemeHome is keyed by config home as well as project spelling', at(project).home.startsWith(absentHome))
  process.env.MERCURY_CONFIG_DIR = HOME
  check('F3 returning to the first config home keeps its selection', at(project).key === basename(estate) && getMnemeHome().startsWith(HOME))
  const rootA = join(ROOT, 'RootA')
  mkdirSync(rootA)
  openEntry(mnemeProjectKeyFor(rootA), { sessionId: 'root-a', model: 'fixture' })
  const keyA = mnemeProjectKeyFor(rootA)
  const inoA = statSync(rootA).ino
  rmSync(rootA, { recursive: true, force: true })
  const rootB = join(ROOT, 'RootB')
  mkdirSync(rootB)
  console.log(`  root B ${statSync(rootB).ino === inoA ? 'reused' : 'did not reuse'} root A's inode`)
  check('F4 Linux inode reuse cannot lend root A\'s estate to root B', mnemeProjectKeyFor(rootB) === spellingKey(rootB) && mnemeProjectKeyFor(rootB) !== keyA && !existsSync(lineagePath(mnemeProjectKeyFor(rootB))))
  check('F5 realpath failures degrade to the raw spelling without throwing', resolveDirectoryIdentity(join(ROOT, 'missing', 'child')).canonical === join(ROOT, 'missing', 'child'))

  const wrong = join(ROOT, 'Wrong')
  mkdirSync(wrong)
  const wrongAlias = alias(wrong, 'wrong-door')
  const wrongEstate = seedEstate(wrongAlias)
  writeFileSync(join(wrongEstate, 'project.json'), JSON.stringify({ dir: project }))
  check('G1 a card naming a different directory cannot donate an estate', mnemeProjectKeyFor(wrong) === spellingKey(wrong))
  check('G2 malformed projects storage cannot throw from a read', (() => {
    const broken = join(ROOT, 'broken')
    mkdirSync(broken)
    writeFileSync(join(broken, 'projects'), 'not a directory')
    process.env.MERCURY_CONFIG_DIR = broken
    try { return mnemeProjectKeyFor(project) === spellingKey(project) } finally { process.env.MERCURY_CONFIG_DIR = HOME }
  })())
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nprove-memory-project-directory-identity: ALL LAWS HOLD' : `\nprove-memory-project-directory-identity: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
