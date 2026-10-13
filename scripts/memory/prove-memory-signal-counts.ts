import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.js'

const root = join(import.meta.dir, '../..')
const arg = (key: string): string | undefined => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1] }
const expected = 'offered 3 · opened 2 · cited 1 (last 512 turns)'
if (process.argv.includes('--child')) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { pinSourceRef } = await import('../lib/settingsPopupHarness.js')
  pinSourceRef()
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const { retainItems } = await import('../../src/mneme/memoryVerbs.js')
  const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.js')
  const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
  const { memorySignalScope, noteMemoryOffered, noteMemoryOpened, finishMemorySignal } = await import('../../src/mneme/mnemeSignal.js')
  retainItems([{ content: 'quartzalpha facts stay exactly as written', topic: 'signal' }], { session: 'fixture' })
  maybeConsolidate({ dir: mnemeLibraryDir(), force: true })
  for (let i = 0; i < 3; i++) {
    for await (const _ of memorySignalScope((async function* () {
      noteMemoryOffered('quartzalpha', [{ id: 'seq:1' }])
      if (i < 2) noteMemoryOpened(['seq:1'])
      await finishMemorySignal(i === 0 ? 'seq:1' : 'no citation')
    })())) {}
  }
  const React = await import('react')
  const { render, Box, Text } = await import('../../src/ink.js')
  const { App } = await import('../../src/components/App.js')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
  const { MemoryCentreView, factSignalLine, factRef, pendingRef } = await import('../../src/components/memory/MemoryCentreView.js')
  const { listTopicDocs } = await import('../../src/mneme/mnemeLibrary.js')
  const entry = listTopicDocs()[0]!.sections[0]!.entries[0]!
  if (!arg('--source-ref')) {
    assert.equal(factSignalLine(factRef(entry, 'signal')), expected)
    assert.equal(factSignalLine(factRef({ ...entry, seq: 77 }, 'signal')), 'offered 0 · opened 0 · cited 0 (last 512 turns)')
    assert.equal(factSignalLine(pendingRef({ text: 'a draft', ts: '2026-10-13T00:00:00.000Z', source: 'fixture' }, 0)), 'offered 0 · opened 0 · cited 0 (last 512 turns)')
  }
  const h = React.createElement
  const instance = await render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never,
    h(KeybindingSetup, null, h(Box, { flexDirection: 'column', width: process.stdout.columns },
      h(Text, null, 'Mercury · memory'),
      h(MemoryCentreView, { width: process.stdout.columns - 4, rowBudget: process.stdout.rows - 4, onClose: () => process.exit(0) })))),
    { exitOnCtrlC: true })
  await instance.waitUntilExit()
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'memory-signal-counts-'))
  const driver = resolveCaptureDriver()
  assert.notEqual(driver.kind, 'unavailable')
  if (driver.kind === 'unavailable') process.exit(1)
  const frames = arg('--frames')
  if (frames) mkdirSync(frames, { recursive: true })
  try {
    for (const [cols, rows] of [[120, 40], [80, 28]]) {
      const out = join(scratch, `${cols}x${rows}.json`)
      const config = `${out}.cfg.json`
      const source = arg('--source-ref')
      const argv = [process.execPath, import.meta.path, '--child', ...(source ? ['--source-ref', source] : [])]
      writeFileSync(config, JSON.stringify({ argv, cwd: root, cols, rows, total: 150, out, readyText: expected, sends: [
        { awaitText: 'facts and decisions', requireAwait: true, data: 'quartzalpha' },
        { awaitText: '1 match', requireAwait: true, data: '\r' },
      ] }))
      const result = spawnSync(driver.python, [captureEngineEntry(driver, root), config], { encoding: 'utf8', timeout: vshotBudgetMs(90_000), env: {
        ...process.env, MERCURY_CONFIG_DIR: join(scratch, `home-${cols}`), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_DESKTOP_DRIVER: 'none', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none', BROWSER: '/usr/bin/true',
      } })
      if (result.status !== 0) console.error(result.stderr)
      const capture = JSON.parse(readFileSync(out, 'utf8')) as { grid: { c: string }[][] }
      const lines = capture.grid.map(row => row.map(cell => cell.c || ' ').join('').replace(/\s+$/, ''))
      if (frames) {
        writeFileSync(join(frames, `signal-counts-${cols}x${rows}.txt`), `${lines.join('\n')}\n`)
        const { gridToPng } = await import('../ui/gridToPng.js')
        await gridToPng(out, join(frames, `signal-counts-${cols}x${rows}.png`))
      }
      assert.equal(result.status, 0, result.stderr)
      assert(lines.join('\n').includes(expected), `real memory detail must show the counts at ${cols}x${rows}\n${lines.join('\n')}`)
      assert(lines.join('\n').includes('quartzalpha facts stay exactly as written'))
      assert(lines.every(line => [...line].length <= cols), 'no row overflows the terminal')
      console.log(`PASS memory signal counts ${cols}x${rows}: real terminal, counts and unchanged fact text`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  process.exit(0)
}
