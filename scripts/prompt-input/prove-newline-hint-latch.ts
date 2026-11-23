#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


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

const caps = await import('../../src/screen/renderer/terminal-session/capabilities.ts')
const { getNewlineInstructions } = await import('../../src/screen/composer/composerConfig.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

const hintLatchState = ' | extendedKeysSupportedNow and upgradeExtendedKeysSupport in src/screen/renderer/terminal-session/capabilities.ts own the latch'
const hintNewlineText = ' | getNewlineInstructions in src/screen/composer/composerConfig.ts must pick its text from extendedKeysSupportedNow()'

check('this world declares no extended keys (the sniff list is silent)', caps.extendedKeysSupportedNow() === false, 'the latch started up; the env set at the top of this file (TERM_PROGRAM, TERM, TMUX, WT_SESSION) must leave the sniff list silent' + hintLatchState)
check('latch down ⇒ the backslash form', getNewlineInstructions() === 'backslash (\\) + ↵ for a new line', getNewlineInstructions() + hintNewlineText)

let heard = 0
const off = caps.subscribeExtendedKeysSupport(() => {
  heard++
})
caps.upgradeExtendedKeysSupport()
check('the probe reply upgrades the latch', caps.extendedKeysSupportedNow() && caps.extendedKeysProvedNow(), 'upgradeExtendedKeysSupport must raise both extendedKeysSupportedNow and extendedKeysProvedNow' + hintLatchState)
check('the upgrade notified its subscriber once', heard === 1, `heard ${heard}` + ' | upgradeExtendedKeysSupport must notify each subscribeExtendedKeysSupport listener once' + hintLatchState)
check('latch up ⇒ shift + ↵ (the chord the pushed protocol delivers)', getNewlineInstructions() === 'shift + ↵ for a new line', getNewlineInstructions() + hintNewlineText)
caps.upgradeExtendedKeysSupport()
check('a repeated upgrade is silent (nothing changed)', heard === 1, `heard ${heard}` + ' | upgradeExtendedKeysSupport must not notify when the latch is already up' + hintLatchState)
off()


rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ the newline hint follows the latch' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
