#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'landing-words-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}
const j = (v: unknown): string => JSON.stringify(v)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const state = await import('../../src/bootstrap/state.ts')
const p = await import('../../src/input-core/pending-input.ts')

const src = (rel: string): string => join(ROOT, 'src', rel).replace(/\\/g, '\\\\')
function project(name: string): string {
  const dir = join(SCRATCH, name)
  mkdirSync(dir, { recursive: true })
  state.setCwdState(dir)
  p.resetPendingInputForTests()
  return dir
}
function runnerClaims(dir: string, born: string): { ended: boolean; words: string } {
  const script = `
    ;(globalThis).MACRO = { VERSION: '1.0.0' }
    const { enableConfigs } = await import('${src('utils/config.ts')}')
    enableConfigs()
    await import('${src('input-core/pending-input.ts')}')
    const { switchSession } = await import('${src('bootstrap/state.ts')}')
    switchSession(${j(born)}, null)
  `
  const run = spawnSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, MERCURY_CONFIG_DIR: HOME } })
  return { ended: run.status === 0, words: `exit ${run.status}${run.signal ? ` ${run.signal}` : ''}: ${(run.stderr ?? '').trim().slice(-300)}` }
}
const page = (id: string): string | null => p.readDraftFor(id)?.text ?? null
async function owns(id: string, words: string): Promise<void> {
  p.initSession(id, '')
  p.edit(words)
  await p.flushDrafts()
  p.resetPendingInputForTests()
}

console.log('§1 letters typed since the last save stay through a landing whose session a runner has claimed')
{
  const dir = project('typed-on')
  p.initSession('boot-screen', '')
  p.edit('fix the')
  await p.flushDrafts()
  p.edit('fix the bug')
  const claim = runnerClaims(dir, 'born-session')
  check("the runner's part ran to its end (a process with no composer that switches its identity to the born session, as the claim does)", claim.ended, claim.words)
  check("the runner's claim moves no page of the composer's: the saved page is still under the screen's own id, none under the born session's", page('boot-screen') === 'fix the' && page('born-session') === null, j({ screen: page('boot-screen'), born: page('born-session') }))
  await p.rekeyToSession('born-session', { landing: true })
  check('THE DEFECT PIN: after the landing the composer holds every letter typed, the ones typed since the last save among them', p.text() === 'fix the bug', j(p.text()))
  await p.flushDrafts()
  check("the page is the born session's now, whole, and the screen's own id keeps none", page('born-session') === 'fix the bug' && page('boot-screen') === null, j({ screen: page('boot-screen'), born: page('born-session') }))
}

console.log('\n§2 a letter deleted before the landing stays deleted')
{
  const dir = project('deleted')
  p.initSession('boot-screen', '')
  p.edit('x')
  await p.flushDrafts()
  p.edit('')
  const claim = runnerClaims(dir, 'born-session')
  check("the runner's part ran to its end", claim.ended, claim.words)
  await p.rekeyToSession('born-session', { landing: true })
  check('THE DEFECT PIN: after the landing the composer is empty, the deleted letter is not back', p.text() === '', j(p.text()))
  await p.flushDrafts()
  check('no page of the deleted letter is left under either id', page('born-session') === null && page('boot-screen') === null, j({ screen: page('boot-screen'), born: page('born-session') }))
}

console.log('\n§3 the laws of the draft that stand as they stood')
{
  const dir = project('saved-and-quiet')
  p.initSession('boot-screen', '')
  p.edit('hello')
  await p.flushDrafts()
  const claim = runnerClaims(dir, 'born-session')
  await p.rekeyToSession('born-session', { landing: true })
  check('words saved before the landing, with nothing typed since, follow into the born session', claim.ended && p.text() === 'hello' && page('born-session') === 'hello' && page('boot-screen') === null, j({ text: p.text(), screen: page('boot-screen'), born: page('born-session'), claim: claim.words }))
}
{
  const dir = project('own-page')
  p.initSession('owned-session', '')
  p.edit('a page of its own')
  await p.flushDrafts()
  p.resetPendingInputForTests()
  p.initSession('boot-screen', '')
  const claim = runnerClaims(dir, 'owned-session')
  await p.rekeyToSession('owned-session', { landing: true })
  check('a session that owns a saved page of its own shows that page when the screen lands in it', claim.ended && p.text() === 'a page of its own', j({ text: p.text(), claim: claim.words }))
  await p.rekeyToSession(null)
  p.edit('typed on the resting slot')
  await p.rekeyToSession('owned-session', { landing: true })
  check('…and its page still wins over words typed on the resting slot, as it did', p.text() === 'a page of its own', j(p.text()))
}
{
  project('identity-switch')
  p.initSession('resumed-session', '')
  p.edit('words of the resumed session')
  await p.flushDrafts()
  p.resetPendingInputForTests()
  p.initSession('boot-screen', '')
  state.switchSession('resumed-session' as never, null)
  const until = Date.now() + 5000
  while (p.text() !== 'words of the resumed session' && Date.now() < until) await new Promise(r => setTimeout(r, 10))
  check('in a process whose composer is seeded, with no seat in the slot, an identity switch still re-keys the composer to the session it switched to', p.text() === 'words of the resumed session', j(p.text()))
}

