import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const home = mkdtempSync(join(tmpdir(), 'cron-row-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const React = (await import('react')).default
const { render } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { renderCreateResultMessage, renderCreateToolUseMessage } = await import('../../src/tools/ScheduleCronTool/UI.tsx')
let failures = 0
const check = (label: string, ok: boolean) => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`) }
const frameAt = process.argv.indexOf('--frames')
const framePath = frameAt < 0 ? undefined : process.argv[frameAt + 1]
const captured: string[] = []
const old = { submitted: true, humanSchedule: 'Weekdays at 9:00 AM', recurring: true, title: 'morning brief', note: 'Submitted to the session record' }
try {
  for (const columns of [80, 178]) {
    for (const [name, output, expected] of [
      ['saved', old, 'Schedule "morning brief" submitted (Weekdays at 9:00 AM)'],
      ['scheduled', { ...old, state: 'scheduled', id: '9601f5ff', nextFireLocal: 'Wed 7 Oct 2026 16:03 BST' }, 'Scheduled 9601f5ff "morning brief" (Wed 7 Oct 2026 16:03 BST)'],
      ['queued', { ...old, state: 'queued' }, 'Queued, not confirmed (Weekdays at 9:00 AM)'],
    ] as const) {
      const stdout = Object.assign(new Writable({ write(_chunk, _enc, cb) { cb() } }), { columns, rows: 20, isTTY: false }) as unknown as NodeJS.WriteStream
      const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
      const instance = await render(React.createElement(AppStateProvider, { initialState: getDefaultAppState(), children: renderCreateResultMessage(output) }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
      instance.unmount()
      await instance.waitUntilExit()
      const frame = instance.lastFrame().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      check(`${name} result at ${columns} columns carries its complete certainty and time`, frame.includes(expected))
      captured.push(`${name} ${columns} columns\n${frame}`)
    }
  }
  check('absolute and delay headers name their typed time', renderCreateToolUseMessage({ at: '2026-10-07T18:30', prompt: 'remind' }) === 'at 2026-10-07T18:30: remind' && renderCreateToolUseMessage({ delayMinutes: 10, prompt: 'check' }) === 'in 10 min: check')
  check('saved cron header remains byte-identical', renderCreateToolUseMessage({ cron: '0 9 * * 1-5', prompt: 'brief' }) === '0 9 * * 1-5: brief')
  if (framePath) writeFileSync(framePath, captured.join('\n\n'))
} finally { rmSync(home, { recursive: true, force: true }) }
console.log(`cron create rows: ${failures} failures`)
process.exitCode = failures ? 1 : 0
