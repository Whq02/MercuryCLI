import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { Screen } from '../../src/screen/renderer/cell-grid.js'
import type { WorkRosterV1 } from '../../src/engine/connector/types.js'

const worldArg = process.argv.indexOf('--worlds')
const scratch = mkdtempSync(join(realpathSync(worldArg < 0 ? tmpdir() : process.argv[worldArg + 1]!), 'panel-layers-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
process.env.FORCE_COLOR = '3'
process.env.MERCURY_FULLSCREEN = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const React = await import('react')
const { render, Text } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider, useAppStateStore } = await import('../../src/screen/app-state/AppState.js')
let storeRef: { getState: () => unknown } | null = null
const viewing = (): string | undefined => (storeRef?.getState() as { viewingAgentTaskId?: string } | undefined)?.viewingAgentTaskId
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
const { FullscreenLayout } = await import('../../src/screen/fullscreen-layout/FullscreenLayout.js')
const { CrewView } = await import('../../src/screen/widgets/faces/CrewView.js')
const { BackgroundTasksDialog } = await import('../../src/screen/tasks/BackgroundTasksDialog.js')
const { ShellDetailDialog } = await import('../../src/screen/tasks/ShellDetailDialog.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const { cellAt } = await import('../../src/screen/renderer/cell-grid.js')
const { recessActive } = await import('../../src/screen/renderer/recessLayer.js')
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const roster: WorkRosterV1 = { mission: [], rows: ['first', 'second'].map(id => ({ id, name: `${id} agent`, kind: 'agent', status: 'completed', startTime: 1, endTime: 2 })) }
setFocusedSessionConnector(Object.assign(new NoSessionConnector(), { sessionId: () => 'fixture', workRoster: () => roster }))
let failures = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${!ok && hint ? ` — to fix: ${hint}` : ''}`)
}
const h = React.createElement
const panels = {
  crew: (close: () => void) => h(CrewView, { onClose: close }),
  tasks: (close: () => void) => h(BackgroundTasksDialog, { onDone: close, toolUseContext: {} as never }),
  shell: (close: () => void) => h(ShellDetailDialog, { onDone: close, shell: { command: 'fixture command', status: 'completed', startTime: 1, endTime: 2 } }),
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100))
try {
  for (const [kind, recess] of [['crew', '1'], ['tasks', '1'], ['crew', '0'], ['tasks', '0'], ['shell', '0']] as const) {
    process.env.MERCURY_RECESS = recess
    let closed = false
    let written = ''
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { written += String(chunk); done() } }), { columns: 178, rows: 51, isTTY: true }) as unknown as NodeJS.WriteStream
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
    function Host(): React.ReactNode {
      storeRef = useAppStateStore() as never
      const [open, setOpen] = React.useState(true)
      const close = (): void => { closed = true; setOpen(false) }
      const panel = panels[kind](close)
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
      check(`${kind} recess=${recess}: the backdrop uses the requested policy`, recessActive() === (recess === '1'), '', 'recessActive in src/screen/renderer/recessLayer.ts must follow MERCURY_RECESS while the panel is open under FullscreenLayout (src/screen/fullscreen-layout/FullscreenLayout.tsx)')
      if (kind === 'tasks') {
        check(`${kind} recess=${recess}: the real list paints both fixture rows`, screenText().includes('first agent') && screenText().includes('second agent'), '', 'BackgroundTasksDialog (src/screen/tasks/BackgroundTasksDialog.tsx) must list every row of the focused connector work roster')
        await send('\r')
        check(`${kind} recess=${recess}: Enter on a crewmate row enters its view and the activity screen gives way (the view is the chat's, never a card)`, closed && viewing() === 'first' && !screenText().includes('Activity') && screenText().includes('◉ first agent') && screenText().includes('untouched composer'), screenText(), 'Enter on a row of BackgroundTasksDialog (src/screen/tasks/BackgroundTasksDialog.tsx) must call onDone and set viewingAgentTaskId to that row, leaving the chat and composer on screen')
        check(`${kind} recess=${recess}: dismissal leaves the work roster unchanged`, roster.rows.every(row => row.status === 'completed'), '', 'closing the tasks dialog must not change any work roster row status; look for a stop or kill action fired by the Enter or click path in src/screen/tasks/BackgroundTasksDialog.tsx')
        continue
      }
      if (kind === 'crew') {
        check(`${kind} recess=${recess}: the real list paints both fixture rows`, screenText().includes('first agent') && screenText().includes('second agent'), '', 'CrewView (src/screen/widgets/faces/CrewView.tsx) must list every row of the focused connector work roster')
        await send('\r')
        check(`${kind} recess=${recess}: Enter opens the real work card`, screenText().includes('› first agent'), screenText(), 'Enter on the selected row of CrewView (src/screen/widgets/faces/CrewView.tsx) must open that work card')
        await send('\x1b[<0;1;1M\x1b[<0;1;1m')
        check(`${kind} recess=${recess}: one outside click returns from card to list`, !closed && !screenText().includes('› first agent') && screenText().includes('second agent'), screenText(), 'one outside click on an open work card must return to the CrewView list and keep the panel open; fix the outside-click handling of the card in src/screen/widgets/faces/CrewView.tsx')
      } else {
        check(`${kind} recess=${recess}: the real detail card paints`, screenText().includes('fixture command'), screenText(), 'ShellDetailDialog (src/screen/tasks/ShellDetailDialog.tsx) must paint the shell command it is given')
      }
      await send('\x1b[<0;1;1M\x1b[<0;1;1m')
      check(`${kind} recess=${recess}: the outside click closes the remaining frame`, closed && screenText().includes('untouched composer'), screenText(), 'an outside click must call the panel onClose or onDone and leave the chat and composer painted; fix the outside-click dismissal in the open panel or in FullscreenLayout (src/screen/fullscreen-layout/FullscreenLayout.tsx)')
      check(`${kind} recess=${recess}: dismissal leaves the work roster unchanged`, roster.rows.every(row => row.status === 'completed'), '', 'dismissing a panel must not change any work roster row status; check the dismissal path of the open panel under src/components')
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