console.log('\n§4 a key that falls into the landing re-key itself')
{
  project('key-in-the-rekey')
  p.initSession('boot-screen', '')
  p.edit('first words')
  const landing = p.rekeyToSession('born-session', { landing: true })
  p.edit('first words and more')
  await landing
  await p.flushDrafts()
  check('the composer keeps the key typed into the re-key', p.text() === 'first words and more', j(p.text()))
  check("its page is the born session's alone: no copy stays under the screen's own id", page('born-session') === 'first words and more' && page('boot-screen') === null, j({ screen: page('boot-screen'), born: page('born-session') }))
  p.edit('first words and more, sent')
  p.clearForSubmit('first words and more, sent')
  p.edit('')
  await p.flushDrafts()
  await p.rekeyToSession(null)
  await p.rekeyToSession('second-session', { landing: true })
  check('THE DEFECT PIN: the next new session of the project, landed with nothing typed, opens with an empty composer and not with the words already sent', p.text() === '', j(p.text()))
}
{
  project('cursor-key-in-the-rekey')
  p.initSession('boot-screen', '')
  p.edit('first words')
  const landing = p.rekeyToSession('born-session', { landing: true })
  p.reportCursor(5)
  await landing
  await p.flushDrafts()
  check("a cursor key pressed into the re-key leaves no copy under the screen's own id either", p.text() === 'first words' && page('born-session') === 'first words' && page('boot-screen') === null, j({ text: p.text(), screen: page('boot-screen'), born: page('born-session') }))
}
{
  project('key-saved-before-the-move')
  p.initSession('boot-screen', '')
  p.edit('first words')
  await p.flushDrafts()
  const landing = p.rekeyToSession('born-session', { landing: true })
  p.edit('first words and more')
  const early = p.flushDrafts()
  await Promise.all([landing, early])
  await p.flushDrafts()
  check("a key typed into the landing whose save reaches the file before the screen's page is moved: the born session keeps the later words and no copy stays under the screen's own id", p.text() === 'first words and more' && page('born-session') === 'first words and more' && page('boot-screen') === null, j({ text: p.text(), screen: page('boot-screen'), born: page('born-session') }))
  p.clearForSubmit('first words and more')
  p.edit('')
  await p.flushDrafts()
  await p.rekeyToSession(null)
  await p.rekeyToSession('second-session', { landing: true })
  check('THE DEFECT PIN (read by hand on Windows): the next new session of the project, landed with nothing typed, opens with an empty composer and not with words the screen left behind', p.text() === '' && page('second-session') === null, j({ text: p.text(), second: page('second-session') }))
}

