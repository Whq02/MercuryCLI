import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'keysetup-safety-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.VSCODE_GIT_ASKPASS_MAIN
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const os = await import('node:os')
mock.module('node:os', () => ({ ...os, homedir: () => home }))
const fs = await import('node:fs/promises')
const read = fs.readFile
const copy = fs.copyFile
let unreadable: string | null = null
let uncopyable: string | null = null
mock.module('node:fs/promises', () => ({
  ...fs,
  readFile: (...args: Parameters<typeof read>) => String(args[0]) === unreadable
    ? Promise.reject(Object.assign(new Error('fixture read refused'), { code: 'EACCES' }))
    : read(...args),
  copyFile: (...args: Parameters<typeof copy>) => String(args[0]) === uncopyable
    ? Promise.reject(Object.assign(new Error('fixture backup refused'), { code: 'EACCES' }))
    : copy(...args),
}))
const exec = await import('../../src/utils/execFileNoThrow.ts')
const calls: string[][] = []
let failBell = false
mock.module('../../src/utils/execFileNoThrow.ts', () => ({
  ...exec,
  execFileNoThrow: async (file: string, args: string[]) => {
    calls.push([file, ...args])
    if (file === 'defaults' && args[0] === 'read') return { code: 0, stdout: 'Basic', stderr: '' }
    if (file.endsWith('PlistBuddy')) return { code: failBell && args[1]!.includes(':Bell') ? 1 : 0, stdout: '', stderr: '' }
    if (file === 'defaults' && args[0] === 'import') return { code: 0, stdout: '', stderr: '' }
    if (file === 'killall') return { code: 0, stdout: '', stderr: '' }
    throw new Error('unexpected subprocess in keysetup proof')
  },
}))
let completed = 0
mock.module('../../src/utils/appleTerminalBackup.ts', () => ({
  backupTerminalPreferences: async () => join(home, 'terminal.bak'),
  getTerminalPlistPath: () => join(home, 'terminal.plist'),
  markTerminalSetupComplete: () => { completed++ },
}))
const { env } = await import('../../src/utils/env.ts')
const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()
const { setupTerminal } = await import('../../src/commands/keysetup/keysetup.tsx')
const vscode = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Code', 'User', 'keybindings.json') : process.platform === 'win32' ? join(home, 'AppData', 'Roaming', 'Code', 'User', 'keybindings.json') : join(home, '.config', 'Code', 'User', 'keybindings.json')
const zed = join(home, '.config', 'zed', 'keymap.json')
process.env.XDG_CONFIG_HOME = join(home, '.config')
const alacritty = join(home, '.config', 'alacritty', 'alacritty.toml')
const failures: string[] = []
async function check(label: string, body: () => Promise<void>): Promise<void> {
  try { await body(); console.log('PASS ' + label) } catch (error) { failures.push(label); console.error('FAIL ' + label + ': ' + String(error)) }
}
function reset(terminal: string): void {
  env.terminal = terminal
  saveGlobalConfig(current => ({ ...current, shiftEnterKeyBindingInstalled: false, optionAsMetaKeyInstalled: false }))
}
function seed(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
try {
  for (const [terminal, path] of [['vscode', vscode], ['zed', zed], ['alacritty', alacritty]] as const) {
    await check(`${terminal}: an unreadable existing file is never replaced or marked installed`, async () => {
      reset(terminal)
      const original = terminal === 'alacritty' ? '[window]\nopacity = 0.9\n' : '[{"key":"ctrl+k","command":"keep-me"}]'
      seed(path, original)
      unreadable = path
      try { await assert.rejects(setupTerminal('dark')) } finally { unreadable = null }
      assert.equal(readFileSync(path, 'utf8'), original)
      assert.equal(getGlobalConfig().shiftEnterKeyBindingInstalled, false)
    })
  }
  for (const [terminal, path] of [['vscode', vscode], ['zed', zed]] as const) {
    for (const original of ['[{"keep":', '{"keep":"not an array"}']) {
      await check(`${terminal}: malformed or non-array JSONC stays intact`, async () => {
        reset(terminal)
        seed(path, original)
        await assert.rejects(setupTerminal('dark'))
        assert.equal(readFileSync(path, 'utf8'), original)
        assert.equal(getGlobalConfig().shiftEnterKeyBindingInstalled, false)
      })
    }
    await check(`${terminal}: a valid array keeps existing bindings and records success`, async () => {
      reset(terminal)
      seed(path, '[{"key":"ctrl+k","command":"keep-me"}]')
      await setupTerminal('dark')
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(parsed.length, 2)
      assert.equal(parsed[0].command, 'keep-me')
      assert.equal(getGlobalConfig().shiftEnterKeyBindingInstalled, true)
    })
  }
  await check('a remote editor refusal does not suppress the setup offer', async () => {
    reset('vscode')
    process.env.VSCODE_GIT_ASKPASS_MAIN = '/fixture/.vscode-server/askpass.js'
    try {
      assert.match(await setupTerminal('dark'), /cannot be installed from a remote session/)
      assert.equal(getGlobalConfig().shiftEnterKeyBindingInstalled, false)
    } finally { delete process.env.VSCODE_GIT_ASKPASS_MAIN }
  })
  await check('a refused backup does not mark a binding installed', async () => {
    reset('zed')
    seed(zed, '[]')
    uncopyable = zed
    try {
      assert.match(await setupTerminal('dark'), /nothing was written/)
      assert.equal(getGlobalConfig().shiftEnterKeyBindingInstalled, false)
      assert.equal(readFileSync(zed, 'utf8'), '[]')
    } finally { uncopyable = null }
  })
  await check('partial Apple Terminal setup restores preferences and does not claim success', async () => {
    reset('Apple_Terminal')
    calls.length = 0
    completed = 0
    failBell = true
    await assert.rejects(setupTerminal('dark'), /preferences were restored from backup/)
    assert(calls.some(call => call[0] === 'defaults' && call[1] === 'import'))
    assert.equal(completed, 1, 'a successful rollback clears the pending backup instead of repeating it on the next boot')
    assert.equal(getGlobalConfig().optionAsMetaKeyInstalled, false)
  })
  await check('complete Apple Terminal setup still records success', async () => {
    reset('Apple_Terminal')
    completed = 0
    failBell = false
    assert.match(await setupTerminal('dark'), /Configured Terminal/)
    assert.equal(completed, 1)
    assert.equal(getGlobalConfig().optionAsMetaKeyInstalled, true)
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures.length ? 1 : 0)
