#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'

const home = mkdtempSync(join(tmpdir(), 'session-name-roads-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
const { scenario, cleanupScenario, SID, SID_ERRORED, RUNTIME_CWD, CONFIG_HOME } = await import('./renderScenarios.ts')
const { getProjectDir, extractFirstPromptFromHead } = await import('../../src/utils/sessionStoragePortable.ts')
const { tabLabel } = await import('../../src/components/mercury-ui/SessionTabs.tsx')
const { rowLabel } = await import('../../src/components/mercury-ui/screens/sessionPickerModel.ts')
const { createSyntheticUserCaveatMessage, createUserMessage, formatCommandInputTags } = await import('../../src/utils/messages/factories.ts')
const title = 'after command'
const frameIndex = process.argv.indexOf('--frames')
const frameDir = frameIndex < 0 ? undefined : process.argv[frameIndex + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} — ${detail}`)
}
const entries = [
  createSyntheticUserCaveatMessage(),
  createUserMessage({ content: formatCommandInputTags('model', 'claude-sonnet-5') }),
  createUserMessage({ content: '<local-command-stdout>Set model to claude-sonnet-5</local-command-stdout>' }),
  createUserMessage({ content: title }),
].map((row, index, rows) => ({ ...row, sessionId: SID_ERRORED, cwd: RUNTIME_CWD, parentUuid: index === 0 ? null : rows[index - 1]!.uuid }))
const bytes = encodeSeedTranscript(entries, SID_ERRORED)
const log = { firstPrompt: extractFirstPromptFromHead(bytes), sessionId: SID_ERRORED } as import('../../src/types/logs.ts').LogOption
check('the strip and /sessions name the same first real prompt', tabLabel(log) === title && rowLabel(log) === title, `${tabLabel(log)} / ${rowLabel(log)}`)
const tagged = { ...log, firstPrompt: '<local-command-caveat>synthetic words</local-command-caveat>', summary: title }
check('the strip and /sessions share the summary and markup cleanup', tabLabel(tagged) === rowLabel(tagged) && rowLabel(tagged) === title, `${tabLabel(tagged)} / ${rowLabel(tagged)}`)
type Mark = { label: string; grid: { c: string }[][] }
type Capture = { grid: { c: string }[][]; marks?: Mark[] }
const rowsOf = (grid: { c: string }[][]): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').trimEnd())
try {
  for (const band of [{ cols: 178, rows: 51 }, { cols: 80, rows: 21 }, { cols: 120, rows: 40 }]) {
    for (const road of ['header', 'lists']) {
      const cfg = scenario('resume-2turn', band.cols, band.rows)
      const commandId = crypto.randomUUID()
      const commandPath = join(getProjectDir(RUNTIME_CWD), `${commandId}.jsonl`)
      writeFileSync(commandPath, encodeSeedTranscript(entries.map(row => ({ ...row, sessionId: commandId })), commandId))
      writeFileSync(join(CONFIG_HOME, 'settings.json'), JSON.stringify({ sessionsBar: true }))
      const argv = cfg.argv.map(value => value === SID && road === 'header' ? commandId : value)
      const sends: Record<string, unknown>[] = [
        { awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 5, data: '', mark: 'home' },
      ]
      if (road === 'lists') sends.push(
        { afterPrevTicks: 2, data: '/sessions' },
        { afterPrevTicks: 2, data: '\r' },
        { awaitText: 'Switch to', awaitPattern: '(?s)Switch to.*after command', requireAwait: true, awaitStableTicks: 3, data: '', mark: 'sessions' },
      )
      const out = join(home, `${band.cols}-${road}.json`)
      const config = `${out}.cfg.json`
      writeFileSync(config, JSON.stringify({ ...cfg, argv, sends, total: 160, ...band, out }))
      const result = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), config], {
        encoding: 'utf8', timeout: vshotBudgetMs(180_000), env: { ...process.env, MERCURY_AWAY_SUMMARY: '0' },
      })
      let payload: Capture | undefined
      try { payload = JSON.parse(readFileSync(out, 'utf8')) as Capture } catch {}
      check(`${band.cols} ${road}: the product reaches every requested surface`, result.status === 0 && payload !== undefined, `rc ${result.status} ${(result.stderr ?? '').slice(-350)}`)
      const marks = Object.fromEntries((payload?.marks ?? []).map(mark => [mark.label, rowsOf(mark.grid)]))
      for (const [label, lines] of Object.entries(marks)) {
        if (frameDir !== undefined) writeFileSync(join(frameDir, `${band.cols}x${band.rows}-${road}-${label}.txt`), lines.join('\n') + '\n')
      }
      const homeRows = marks.home ?? []
      if (road === 'header') {
        if (band.cols >= 100) {
          const header = homeRows.find(row => row.includes('VIEW')) ?? ''
          check(`${band.cols}: the view header names the first prompt, never command markup`, header.includes(title) && !header.includes('<'), header)
        }
        check(`${band.cols}: no row of the resumed command-first session carries command markup`, homeRows.length > 0 && !homeRows.some(row => row.includes('<local-command')), homeRows.filter(row => row.includes('<local-command')).join(' | '))
      }
      if (road === 'lists') {
        const strip = homeRows.find(row => row.includes('SESSIONS')) ?? ''
        if (band.cols >= 100) check(`${band.cols}: the sessions strip paints the same clean name`, strip.includes(title) && !strip.includes('<local-command'), strip)
        if (band.cols >= 100) check(`${band.cols}: the rail's RECENT lane paints the same clean name`, homeRows.some(row => row.includes(`○ ${title}`)) && !homeRows.some(row => row.includes('<local-command')), homeRows.filter(row => row.includes('○ ')).join(' | '))
        const pickerRows = marks.sessions ?? []
        const switchAt = pickerRows.findIndex(row => row.includes('Switch to'))
        const picker = switchAt < 0 ? '' : pickerRows.slice(switchAt).join('\n')
        check(`${band.cols}: /sessions paints the same clean name`, switchAt >= 0 && picker.includes(title) && !picker.includes('<local-command'), picker)
      }
      cleanupScenario('resume-2turn')
      rmSync(commandPath, { force: true })
    }
  }
} finally {
  cleanupScenario('resume-2turn')
}
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`capture evidence: ${home}`)
console.log(`prove-session-name-roads: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
