#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
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

console.log('\n§4 the owner')
{
  const store = readFileSync(join(ROOT, 'src/input-core/pending-input.ts'), 'utf8').replace(/\r\n/g, '\n')
  check(
    'the identity-switch listener re-keys only where a composer has been seeded and no seat holds the slot',
    store.includes("onSessionSwitch(id => {\n  if (!initialized || getFocusedSessionConnector().sessionId() !== '') return\n  void rekeyToSession(String(id), { landing: true })\n})"),
  )
  const chat = readFileSync(join(ROOT, 'src/screens/Chat.tsx'), 'utf8').replace(/\r\n/g, '\n')
  check("the screen's own landing is the one mover of a page under a born session's id: Chat's re-key effect calls the landing re-key, and the migration has that one caller", chat.includes("pendingInput.rekeyToSession(focusedSessionId === '' ? null : focusedSessionId, { landing })") && (store.match(/migrateOrphanedDraft\(/g) ?? []).length === 1)
}

console.log(`\nprove-landing-keeps-typed-words: ${checks} checks, ${failures} failed`)
try {
  removeScratch(SCRATCH)
} catch (error) {
  console.log(`  scratch left at ${SCRATCH}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
}
process.exit(failures === 0 ? 0 : 1)
