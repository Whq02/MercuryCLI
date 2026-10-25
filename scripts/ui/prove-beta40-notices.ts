import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'
import { gridToPng } from './gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
process.env.MERCURY_DAEMON_DIR = join(f.home, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
let failures = 0
const check = (name: string, ok: unknown) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failures++ }
try {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { UserTextMessage } = await import('../../src/components/messages/UserTextMessage.tsx')
  const watches = await import('../../src/tools/MonitorTool/watchReceipts.ts')
  const { getCommandQueue, resetCommandQueue } = await import('../../src/utils/messageQueueManager.ts')
  const { restartSessionOnInstalledBuild } = await import('../../src/commands/restart/restart.ts')
  const { readSelfHostedLiveness } = await import('../../src/services/providers/openaicompat/compatProbe.ts')
  const { loginsActionFor } = await import('../../src/services/concourse/workerModels.ts')
  const { hostReadyWords } = await import('../../src/commands/llmhost/words.ts')
  const installed = 'abcdef123456'
  const runtime = join(f.home, 'runtime/current')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, 'mercury.mjs'), '')
  writeFileSync(join(runtime, 'manifest.json'), JSON.stringify({ buildTree: installed }))
  writeFileSync(join(process.env.MERCURY_DAEMON_DIR, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { fixture: { runnerId: 'fixture', sessionId: 'fixture-chat', buildTree: installed } } }))
  const args = { sessionId: 'fixture-chat', work: [], tell: () => { throw new Error('No restart is allowed in this words proof') }, resume: async () => { throw new Error('No resume is allowed in this words proof') } }
  const busy = await restartSessionOnInstalledBuild({ ...args, turnActive: true })
  const current = await restartSessionOnInstalledBuild({ ...args, turnActive: false })
  assert.ok(!busy.ok && !current.ok)
  const watch = { toolUseId: 'watch-use', taskId: 'watch-fixture', description: 'stock watch', command: 'tail -F stock.log', persistent: true, armedAt: 0 }
  const shell = { toolUseId: 'shell-use', taskId: 'shell-fixture', description: 'build log', command: 'tail -F build.log', outputPath: 'build.output', armedAt: 0 }
  resetCommandQueue()
  watches.reconcileBackgroundShellsOnResume([
    { type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: shell.toolUseId, name: 'Bash', input: { command: shell.command, description: shell.description } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: shell.toolUseId, content: 'Running in the background (ID: shell-fixture). Output: build.output' }] } },
  ] as never, new Set(), 'update')
  const shellLine = String(getCommandQueue()[0]?.value ?? '')
  assert.ok(shellLine.includes('shell-fixture'))
  const idle = await readSelfHostedLiveness({ baseUrl: 'http://127.0.0.1:30000/v1', dialect: 'llamacpp' }, 'llamacpp', 2, { fetchImpl: (async () => Response.json(Array.from({ length: 4 }, (_, id) => ({ id, is_processing: id !== 2 })))) as typeof fetch })
  assert.equal(idle.state, 'dead')
  const lines = [
    ['build-newer', watches.composeBuildBehindLine(installed, '123456abcdef', true)],
    ['build-other', watches.composeBuildBehindLine(installed, '123456abcdef', false)],
    ['dead-watch', watches.monitorNoticeBlock(watch.taskId, watch.description, watches.deadWatchLine(watch, 'update'))],
    ['dead-shell', shellLine],
    ['restart-busy', busy.reason],
    ['restart-current', current.reason],
    ['restart-summary', watches.composeRestartLine({ reason: 'update', build: installed, watches: [watch], shells: [shell] })],
    ['rented', 'Rented GLM-5.3-Flash · 1× B300 · $8.99/hr in EU-NL-1 · setting up'],
    ['ready', hostReadyWords('GLM-5.3-Flash', 'compat/pod-fixture/GLM-5.3-Flash', { price: 8.99, startedAt: new Date(Date.now() - 3600_000).toISOString() })],
    ['ready-switched', hostReadyWords('GLM-5.3-Flash', 'compat/pod-fixture/GLM-5.3-Flash', { price: 8.99, startedAt: new Date(Date.now() - 3600_000).toISOString() }, true)],
    ['idle-slot', idle.words],
    ['needs-key', loginsActionFor('openai-compat', 'x')],
  ] as const
  check('busy refusal names the safe wait action without mid-turn jargon or destructive esc advice', busy.reason.includes('Wait for it to finish, then run /restart.') && !busy.reason.includes('Press esc') && !busy.reason.includes('mid-turn'))
  check('current refusal is a complete sentence', current.reason.includes('Nothing needs restarting.'))
  check('notice wording avoids internal names', lines.every(([, text]) => !/\b(?:seat|kit|concourse|re-arm|receipt)\b/i.test(text)))
  const lineOf = (name: string): string => lines.find(([key]) => key === name)?.[1] ?? ''
  check('the ready notice names the /model door when the session was not switched, and the fact when it was', lineOf('ready').startsWith('GLM-5.3-Flash ready · /model compat/pod-fixture/GLM-5.3-Flash\n~$') && lineOf('ready-switched').startsWith('GLM-5.3-Flash ready · now your model\n~$') && !lineOf('ready-switched').includes('/model') && lineOf('ready-switched').endsWith(' so far + storage.'))
  check('build notice says what restarts will stop', lines[0][1].includes('watches and background shells') && lines[0][1].includes('/restart'))
  for (const cols of [120, 80]) {
    for (const [name, text] of lines) {
      const m = await mountOffscreen(React.createElement(ThemeProvider, {}, React.createElement(Box, { width: cols, height: 24, flexDirection: 'column' }, React.createElement(UserTextMessage, { addMargin: false, param: { type: 'text', text }, verbose: true, notice: true }))), cols, 24)
      try {
        assert.ok(await waitFor(() => m.screen().trim().length > 0, 5000))
        check(cols + ': ' + name + ' renders without losing its final words', !m.screen().includes('RENDER ERROR') && m.screen().replace(/\s+/g, ' ').includes(text.replace(/<[^>]+>/g, '').trim().slice(-16).replace(/\]$/, '').replace(/\s+/g, ' ')))
        if (frames) {
          writeFileSync(join(frames, name + '-' + cols + '.txt'), m.screen())
          const grid = m.lines().map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => { const s = m.styleAt(x, y); return { c, bg: s?.bg ?? 'default', fg: s?.fg ?? 'default', bold: s?.bold ?? false, rev: s?.inverse ?? false } }))
          const path = join(frames, name + '-' + cols + '.json')
          writeFileSync(path, JSON.stringify({ grid, cols, rows: 24 }))
          await gridToPng(path, join(frames, name + '-' + cols + '.png'))
        }
      } finally { m.unmount() }
    }
  }
  console.log('BETA40 NOTICES ' + (failures ? 'RED' : 'GREEN') + ' — ' + failures + ' failures')
  process.exitCode = failures ? 1 : 0
} finally { f.close() }
