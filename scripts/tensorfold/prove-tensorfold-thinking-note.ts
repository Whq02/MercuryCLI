import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })
const models = [{ id: 'note-no-switch', switch: false }, { id: 'note-with-switch', switch: true }, { id: 'note-unstated', switch: undefined }]
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname
  const headers = { server: 'TensorFold' }
  if (path === '/health') return Response.json({ status: 'ok', model: models[0]!.id, version: '1.2.5', backend: 'metal', device: 'fixture', memory: { active: 1024 }, max_batch_size: 1 }, { headers })
  if (path === '/v1/models') return Response.json({ object: 'list', data: models.map(row => ({ id: row.id, object: 'model', owned_by: 'tensorfold', context_length: 32768, max_model_len: 32768, reasoning: { default_enabled: true }, ...(row.switch === undefined ? {} : { capabilities: { thinking_switch: row.switch, thinking_applicable: true } }) })) }, { headers })
  return new Response('fixture path not found', { status: 404 })
} })
process.env.MERCURY_LOCAL_PROBE_TARGETS = `tensorfold=http://127.0.0.1:${server.port}`
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname !== '127.0.0.1' || url.port !== String(server.port)) { escaped.push(url.href); throw new Error('Only the discovery fixture is allowed') }
  return nativeFetch(input, init)
}, nativeFetch)
let checks = 0
let failures = 0
const check = (name: string, truth: unknown): void => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name) }
try {
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
  const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
  await refreshLocalDiscovery({ force: true })
  check('the false, true and unstated facts come from the engine list, not a screen stub', localRecordFor('local/note-no-switch')?.thinkingSwitch === false && localRecordFor('local/note-with-switch')?.thinkingSwitch === true && localRecordFor('local/note-unstated')?.thinkingSwitch === undefined)
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { EffortPopup } = await import('../../src/commands/effort/EffortPopup.tsx')
  const h = React.createElement
  for (const [columns, rows] of [[60, 13], [60, 20], [120, 40]] as const) {
    for (const row of [...models, { id: 'gpt-6-astra', switch: undefined }]) {
      process.env.MERCURY_MODEL = row.id === 'gpt-6-astra' ? row.id : 'local/' + row.id
      const mounted = await mountOffscreen(h(AppStateProvider, { children: h(ThemeProvider, { children: h(Box, { flexDirection: 'column', width: columns, height: rows }, h(EffortPopup, { onDone: () => {} })) }) }), columns, rows)
      try {
        check(`${columns} ${row.id}: the real effort surface paints`, await waitFor(() => mounted.screen().includes('Mercury · effort'), 3000))
        const text = mounted.screen()
        check(`${columns} ${row.id}: only an engine that refuses thinking off gets the note`, text.includes('thinking stays on for this model') === (row.switch === false))
        check(`${columns} ${row.id}: the close hint and bottom border stay visible`, text.includes('esc') && text.includes('╰'))
        if (frames) {
          const name = `${columns}x${rows}-${row.id}`
          writeFileSync(join(frames, name + '.txt'), text + '\n')
          const grid = mounted.lines().map((line, y) => Array.from(line.padEnd(columns)).map((c, x) => { const style = mounted.styleAt(x, y); return { c, fg: style?.fg ?? 'default', bg: style?.bg ?? 'default', bold: style?.bold ?? false } }))
          const path = join(frames, name + '.json')
          writeFileSync(path, JSON.stringify({ grid, cols: columns, rows }))
          const { gridToPng } = await import('../ui/gridToPng.ts')
          await gridToPng(path, join(frames, name + '.png'))
        }
      } finally { mounted.unmount() }
    }
  }
  check('the proof made no off-fixture request', escaped.length === 0)
  console.log(`TENSORFOLD THINKING NOTE ${failures ? 'RED' : 'GREEN'} — ${checks} checks, ${failures} failed`)
} finally { server.stop(true); globalThis.fetch = nativeFetch; delete process.env.MERCURY_MODEL }
process.exitCode = failures ? 1 : 0
