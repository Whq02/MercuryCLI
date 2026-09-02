#!/usr/bin/env bun
// ============================================================================
//  prove-newline-hint-latch — the composer's newline hint names the chord
//  that works on THIS terminal.
//
//  The raw-mode arm pushes the kitty keyboard protocol + modifyOtherKeys on
//  the extended-keys latch, and the composer decodes shift+↵ from both
//  encodings — yet the hint advertised `backslash (\) + ↵` on every terminal
//  outside the macOS system terminal / the installed-binding case, kitty-
//  proved ones included. Laws:
//    · the hint reads the latch: down ⇒ backslash form, up ⇒ shift + ↵;
//    · the latch upgrade notifies subscribers exactly once per change, so a
//      probe reply landing after the footer's first paint flips the row in
//      place (the footer subscribes through useSyncExternalStore).
//
//  Run: ~/.bun/bin/bun run scripts/prompt-input/prove-newline-hint-latch.ts
// ============================================================================
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')

// A fresh home (no hasUsedBackslashReturn, no installed binding) and a
// terminal identity outside the declared extended-keys list, pinned BEFORE
// any src import so the sniff and the config read see exactly this world.
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-newline-hint-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.TERM_PROGRAM = ''
process.env.TERM = 'xterm-256color'
delete process.env.TMUX
delete process.env.WT_SESSION

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' newline hint — follows the extended-keys latch')
console.log('============================================================')

const caps = await import('../../src/ink/session/capabilities.ts')
const { getNewlineInstructions } = await import('../../src/components/PromptInput/utils.ts')
// The hint reads the global config (hasUsedBackslashReturn, the installed
// binding); the config gate must be armed before any real read.
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

check('this world declares no extended keys (the sniff list is silent)', caps.extendedKeysSupportedNow() === false)
check('latch down ⇒ the backslash form', getNewlineInstructions() === 'backslash (\\) + ↵ for a new line', getNewlineInstructions())

let heard = 0
const off = caps.subscribeExtendedKeysSupport(() => {
  heard++
})
caps.upgradeExtendedKeysSupport()
check('the probe reply upgrades the latch', caps.extendedKeysSupportedNow() && caps.extendedKeysProvedNow())
check('the upgrade notified its subscriber once', heard === 1, `heard ${heard}`)
check('latch up ⇒ shift + ↵ (the chord the pushed protocol delivers)', getNewlineInstructions() === 'shift + ↵ for a new line', getNewlineInstructions())
caps.upgradeExtendedKeysSupport()
check('a repeated upgrade is silent (nothing changed)', heard === 1, `heard ${heard}`)
off()

const footer = readFileSync(join(REPO, 'src/components/PromptInput/PromptInputFooter.tsx'), 'utf8')
check(
  'the composer footer subscribes to the latch (a late probe reply flips the row in place)',
  footer.includes('useSyncExternalStore(subscribeExtendedKeysSupport, extendedKeysSupportedNow, extendedKeysSupportedNow)'),
)
const utils = readFileSync(join(REPO, 'src/components/PromptInput/utils.ts'), 'utf8')
check('the hint reads the SAME latch the raw-mode arm pushes on', utils.includes('extendedKeysSupportedNow()'))

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ the newline hint follows the latch' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
