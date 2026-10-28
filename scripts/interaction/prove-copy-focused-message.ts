#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'copy-focused-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_CLIPBOARD_FILE
delete process.env.TMUX
delete process.env.STY
delete process.env.SSH_CONNECTION

import type { Key } from '../../src/ink/events/input-event.ts'
const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
const { parseBindings } = await import('../../src/keybindings/parser.ts')
const { resolveKeyWithChordState } = await import('../../src/keybindings/resolver.ts')
const { MESSAGE_ACTIONS, copyTextOf, isNavigableMessage } = await import('../../src/components/messageActions.tsx')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')
const { setClipboardWithReceipt } = await import('../../src/ink/termio/osc.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const KEY = (over: Partial<Key> = {}): Key =>
  ({ ctrl: false, meta: false, shift: false, super: false, escape: false, return: false, tab: false, backspace: false, delete: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageUp: false, pageDown: false, wheelUp: false, wheelDown: false, home: false, end: false, ...over }) as Key

const bindings = parseBindings(DEFAULT_BINDINGS)
type Ctx = Parameters<typeof resolveKeyWithChordState>[2]
const chord = (contexts: Ctx) => {
  const first = resolveKeyWithChordState('x', KEY({ ctrl: true }), contexts, bindings, null)
  const pending = first.type === 'chord_started' ? first.pending : null
  const second = resolveKeyWithChordState('y', KEY(), contexts, bindings, pending)
  return { first, second }
}

section('§1 one chord, two owners: ctrl+x y runs /copy from the composer and copies the focused message while a cursor stands')
{
  const composer = chord(['Chat', 'Global'])
  check('ctrl+x opens the chord in the composer', composer.first.type === 'chord_started', composer.first.type)
  check('y completes it to command:copy', composer.second.type === 'match' && composer.second.action === 'command:copy', JSON.stringify(composer.second))
  const cursor = chord(['Chat', 'Global', 'MessageActions'])
  check('with a message cursor standing, y completes it to messageActions:c (the focused message copies)', cursor.second.type === 'match' && cursor.second.action === 'messageActions:c', JSON.stringify(cursor.second))
  const open = resolveKeyWithChordState('', KEY({ shift: true, upArrow: true }), ['Chat', 'Global'], bindings, null)
  check('shift+up is the existing road into the message cursor (chat:messageActions)', open.type === 'match' && open.action === 'chat:messageActions', JSON.stringify(open))
  const plain = resolveKeyWithChordState('c', KEY(), ['Chat', 'Global', 'MessageActions'], bindings, null)
  check('the plain c key still copies in the cursor (unchanged)', plain.type === 'match' && plain.action === 'messageActions:c', JSON.stringify(plain))
}

section('§2 the focused message copies its own text, intact')
const ARABIC = 'السلام عليكم 🙏\n\nسطر ثانٍ، ثم فراغ\n\nمع التحية 🌿'
const raw = {
  type: 'assistant',
  uuid: 'a-1',
  timestamp: new Date().toISOString(),
  message: { id: 'msg_a', role: 'assistant', type: 'message', content: [{ type: 'thinking', thinking: 'never copied' }, { type: 'text', text: ARABIC }, { type: 'text', text: 'second block' }], usage: {}, model: 'fixture', stop_reason: null, stop_sequence: null },
} as never
const rows = normalizeMessages([raw])
check('a three-block message paints as three rows (one block each)', rows.length === 3, String(rows.length))
check('the thinking row is not navigable, the text rows are', !isNavigableMessage(rows[0] as never) && isNavigableMessage(rows[1] as never) && isNavigableMessage(rows[2] as never))
const copyAction = MESSAGE_ACTIONS.find(action => action.key === 'c')
check("the cursor's copy action applies to every navigable type", copyAction !== undefined && copyAction.types.includes('assistant') && copyAction.types.includes('user'))
let handed: string | null = null
await copyAction?.run(rows[1] as never, { copy: (text: string) => { handed = text }, edit: async () => {} })
check('running it on the focused Arabic row hands the row text to the clipboard road byte-for-byte', handed === ARABIC, JSON.stringify(handed).slice(0, 80))
check('copyTextOf the second text row is that block alone', copyTextOf(rows[2] as never) === 'second block')
check('no finer focus than a row exists (no code-block action in the table): /copy code is the road for a block', !MESSAGE_ACTIONS.some(action => /code|block/i.test(action.label({ uuid: 'x', type: 'assistant', expanded: false }))))

if (process.platform === 'darwin') {
  section('§3 the cursor copy road on this Mac delivers the row byte-identical')
  const utf8 = { ...process.env, LC_ALL: 'en_US.UTF-8' }
  const pbpaste = (): Buffer => execFileSync('pbpaste', [], { env: utf8 })
  const held = pbpaste()
  try {
    const receipt = await setClipboardWithReceipt(handed ?? '')
    check('the receipt settled on pbcopy', receipt.settled.includes('pbcopy'), JSON.stringify(receipt.settled))
    check('pbpaste returns the Arabic row exactly', pbpaste().equals(Buffer.from(ARABIC, 'utf8')), pbpaste().toString('utf8').slice(0, 60))
  } finally {
    execFileSync('pbcopy', [], { env: utf8, input: held })
    check('the clipboard holds what it held before the proof', pbpaste().equals(held))
  }
} else {
  console.log('  (skip) the real clipboard section runs on macOS only')
}

console.log(failures === 0 ? '\n✅ prove-copy-focused-message GREEN' : `\n❌ prove-copy-focused-message RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
