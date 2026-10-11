import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const home = mkdtempSync(join(tmpdir(), 'cron-delete-row-'))
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
const ui = await import('../../src/tools/ScheduleCronTool/UI.tsx')
const { CronDeleteTool } = await import('../../src/tools/ScheduleCronTool/CronDeleteTool.ts')
const bridge = await import('../../src/services/saturn/sessionScheduleBridge.ts')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`) }
const j = (v: unknown): string => JSON.stringify(v)

const paint = async (node: React.ReactNode, columns = 80): Promise<string> => {
  const stdout = Object.assign(new Writable({ write(_chunk, _enc, cb) { cb() } }), { columns, rows: 20, isTTY: false }) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const instance = await render(React.createElement(AppStateProvider, { initialState: getDefaultAppState(), children: node }), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  instance.unmount()
  await instance.waitUntilExit()
  return instance.lastFrame().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\s+$/, '')
}
const lines = (frame: string): string[] => frame.split('\n').map(line => line.trimEnd()).filter(line => line !== '')

try {
  console.log('── the delete row ──')
  check('the delete header is the id', ui.renderDeleteToolUseMessage({ id: '9601f5ff' }) === '9601f5ff')
  check('the delete header without an id is empty', ui.renderDeleteToolUseMessage({}) === '' && ui.renderDeleteToolUseMessage() === '')
  const deleted = await paint(ui.renderDeleteResultMessage({ id: '9601f5ff', note: 'n' }))
  check('the delete result is one row naming the id', lines(deleted).length === 1 && deleted.includes('Cancel submitted for 9601f5ff'), deleted)
  const block = CronDeleteTool.mapToolResultToToolResultBlockParam!({ id: '9601f5ff', note: 'The note.' }, 'toolu_1')
  check('the model text names the schedule and carries the note', (block as { content: string }).content === 'Cancel submitted for schedule 9601f5ff. The note.', j(block))

  console.log('── the list row ──')
  check('the list header is empty', ui.renderListToolUseMessage() === '')
  const noRoster = await paint(ui.renderListResultMessage({ rosterKnown: false } as never))
  check('no roster yet', lines(noRoster).length === 1 && noRoster.includes('No roster yet'), noRoster)
  const empty = await paint(ui.renderListResultMessage({ rosterKnown: true, schedules: [] } as never))
  check('a known empty roster', lines(empty).length === 1 && empty.includes('No schedules'), empty)
  const rows = await paint(ui.renderListResultMessage({ rosterKnown: true, schedules: [{ id: '9601f5ff', title: 'morning brief', when: 'Weekdays at 9:00 AM' }, { id: 'abcdef01', when: 'once at Wed 7 Oct 2026 16:03 BST' }] } as never), 120)
  const painted = lines(rows)
  check('each schedule is one row: the id, the title when any, the spelling', painted.length === 2 && painted[0]?.includes('9601f5ff · morning brief Weekdays at 9:00 AM') === true && painted[1]?.includes('abcdef01 once at Wed 7 Oct 2026 16:03 BST') === true, j(painted))

  console.log('── the delete validation ladder ──')
  bridge._resetScheduleBridgeForTesting?.()
  const shape = await CronDeleteTool.validateInput!({ id: 'not-an-id' } as never, {} as never)
  check('an id that is not eight hex characters is refused with code 1', shape.result === false && shape.errorCode === 1 && shape.message?.includes('eight hex characters') === true, j(shape))
  const unknownRoster = await CronDeleteTool.validateInput!({ id: 'deadbeef' } as never, {} as never)
  check('with no roster yet a well-formed id is accepted', unknownRoster.result === true, j(unknownRoster))
  bridge.latchSessionScheduleRoster([{ id: '9601f5ff', when: { kind: 'every', cron: '0 9 * * 1-5', spelling: 'Weekdays at 9:00 AM' }, kind: 'fire' } as never])
  const absent = await CronDeleteTool.validateInput!({ id: 'deadbeef' } as never, {} as never)
  check('an id missing from a known roster is refused with code 2 and names it', absent.result === false && absent.errorCode === 2 && absent.message === "No schedule 'deadbeef' on the daemon's latest roster — CronList shows what stands.", j(absent))
  const present = await CronDeleteTool.validateInput!({ id: '9601f5ff' } as never, {} as never)
  check('an id on the roster is accepted', present.result === true, j(present))
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`cron delete and list rows: ${failures} failures`)
process.exitCode = failures ? 1 : 0
