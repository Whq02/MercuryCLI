#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function olderSpelling(path: string): string {
  if (process.platform !== 'linux') return path.toUpperCase()
  const alias = join(dirname(path), basename(path).toUpperCase())
  if (!existsSync(alias)) symlinkSync(path, alias, 'dir')
  return alias
}

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'project-identity-')))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
delete process.env.MERCURY_HOME
const portable = join(dirname(fileURLToPath(import.meta.url)), '../../src/utils/sessionStoragePortable.ts')
const { getProjectDir, findProjectDir, projectSlug, sanitizePath } = await import(portable)
const projects = join(process.env.MERCURY_CONFIG_DIR, 'projects')
const project = join(root, 'MixedCaseProject')
mkdirSync(project)
const upper = olderSpelling(project)
mkdirSync(projects, { recursive: true })
const seed = (path: string, cwd: string, body = 'unchanged history'): void => {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'project.json'), JSON.stringify({ schema: 1, dir: cwd, firstChatAt: 1, firstSessionId: 'history' }))
  writeFileSync(join(path, 'history.jsonl'), JSON.stringify({ schemaVersion: 1, cwd, payload: { kind: 'input', content: body } }) + '\n')
}
const childCode = `import {getProjectDir} from ${JSON.stringify(portable)}; console.log(getProjectDir(process.argv.at(-1)))`
const child = (path: string) => spawnSync(process.execPath, ['-e', childCode, path], { env: process.env, encoding: 'utf8' })
try {
  assert.equal(statSync(project, { bigint: true }).ino, statSync(upper, { bigint: true }).ino, 'fixture spellings must identify one native directory')
  const oldStore = join(projects, projectSlug(upper))
  seed(oldStore, upper)
  const history = readFileSync(join(oldStore, 'history.jsonl'), 'utf8')
  assert.equal(getProjectDir(project), oldStore, 'canonical spelling must adopt the existing older-case store')
  assert.equal(getProjectDir(upper), oldStore)
  assert.equal(await findProjectDir(project), oldStore)
  assert.equal(child(project).stdout.trim(), oldStore, 'the ownership survives a fresh process')
  assert.equal(readFileSync(join(oldStore, 'history.jsonl'), 'utf8'), history)
  assert.deepEqual(readdirSync(projects), [basename(oldStore)], 'adoption creates no second project store')
  console.log('PASS older spelling adopted in place, history intact across restart')

  const collision = join(projects, projectSlug(project))
  seed(collision, project, 'second history')
  const collisionBytes = readFileSync(join(collision, 'history.jsonl'), 'utf8')
  assert.throws(() => getProjectDir(upper), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST', 'a newly discovered second owner invalidates a previous lookup')
  assert.notEqual(child(project).status, 0)
  assert.equal(readFileSync(join(oldStore, 'history.jsonl'), 'utf8'), history)
  assert.equal(readFileSync(join(collision, 'history.jsonl'), 'utf8'), collisionBytes)
  console.log('PASS two-store collision refuses without copying or deleting either history')

  const fresh = join(root, 'FreshProject')
  mkdirSync(fresh)
  const a = getProjectDir(olderSpelling(fresh))
  assert.equal(a, getProjectDir(fresh))
  assert.equal(a, join(projects, projectSlug(realpathSync.native(fresh))))
  const otherHome = join(root, 'other-home')
  const firstHome = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = otherHome
  assert.notEqual(getProjectDir(fresh), a, 'memoization must include the config home')
  process.env.MERCURY_CONFIG_DIR = firstHome
  console.log('PASS fresh keys use the native spelling and homes stay separate')

  for (const leaf of ['app.1', 'app_1']) mkdirSync(join(root, leaf))
  assert.notEqual(getProjectDir(join(root, 'app.1')), getProjectDir(join(root, 'app_1')))
  const hashless = join(projects, sanitizePath(fresh))
  seed(hashless, fresh)
  assert.notEqual(getProjectDir(fresh), hashless)
  console.log('PASS punctuation collisions and hashless stores are not cross-adopted')

  const deep = join(root, ...Array.from({ length: 30 }, () => 'Segment'), 'LongProject')
  mkdirSync(deep, { recursive: true })
  const deepOld = join(projects, projectSlug(olderSpelling(deep)))
  seed(deepOld, olderSpelling(deep))
  assert.equal(getProjectDir(deep), deepOld, 'long slugs use the recorded directory identity')
  const linked = join(root, ...Array.from({ length: 30 }, () => 'Linked'), 'Project')
  mkdirSync(linked, { recursive: true })
  const link = join(root, 'junction')
  symlinkSync(olderSpelling(linked), link, 'junction')
  const linkedStore = join(projects, projectSlug(realpathSync(link).normalize('NFC')))
  seed(linkedStore, link)
  assert.equal(getProjectDir(linked), linkedStore, 'a project card can record a junction to its older canonical spelling')
  const transcript = join(root, ...Array.from({ length: 30 }, () => 'Transcript'), 'Project')
  mkdirSync(transcript, { recursive: true })
  const transcriptStore = join(projects, projectSlug(olderSpelling(transcript)))
  mkdirSync(transcriptStore)
  writeFileSync(join(transcriptStore, 'history.jsonl'), JSON.stringify({ schemaVersion: 1, annotations: { cwd: olderSpelling(transcript) }, payload: { kind: 'input' } }) + '\n')
  assert.equal(getProjectDir(transcript), transcriptStore, 'a transcript directory stamp resolves an older long spelling without a card')
  console.log('PASS truncated older slug is inventoried by its native directory')

  const { legacyProjectSlugMatches } = await import('../../src/utils/projectStoreIdentity.ts')
  for (const path of ['C:\\Work\\Project', 'c:\\WORK\\PROJECT', '\\\\Server\\Share\\Project', '\\\\?\\C:\\Work\\Project']) {
    assert.ok(legacyProjectSlugMatches(projectSlug(path), path))
    assert.equal(legacyProjectSlugMatches(projectSlug(path), path + '-other'), false)
  }
  const withoutCard = join(root, 'NoCardProject')
  mkdirSync(withoutCard)
  const withoutCardStore = join(projects, projectSlug(olderSpelling(withoutCard)))
  mkdirSync(withoutCardStore)
  writeFileSync(join(withoutCardStore, 'history.jsonl'), 'opaque historical bytes\n')
  assert.equal(getProjectDir(withoutCard), withoutCardStore, 'the exact older hash can establish a short spelling without a card')
  const uncertain = join(root, ...Array.from({ length: 30 }, () => 'Unknown'), 'Project')
  mkdirSync(uncertain, { recursive: true })
  const uncertainStore = join(projects, projectSlug(olderSpelling(uncertain)))
  mkdirSync(uncertainStore)
  writeFileSync(join(uncertainStore, 'history.jsonl'), 'opaque historical bytes\n')
  assert.throws(() => getProjectDir(uncertain), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST', 'a truncated unidentifiable history cannot be silently orphaned')
  assert.equal(readFileSync(join(uncertainStore, 'history.jsonl'), 'utf8'), 'opaque historical bytes\n')
  const unicode = join(root, 'MünchenProject')
  mkdirSync(unicode)
  const unicodeStore = join(projects, projectSlug(olderSpelling(unicode)))
  mkdirSync(unicodeStore)
  writeFileSync(join(unicodeStore, 'history.jsonl'), 'opaque historical bytes\n')
  assert.throws(() => getProjectDir(unicode), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST', 'lossy Unicode casing cannot hide an older history')
  writeFileSync(join(unicodeStore, 'project.json'), JSON.stringify({ schema: 1, dir: olderSpelling(unicode) }))
  assert.equal(getProjectDir(unicode), unicodeStore, 'native identity resolves a recorded Unicode casing')
  console.log('PASS Windows-shaped legacy hashes, cardless history, and unknown ownership refusal')

  const interrupted = join(root, 'InterruptedProject')
  mkdirSync(interrupted)
  const interruptedStore = join(projects, projectSlug(olderSpelling(interrupted)))
  seed(interruptedStore, olderSpelling(interrupted))
  const failed = spawnSync(process.execPath, ['-e', childCode, interrupted], { env: { ...process.env, MERCURY_FAULT_INJECT: 'rename@project-identities:throw' }, encoding: 'utf8' })
  assert.notEqual(failed.status, 0, 'a failed atomic publish is not reported as adoption')
  assert.equal(getProjectDir(interrupted), interruptedStore, 'a fresh resolution after failure retains the original store')
  const maps = join(process.env.MERCURY_CONFIG_DIR!, 'project-identities')
  const chosenMap = readdirSync(maps).find(name => JSON.parse(readFileSync(join(maps, name), 'utf8')).store === basename(interruptedStore))!
  const mapping = join(maps, chosenMap)
  const intactMap = readFileSync(mapping, 'utf8')
  writeFileSync(mapping, '{')
  assert.throws(() => getProjectDir(interrupted), 'a corrupt mapping never silently chooses a new store')
  writeFileSync(mapping, intactMap)
  assert.equal(getProjectDir(interrupted), interruptedStore)
  console.log('PASS interrupted publish and corrupt ownership fail without altering history')

  const concurrent = join(root, 'ConcurrentProject')
  mkdirSync(concurrent)
  seed(join(projects, projectSlug(olderSpelling(concurrent))), olderSpelling(concurrent))
  const children = Array.from({ length: 6 }, (_, index) => new Promise<string>((resolve, reject) => {
    const proc = spawn(process.execPath, ['-e', childCode, index % 2 ? olderSpelling(concurrent) : concurrent], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    proc.stdout.on('data', chunk => { out += chunk })
    proc.stderr.on('data', chunk => { err += chunk })
    proc.once('error', reject)
    proc.once('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(err)))
  }))
  assert.equal(new Set(await Promise.all(children)).size, 1)
  for (const name of readdirSync(maps)) {
    assert.ok(name.endsWith('.json'), 'no incomplete mapping remains')
    const record = JSON.parse(readFileSync(join(maps, name), 'utf8'))
    assert.equal(record.schema, 1)
    assert.equal(typeof record.store, 'string')
  }
  console.log('PASS concurrent processes publish one complete ownership mapping')
} finally {
  rmSync(root, { recursive: true, force: true })
}
