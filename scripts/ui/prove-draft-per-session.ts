#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'draft-rekey-')))
mkdirSync(join(SCRATCH, 'home'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')

let failures = 0
const DRAFT_STORE_HINT = 'fix rekeyToSession, flushDrafts or readDraftFor in src/screen/composer/input-core/pending-input.ts so each session keeps its own draft'
const check = (label: string, cond: boolean, detail = '', hint = DRAFT_STORE_HINT): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : ` — ${hint}`}`)
}


console.log('\n§2 the six teeth (real store · real per-session disk layer)')
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const p = await import('../../src/screen/composer/input-core/pending-input.ts')
const { getSessionId } = await import('../../src/boot/process-state/processState.ts')

p.resetPendingInputForTests()
p.initSession('session-A', '')
p.edit('half-typed for A')
p.reportCursor(5)

await p.rekeyToSession('session-B')
check("(a) the hop shows the target's draft, never A's words", p.text() === '', `text=${JSON.stringify(p.text())}`)
check("(b) the flush landed A's words in A's OWN disk entry", p.readDraftFor('session-A')?.text === 'half-typed for A')
check(
  "(b-owner) …keyed by the OWNER, not the bootstrap identity",
  p.readDraftFor(getSessionId())?.text !== 'half-typed for A' || getSessionId() === ('session-A' as never),
)

await p.rekeyToSession('session-A')
check('(c) the hop back returns the words', p.text() === 'half-typed for A')
p.edit('half-typed for A!')
await p.flushDrafts()
check('(c) …with the durable cursor restored (persisted beside the next keystroke)', p.readDraftFor('session-A')?.cursorOffset === 5, `cursor=${p.readDraftFor('session-A')?.cursorOffset}`)

const swap = p.rekeyToSession('session-B')
p.edit('typed during swap')
await swap
check('(d) typing during the swap wins (the re-key never rolls it back)', p.text() === 'typed during swap')

p.setStash({ text: 'the pocket', cursorOffset: 0, mode: 'prompt', pastedContents: {} })
await p.rekeyToSession('session-A')
check("(e) the stash survives the hop (operator-scoped, named in the docblock)", p.stashedPrompt()?.text === 'the pocket')

await p.rekeyToSession('session-C')
p.edit('to send')
p.clearForSubmit('to send')
await p.rekeyToSession('session-A')
await p.rekeyToSession('session-C')
check('(f) a submitted prompt never resurrects across hops', p.text() === '', `text=${JSON.stringify(p.text())}`)

p.resetPendingInputForTests()
p.initSession(null, '')
p.edit('/model')
await p.rekeyToSession('session-born', { landing: true })
check('(g) a landing keeps the words typed while it landed', p.text() === '/model', `text=${JSON.stringify(p.text())}`)
p.edit('page for D')
await p.flushDrafts()
await p.rekeyToSession(null)
p.edit('typed on the resting slot')
await p.rekeyToSession('session-born', { landing: true })
check("(h) a landing into a session with its own saved page restores the page", p.text() === 'page for D', `text=${JSON.stringify(p.text())}`)

console.log('\n§3 the owner of the swap, read off the mounted session part of the chat screen')
{
  const { sessionRekeys } = await import('./chatScenarios.ts')
  const rekeys = await sessionRekeys('draft-per-session')
  check('the Chat hop effect owns the swap, mount-skip guarded', rekeys.atMount === '' && rekeys.hop.startsWith('draft draft-per-session-b landing=false') && rekeys.again === '', `at mount "${rekeys.atMount}" · on a hop "${rekeys.hop}" · on the next render "${rekeys.again}"`, 'the chat screen session part must re-key the draft once on a session hop and not at mount or on the next render; sessionRekeys in scripts/ui/chatScenarios.ts shows which part it mounts')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-draft-per-session: ALL LAWS HOLD' : `\nprove-draft-per-session: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
