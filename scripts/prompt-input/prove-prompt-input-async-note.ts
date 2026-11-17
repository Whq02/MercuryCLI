#!/usr/bin/env bun
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'

const home = mkdtempSync(join(tmpdir(), 'kinetic-note-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.HOME = home
process.env.USERPROFILE = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
mkdirSync(home, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const React = await import('react')
const { Box, Text } = await import('../../src/ink.ts')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { useInteractiveList } = await import('../../src/components/mercury-ui/useInteractiveList.ts')
const { InteractiveRow } = await import('../../src/components/mercury-ui/InteractiveRow.tsx')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const h = React.createElement

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

let probes = 0
let closes = 0
let settleProbe: (words: string) => void = () => {}
const rows = [{ id: 'first' }, { id: 'second' }]

function ProbeList(): React.ReactNode {
  const list = useInteractiveList({
    rows,
    rowId: row => row.id,
    idNamespace: 'async-note',
    onClose: () => { closes++ },
    actions: [
      {
        key: 'g',
        hint: 'probe',
        run: () => ({
          pending: 'checking the probe…',
          result: new Promise<string>(resolve => { probes++; settleProbe = resolve }),
        }),
      },
    ],
  })
  return h(
    Box,
    { flexDirection: 'column' },
    ...rows.map((row, index) => h(InteractiveRow, { key: row.id, ...list.rowProps(row, index) }, h(Text, {}, `row ${row.id}`))),
    h(Text, {}, `note: ${list.note ?? 'none'}`),
  )
}

const scene = await mountOffscreen(h(ThemeProvider, {}, h(AppStateProvider, {}, h(KeybindingSetup, {}, h(Box, { width: 80, height: 12, flexDirection: 'column' }, h(ProbeList))))), 80, 12)
try {
  t('the list paints its rows with no note', await waitFor(() => scene.screen().includes('row first') && scene.screen().includes('note: none'), 4000), scene.screen())
  scene.push('g')
  t('the action starts and the list paints its pending note', await waitFor(() => scene.screen().includes('note: checking the probe…'), 2500), scene.screen())
  scene.push('\x1b')
  t('esc closes the list while the probe is still running', await waitFor(() => closes === 1, 2500), `closes=${closes}\n${scene.screen()}`)
  t('the probe ran exactly once', probes === 1, `probes=${probes}`)
  settleProbe('the probe answered late')
  await waitFor(() => scene.screen().includes('the probe answered late'), 300)
  t('the list closed once: the late answer closes nothing again', closes === 1, `closes=${closes}`)
} finally {
  scene.unmount()
}

console.log(failures === 0 ? '✅ kinetic async-note law holds' : '❌ kinetic async-note BROKEN')
process.exit(failures)