console.log('\n§5 only a born session is named early: in a hop, or a landing on a session that owns a page, what is pressed into the wait stays with the session it was pressed in')
{
  project('hop-with-a-cursor-key')
  p.initSession('session-a', '')
  p.edit('half-typed for a')
  const hop = p.rekeyToSession('session-b')
  p.reportCursor(3)
  await hop
  await p.flushDrafts()
  check('a cursor key pressed into a hop writes nothing under the session hopped to, and the one hopped from keeps its words', p.text() === '' && page('session-b') === null && page('session-a') === 'half-typed for a', j({ text: p.text(), a: page('session-a'), b: page('session-b') }))
}
{
  project('hop-with-a-mode-key')
  await owns('session-b', 'words of b')
  p.initSession('session-a', '')
  const hop = p.rekeyToSession('session-b')
  p.setMode('bash')
  await hop
  await p.flushDrafts()
  check('a mode key pressed into a hop from an empty composer leaves the saved page of the session hopped to as it was', p.text() === 'words of b' && page('session-b') === 'words of b', j({ text: p.text(), b: page('session-b') }))
}
{
  project('hop-with-enter')
  await owns('session-b', 'words of b')
  p.initSession('session-a', '')
  p.edit('ready to send')
  const hop = p.rekeyToSession('session-b')
  p.clearForSubmit('ready to send')
  p.edit('')
  await hop
  await p.flushDrafts()
  check('an Enter pressed into a hop clears the page of the session its words were typed in, and leaves the saved page of the session hopped to', p.text() === '' && page('session-a') === null && page('session-b') === 'words of b', j({ text: p.text(), a: page('session-a'), b: page('session-b') }))
}
{
  project('two-hops-in-one-wait')
  await owns('session-b', 'words of b')
  await owns('session-c', 'words of c')
  p.initSession('session-a', '')
  p.edit('half-typed for a')
  const first = p.rekeyToSession('session-b')
  const second = p.rekeyToSession('session-c')
  await Promise.all([first, second])
  p.reportCursor(1)
  await p.flushDrafts()
  check('two hops begun in one wait, and a cursor key after them, leave each of the three sessions its own page', page('session-a') === 'half-typed for a' && page('session-b') === 'words of b' && page('session-c') === 'words of c', j({ a: page('session-a'), b: page('session-b'), c: page('session-c') }))
}
{
  project('landing-on-an-owned-page')
  await owns('owned-session', 'a page of its own')
  p.initSession('boot-screen', '')
  p.edit('typed on the resting slot')
  const landing = p.rekeyToSession('owned-session', { landing: true })
  p.reportCursor(4)
  await landing
  await p.flushDrafts()
  check("a cursor key pressed into a landing on a session that owns a page leaves that page its own, and the resting slot's words under the screen's id", p.text() === 'a page of its own' && page('owned-session') === 'a page of its own' && page('boot-screen') === 'typed on the resting slot', j({ text: p.text(), screen: page('boot-screen'), owned: page('owned-session') }))
}

console.log('\n§6 the owner')
{
  const store = readFileSync(join(ROOT, 'src/input-core/pending-input.ts'), 'utf8').replace(/\r\n/g, '\n')
  check(
    'the identity-switch listener re-keys only where a composer has been seeded and no seat holds the slot',
    store.includes("onSessionSwitch(id => {\n  if (!initialized || getFocusedSessionConnector().sessionId() !== '') return\n  void rekeyToSession(String(id), { landing: true })\n})"),
  )
  const chat = readFileSync(join(ROOT, 'src/screens/Chat.tsx'), 'utf8').replace(/\r\n/g, '\n')
  check("the screen's own landing is the one mover of a page under a born session's id: Chat's re-key effect calls the landing re-key, and the migration has that one caller", chat.includes("pendingInput.rekeyToSession(focusedSessionId === '' ? null : focusedSessionId, { landing })") && (store.match(/migrateOrphanedDraft\(/g) ?? []).length === 1)
}

console.log('\n§7 a flush waits for a save that is still being written')
{
  const drafts = join(HOME, 'drafts')
  const before = new Set(readdirSync(drafts))
  project('save-in-flight')
  p.initSession('flight-session', '')
  p.edit('seed')
  await p.flushDrafts()
  const file = join(drafts, readdirSync(drafts).find(name => name.endsWith('.json') && !before.has(name))!)
  const lockfile = await import('../../src/utils/lockfile.ts')
  const release = await lockfile.lock(file)
  p.edit('typed and left alone')
  await new Promise(resolve => setTimeout(resolve, 600))
  let returned = false
  const flushed = p.flushDrafts().then(() => {
    returned = true
  })
  await new Promise(resolve => setTimeout(resolve, 60))
  const waited = !returned && page('flight-session') === 'seed'
  await release()
  await flushed
  check('a flush called while a save the timer started is still being written returns when that page is in the file, and not before', waited && page('flight-session') === 'typed and left alone', j({ returnedBeforeTheWrite: !waited, page: page('flight-session') }))
}

console.log(`\nprove-landing-keeps-typed-words: ${checks} checks, ${failures} failed`)
try {
  removeScratch(SCRATCH)
} catch (error) {
  console.log(`  scratch left at ${SCRATCH}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
}
process.exit(failures === 0 ? 0 : 1)
