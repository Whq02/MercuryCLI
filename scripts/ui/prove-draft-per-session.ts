#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'draft-rekey-')))
mkdirSync(join(SCRATCH, 'home'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('§1 the owners (REPL swap · PromptInput cursor · owner-keyed persistence)')
const repl = readFileSync('src/screens/REPL.tsx', 'utf8')
check(
  'the REPL hop effect owns the swap, mount-skip guarded',
  repl.includes('rekeyedSessionRef.current !== focusedSessionId') &&
    repl.includes("pendingInput.rekeyToSession(focusedSessionId === '' ? null : focusedSessionId)"),
)
const prompt = readFileSync('src/components/PromptInput/PromptInput.tsx', 'utf8')
check(
  "PromptInput's cursor re-key is the boot-seed promoted (ref-guarded)",
  prompt.includes('cursorSessionRef.current === focusedId') && prompt.includes('pendingInput.readDraftFor(focusedId)'),
)
const store = readFileSync('src/input-core/pending-input.ts', 'utf8')
check(
  'persist AND submit-delete key by the OWNING session (the bootstrap id does not follow the slot)',
  (store.match(/owningSessionId \?\? getSessionId\(\)/g) ?? []).length === 2,
)
const rekeyBody = store.slice(store.indexOf('export async function rekeyToSession'), store.indexOf('export function registerInterceptors'))
check('the restore bypasses the edit chokepoint (a restore is not a keystroke)', rekeyBody.length > 0 && !/\bedit\(/.test(rekeyBody))
check('…and the typing-wins fence is the landed editSeq rule', rekeyBody.includes('if (editSeq !== fence) return'))

console.log('\n§2 the six teeth (real store · real per-session disk layer)')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const p = await import('../../src/input-core/pending-input.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')

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

p.setStash({ text: 'the pocket', cursorOffset: 0, pastedContents: {} })
await p.rekeyToSession('session-A')
check("(e) the stash survives the hop (operator-scoped, named in the docblock)", p.stashedPrompt()?.text === 'the pocket')
check('…and the docblock names the deliberate pocket', store.includes('the OPERATOR\'s pocket, not the session\'s page'))

await p.rekeyToSession('session-C')
p.edit('to send')
p.clearForSubmit('to send')
await p.rekeyToSession('session-A')
await p.rekeyToSession('session-C')
check('(f) a submitted prompt never resurrects across hops', p.text() === '', `text=${JSON.stringify(p.text())}`)

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-draft-per-session: ALL LAWS HOLD' : `\nprove-draft-per-session: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
