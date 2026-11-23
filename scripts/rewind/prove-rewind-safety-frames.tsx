#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { gridToPng } from '../ui/gridToPng.ts'

const outAt = process.argv.indexOf('--out')
const output = outAt < 0 ? mkdtempSync(join(tmpdir(), 'rewind-frames-')) : resolve(process.argv[outAt + 1]!)
mkdirSync(output, { recursive: true })
const home = pinScratchHome('rewind-frames-home')
pinSourceRef()
delete process.env.MERCURY_HOME
const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
const { MessageSelector } = await import('../../src/screen/rewind-picker/RewindPicker.tsx')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
const { createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
type Request = import('../../src/engine/connector/types.ts').RewindRequestV1
type Receipt = import('../../src/engine/connector/types.ts').RewindReceiptV1
const first = createUserMessage({ content: 'Update the greeting' })
const next = createUserMessage({ content: 'Check the result' })
const undo = '00000000-0000-4000-8000-000000000010'
const facts = { capture: 'on' as const, restorable: new Set([first.uuid, next.uuid]), files: ['src/greeting.ts', 'src/greeting.test.ts'], undo }
const requests: Request[] = []
class FixtureConnector extends NoSessionConnector {
  override checkpointFacts() { return facts }
  override async rewind(request: Request): Promise<Receipt> {
    requests.push(request)
    return { outcome: 'applied', mode: request.mode, ...(request.dryRun ? { dryRun: true } : {}), code: { filesChanged: request.filePath ? [request.filePath] : [...facts.files], insertions: 2, deletions: 1 } }
  }
}
const connector = new FixtureConnector()
setFocusedSessionConnector(connector)
let failures = 0
const check = (name: string, ok: boolean, hint?: string): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && hint ? ' - ' + hint : ''}`); if (!ok) failures++ }
async function save(mounted: Mounted, label: string, cols: number, rows: number): Promise<void> {
  const lines = mounted.lines()
  writeFileSync(join(output, `${label}.txt`), lines.join('\n') + '\n')
  const grid = lines.map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => {
    const style = mounted.styleAt(x, y)
    return { c, fg: style?.fg.replace(/^#/, '') ?? 'default', bg: style?.bg.replace(/^#/, '') ?? 'default', bold: style?.bold ?? false, rev: style?.inverse ?? false }
  }))
  const json = join(output, `${label}.json`)
  writeFileSync(json, JSON.stringify({ cols, rows, grid }))
  await gridToPng(json, join(output, `${label}.png`))
  console.log(join(output, `${label}.png`))
}
try {
  let ownerClosed = 0
  let hiddenClosed = 0
  let ownerRestored = 0
  const duplicate = <AppStateProvider><ThemeProvider><KeybindingSetup><Box width={80} height={24} flexDirection="column">
    <MessageSelector messages={[first, next]} preselectedMessage={first} onPreRestore={() => {}} onClose={() => { ownerClosed++ }} onSummarize={() => {}} onRestore={async () => { ownerRestored++; return { outcome: 'applied', mode: 'conversation' } }} />
    <MessageSelector messages={[first, next]} preselectedMessage={first} onPreRestore={() => {}} onClose={() => { hiddenClosed++ }} onSummarize={() => {}} onRestore={async () => ({ outcome: 'applied', mode: 'conversation' })} />
  </Box></KeybindingSetup></ThemeProvider></AppStateProvider>
  const duplicated = await mountOffscreen(duplicate, 80, 24, { mouseTracking: true })
  try {
    check('the owner paints confirmation', await waitFor(() => duplicated.screen().includes('Restore code and conversation'), 3000), 'the confirmation view never painted; check the confirm phase of MessageSelector in src/screen/rewind-picker/RewindPicker.tsx and src/screen/rewind-picker/views.tsx')
    await settle(100)
    check('only the visible selector asks for a restore preview', requests.filter(request => request.dryRun).length === 1, 'the preview rewind (dryRun) should be sent by one selector only; check the claimed gate in the useLoad of MessageSelector in src/screen/rewind-picker/RewindPicker.tsx')
    duplicated.push(KEY.enter)
    await settle(100)
    check('only the visible selector handles confirmation', ownerRestored === 1 && ownerClosed === 1 && hiddenClosed === 0, 'Enter should reach only the claiming selector (restored ' + ownerRestored + ', owner closed ' + ownerClosed + ', hidden closed ' + hiddenClosed + '); check the claimed gate in src/screen/rewind-picker/RewindPicker.tsx')
  } finally { duplicated.unmount(); await settle(50) }
  for (const [cols, rows] of [[80, 24], [120, 40]] as const) {
    let closed = false
    const element = <AppStateProvider><ThemeProvider><KeybindingSetup><Box width={cols} height={rows} flexDirection="column">
      <MessageSelector messages={[first, next]} onPreRestore={() => {}} onClose={() => { closed = true }} onSummarize={() => {}}
        onRestore={(message, mode, files) => connector.rewind({ userMessageId: message?.uuid ?? files?.userMessageId ?? '', mode, ...files })} />
    </Box></KeybindingSetup></ThemeProvider></AppStateProvider>
    const mounted = await mountOffscreen(element, cols, rows, { mouseTracking: true })
    try {
      check(`${cols}×${rows} undo row paints`, await waitFor(() => mounted.screen().includes('Undo the rewind'), 3000), 'the Undo the rewind row did not paint; check src/screen/rewind-picker/views.tsx and the undo checkpoint from checkpointFacts')
      mounted.push(KEY.up)
      check(`${cols}×${rows} undo row takes keyboard focus`, await waitFor(() => mounted.lines().some(line => /[❯›>] Undo the rewind/.test(line)), 3000), 'the Up key did not focus the undo row; check the focus handling in src/screen/rewind-picker/RewindPicker.tsx and the row in src/screen/rewind-picker/views.tsx')
      await save(mounted, `undo-${cols}x${rows}`, cols, rows)
      mounted.push(KEY.enter)
      check(`${cols}×${rows} undo row dispatches the exact undo checkpoint`, await waitFor(() => closed && requests.some(request => request.undo && request.userMessageId === undo), 3000), 'Enter on the undo row did not close the selector and send a rewind with undo set to the fixture checkpoint; check the undo dispatch in src/screen/rewind-picker/RewindPicker.tsx')
    } finally { mounted.unmount(); await settle(50) }

    closed = false
    const confirm = <AppStateProvider><ThemeProvider><KeybindingSetup><Box width={cols} height={rows} flexDirection="column">
      <MessageSelector messages={[first, next]} preselectedMessage={first} onPreRestore={() => {}} onClose={() => { closed = true }} onSummarize={() => {}}
        onRestore={(message, mode, files) => connector.rewind({ userMessageId: message?.uuid ?? files?.userMessageId ?? '', mode, ...files })} />
    </Box></KeybindingSetup></ThemeProvider></AppStateProvider>
    const picker = await mountOffscreen(confirm, cols, rows, { mouseTracking: true })
    try {
      check(`${cols}×${rows} per-file rows paint`, await waitFor(() => picker.screen().includes('Restore src/greeting.ts'), 3000), 'the per-file rows did not paint; check the file rows built from checkpointFacts files in src/screen/rewind-picker/views.tsx')
      for (let n = 0; n < 3; n++) { picker.push(KEY.down); await settle(60) }
      check(`${cols}×${rows} single-file description is visible`, await waitFor(() => picker.screen().includes('Restore this file only'), 3000), 'the single-file description is not shown after three Down keys; check the file row description in src/screen/rewind-picker/views.tsx')
      check(`${cols}×${rows} full confirmation border fits`, picker.lines().some(line => line.includes('╰') && line.includes('╯')), 'the bottom border of the confirmation box is cut off at this size; check the confirmation layout in src/screen/rewind-picker/views.tsx')
      await save(picker, `file-${cols}x${rows}`, cols, rows)
      picker.push(KEY.enter)
      check(`${cols}×${rows} per-file row dispatches only its own path`, await waitFor(() => closed && requests.some(request => request.filePath === 'src/greeting.ts' && request.userMessageId === first.uuid), 3000), 'Enter on the file row did not close the selector and send a rewind with filePath src/greeting.ts; check how onRestore receives files in src/screen/rewind-picker/RewindPicker.tsx')
    } finally { picker.unmount(); await settle(50) }
  }
} finally {
  releaseFocusedSessionConnector()
  await releaseScratchHome(home)
}
console.log(`Rewind frames: ${failures === 0 ? 'PASS' : `${failures} FAILURES`}`)
process.exit(failures === 0 ? 0 : 1)
