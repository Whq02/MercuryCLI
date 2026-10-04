#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'clipboard-fixture-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_CLIPBOARD_FILE
delete process.env.TMUX
delete process.env.SSH_CONNECTION

const SHIM_DIR = join(SCRATCH, 'bin')
const SHIM_LOG = join(SCRATCH, 'shim-calls.log')
mkdirSync(SHIM_DIR, { recursive: true })
for (const exe of ['pbcopy', 'wl-copy', 'xclip', 'xsel', 'clip']) {
  const shim = join(SHIM_DIR, exe)
  writeFileSync(shim, `#!/bin/sh\nprintf '%s:' "${exe}" >> "${SHIM_LOG}"\ncat >> "${SHIM_LOG}"\nprintf '\\n' >> "${SHIM_LOG}"\nexit 0\n`)
  chmodSync(shim, 0o755)
}
process.env.PATH = `${SHIM_DIR}:${process.env.PATH ?? ''}`

const { setClipboardWithReceipt, subscribeClipboardReceipts } = await import('../../src/ink/termio/osc.ts')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const shimLog = (): string => (existsSync(SHIM_LOG) ? readFileSync(SHIM_LOG, 'utf8') : '')
const published: string[] = []
const unsubscribe = subscribeClipboardReceipts(receipt => published.push(receipt.settled.join('+') || 'unsettled'))

section('§1 the knob unset: a copy goes down the old road (the native utility on PATH records the call)')
const UNSET_TEXT = `clipboard-fixture unset ${process.pid}`
const real = await setClipboardWithReceipt(UNSET_TEXT)
const nativeRoute = process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip.exe' : 'wl-copy'
check(`the native utility was called with the text (${nativeRoute} on PATH is the recording shim)`, shimLog().includes(UNSET_TEXT), shimLog().slice(-120))
check('the receipt settles on the native route, OSC 52 emitted, a non-empty sequence', real.settled.includes(nativeRoute as never) && real.osc52Emitted === true && real.sequence.length > 0 && real.confirmation.startsWith('copied ('), JSON.stringify(real))
check('the settlement reached the listeners', published.length === 1 && published[0] === real.settled.join('+'), JSON.stringify(published))

section('§2 the knob set: the copy lands in the file, the native utility is never called, nothing is offered to the terminal')
const FAKE = join(SCRATCH, 'clipboard.txt')
process.env.MERCURY_CLIPBOARD_FILE = FAKE
const before = shimLog()
const SET_TEXT = `clipboard-fixture set ${process.pid}\nsecond line`
const faked = await setClipboardWithReceipt(SET_TEXT)
check('the file holds exactly the copied text', existsSync(FAKE) && readFileSync(FAKE, 'utf8') === SET_TEXT, existsSync(FAKE) ? readFileSync(FAKE, 'utf8').slice(0, 80) : 'no file')
check('the native utility was NOT called (the shim log did not grow)', shimLog() === before && !shimLog().includes(SET_TEXT), shimLog().slice(-120))
check("the receipt settles on route 'file' with an empty sequence and no OSC 52", JSON.stringify(faked.settled) === JSON.stringify(['file']) && faked.sequence === '' && faked.osc52Emitted === false && faked.confirmation === 'copied (file)', JSON.stringify(faked))
check('the settlement still reaches the listeners (the toast correction logic sees a settled copy)', published.length === 2 && published[1] === 'file', JSON.stringify(published))
const SECOND = 'clipboard-fixture overwrite'
await setClipboardWithReceipt(SECOND)
check('a later copy replaces the file (a clipboard holds one item)', readFileSync(FAKE, 'utf8') === SECOND)

section('§3 the knob names an unwritable path: the copy settles nowhere and still never reaches the real clipboard')
process.env.MERCURY_CLIPBOARD_FILE = join(SCRATCH, 'missing-dir', 'clipboard.txt')
const broken = await setClipboardWithReceipt('clipboard-fixture broken')
check('no settled route, no sequence, no native call', broken.settled.length === 0 && broken.sequence === '' && broken.osc52Emitted === false && !shimLog().includes('clipboard-fixture broken'), JSON.stringify(broken))
process.env.MERCURY_CLIPBOARD_FILE = FAKE
unsubscribe()

section('§4 the seam is registered and every capture road sets it')
const spec = getFlagSpec('MERCURY_CLIPBOARD_FILE')
check('MERCURY_CLIPBOARD_FILE is a registered value flag consumed by src/utils/clipboardFile.ts', spec?.kind === 'value' && spec.consumer === 'src/utils/clipboardFile.ts', JSON.stringify(spec ?? null))
const vshot = readFileSync(join(ROOT, 'scripts', 'ui', 'vshot.py'), 'utf8')
const setdefault = vshot.indexOf('os.environ.setdefault("MERCURY_CLIPBOARD_FILE", out + ".clipboard")')
check('vshot.py gives every pty capture a clipboard file beside its grid before the child becomes the product', setdefault >= 0 && setdefault < vshot.indexOf('os.execvp(argv[0], argv)'))
const harness = readFileSync(join(ROOT, 'scripts', 'lib', 'settingsPopupHarness.ts'), 'utf8')
check('the in-process mount harness points the copy road at a file under the scratch home', harness.includes("process.env.MERCURY_CLIPBOARD_FILE = join(home, 'clipboard.txt')"))
const journeys = readFileSync(join(ROOT, 'scripts', 'interaction', 'prove-exit-copy-journeys.ts'), 'utf8')
check('the drag-copy journeys read the capture\'s clipboard file and never the machine\'s clipboard', journeys.includes(".clipboard") && !journeys.includes('pbpaste'))

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-clipboard-fixture — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
