import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { Screen } from '../../src/ink/cell-grid.js'
import type { WorkRosterV1 } from '../../src/services/engine-connector/types.js'

const worldArg = process.argv.indexOf('--worlds')
const scratch = mkdtempSync(join(realpathSync(worldArg < 0 ? tmpdir() : process.argv[worldArg + 1]!), 'panel-layers-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
process.env.FORCE_COLOR = '3'
process.env.MERCURY_FULLSCREEN = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const React = await import('react')
const { render, Text } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.js')
const { CrewView } = await import('../../src/components/mercury-ui/screens/CrewView.js')
const { BackgroundTasksDialog } = await import('../../src/components/tasks/BackgroundTasksDialog.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { default: instances } = await import('../../src/ink/instances.js')
const { cellAt } = await import('../../src/ink/cell-grid.js')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const roster: WorkRosterV1 = { mission: [], rows: ['first', 'second'].map(id => ({ id, name: `${id} agent`, kind: 'agent', status: 'completed', startTime: 1, endTime: 2 })) }
setFocusedSessionConnector(Object.assign(new NoSessionConnector(), { sessionId: () => 'fixture', workRoster: () => roster }))
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const h = React.createElement
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))
try {
  for (const kind of ['crew', 'tasks'] as const) {
    let closed = false
    let written = ''
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { written += String(chunk); done() } }), { columns: 178, rows: 51, isTTY: true }) as unknown as NodeJS.WriteStream
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
    function Host(): React.ReactNode {
      const [open, setOpen] = React.useState(true)
      const close = (): void => { closed = true; setOpen(false) }
      const panel = kind === 'crew' ? h(CrewView, { onClose: close }) : h(BackgroundTasksDialog, { onDone: close, toolUseContext: {} as never })
      return h(FullscreenLayout, { scrollable: h(Text, {}, 'untouched chat'), bottom: h(Text, {}, 'untouched composer'), modal: open ? panel : undefined })
    }
    const instance = await render(h(AppStateProvider, { children: h(KeybindingSetup, { children: h(Host) }) }), { stdout, stdin, stderr: stdout, patchConsole: false, exitOnCtrlC: false })
    const screenText = (): string => {
      const ink = instances.get(stdout) as unknown as { frontFrame: { screen: Screen } } | undefined
      if (!ink) return written
      const screen = ink.frontFrame.screen
      return Array.from({ length: 51 }, (_, row) => Array.from({ length: 178 }, (_, col) => cellAt(screen, col, row)?.char ?? ' ').join('')).join('\n')
    }
    const send = async (data: string): Promise<void> => { (stdin as unknown as Readable).push(data); await settle() }
    try {
      await settle()
      check(`${kind}: the real list paints both fixture rows`, screenText().includes('first agent') && screenText().includes('second agent'))
      await send('\r')
      check(`${kind}: Enter opens the real work card`, screenText().includes('› first agent'), screenText())
      await send('\x1b[<0;1;1M\x1b[<0;1;1m')
      check(`${kind}: one outside click returns from card to list`, !closed && !screenText().includes('› first agent') && screenText().includes('second agent'), screenText())
      await send('\x1b[<0;1;1M\x1b[<0;1;1m')
      check(`${kind}: the next outside click closes only the list`, closed && screenText().includes('untouched composer'), screenText())
      check(`${kind}: dismissal leaves the work roster unchanged`, roster.rows.every(row => row.status === 'completed'))
    } finally {
      instance.unmount()
    }
  }
} finally {
  releaseFocusedSessionConnector()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`panel dismissal layers: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
