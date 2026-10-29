#!/usr/bin/env bun
// gate-watch: src/components/messages/UserBashInputMessage.tsx src/components/messages/TranscriptNameplate.tsx src/components/shell/ShellLiveTail.tsx src/components/shell/liveShellTail.ts
// gate-watch: src/utils/processUserInput/processBashCommand.tsx src/tools/BashTool/BashTool.tsx src/Tool.ts
// gate-watch: src/tasks/LocalShellTask/LocalShellTask.tsx src/utils/task/workRoster.ts src/components/messages/UserBashOutputMessage.tsx
// gate-watch: src/components/Message.tsx src/utils/messages/normalize.ts src/types/message.ts src/services/engine-connector/daemonConnector.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grabScreens, requireDist, runArtifactArena, sendStamp } from '../streaming/artifactArena.ts'
import { resolveCaptureDriver } from '../lib/captureDriver.ts'

requireDist()
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.reason)
const captureArg = process.argv.indexOf('--capture-dir')
const captureDir = captureArg < 0 ? null : process.argv[captureArg + 1]!
if (captureDir) mkdirSync(captureDir, { recursive: true })
const engineArg = process.argv.indexOf('--engine')
const engine = engineArg < 0 ? undefined : process.argv[engineArg + 1]
if (engine !== undefined && engine !== 'system' && engine !== 'brush') throw new Error('Choose system or brush for --engine')
const recordBase = process.argv.includes('--record-base')
const fixtures = join(import.meta.dir, 'fixtures', 'shell-live-tail')
if (recordBase) mkdirSync(fixtures, { recursive: true })
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function save(name: string, rows: readonly string[]): void {
  if (captureDir) writeFileSync(join(captureDir, `${name}.txt`), rows.map(row => row.trimEnd()).join('\n') + '\n')
}
function chatOutput(rows: readonly string[], needle: string): string[] {
  const at = rows.findLastIndex(row => row.includes('[sam]') && (row.includes(needle) || row.includes(needle.replace('! ', '!'))))
  if (at < 0) return []
  const left = rows[at]!.indexOf('[sam]') - 9
  const out: string[] = []
  for (const row of rows.slice(at + 1)) {
    const text = row.slice(Math.max(0, left)).replace(/│\s*$/, '').trimEnd()
    if (text.trim() === '' || row.includes('╰') && row.includes('─')) break
    if (out.length > 0 && !text.startsWith('    ') && !text.startsWith('  └')) break
    if (out.length > 0 || text.startsWith('  └')) out.push(text)
  }
  return out
}
function composer(rows: readonly string[]): boolean {
  return rows.some(row => /│[❯!] .*Type|│❯\s/.test(row)) && rows.some(row => row.includes('╰'))
}
const demo = "sh -c 'echo CODE-1234; echo open https://example.invalid; sleep 20'"
for (const cols of [120, 80]) {
  const rows = cols === 80 ? 24 : 40
  const run = await runArtifactArena({
    cols, rows, turns: [], anchor: null, seconds: 75, keep: true,
    extraEnv: engine ? { MERCURY_SHELL_ENGINE: engine } : undefined,
    seedCwd: {
      'progress.sh': "for n in 1 2 3 4 5; do printf '\\r%d%%' \"$n\"; sleep 1; done; sleep 4\n",
      'many.sh': "i=1; while [ $i -le 12 ]; do printf 'line-%02d\\n' $i; i=$((i+1)); done; sleep 6\n",
    },
    sends: [
      { awaitText: '│❯', afterPrevMs: 1000, text: '!' + demo },
      { awaitText: 'example.invalid', afterPrevMs: 1000, text: '\r' },
      { awaitText: 'exit 0', afterPrevMs: 600, text: '!sh progress.sh' },
      { awaitText: '│! sh progress.sh', afterPrevMs: 600, text: '\r' },
      { awaitText: '│❯', afterPrevMs: 11_000, text: '!sh many.sh' },
      { awaitText: '│! sh many.sh', afterPrevMs: 600, text: '\r' },
      { awaitText: '│❯', afterPrevMs: 8500, text: '!sleep 6' },
      { awaitText: '│! sleep 6', afterPrevMs: 600, text: '\r' },
      { awaitText: '│❯', afterPrevMs: 8500, text: '' },
    ],
  })
  try {
    check(`${cols}: capture completed and every command was submitted`, run.outcome.complete && run.sendLog.length === 9, JSON.stringify({ sends: run.sendLog.length, outcome: run.outcome, driver: run.driverOut.slice(-500) }))
    save(`${cols}-final`, grabScreens(run, cols, rows, [-1])[0]!.rows)
    if (captureDir) writeFileSync(join(captureDir, `${cols}-sends.json`), JSON.stringify(run.sendLog, null, 2))
    if (run.sendLog.length !== 9) continue
    const submit = [1, 3, 5, 7].map(index => sendStamp(run, run.sendLog[index]!))
    const moments = [submit[0]! + 2000, submit[0]! + 5000, sendStamp(run, run.sendLog[2]!) - 100, submit[1]! + 3500, submit[2]! + 2500, submit[3]! + 2500]
    const screens = grabScreens(run, cols, rows, moments).map(screen => screen.rows)
    const names = ['running', 'ticking', 'exited', 'progress', 'clamped', 'silent']
    screens.forEach((screen, index) => save(`${cols}-${names[index]}`, screen))
    const live = chatOutput(screens[0]!, '! sh')
    check(`${cols}: both output lines are in CHAT within two seconds, before exit`, live.some(row => row.includes('CODE-1234')) && live.some(row => row.includes('open https://example.invalid')) && !live.some(row => row.includes('exit 0')), live.join(' | '))
    check(`${cols}: the live row carries a ticking running clock`, live.some(row => /running ·/.test(row)) && chatOutput(screens[1]!, '! sh').some(row => /running ·/.test(row)) && live.join('\n') !== chatOutput(screens[1]!, '! sh').join('\n'))
    const exited = chatOutput(screens[2]!, '! sh').map(row => row.replace(/(exit 0 · )\d+(?:\.\d+)?s/, '$1<TIME>'))
    save(`exited-${cols}`, exited)
    const pin = join(fixtures, `exited-${cols}.txt`)
    if (recordBase) writeFileSync(pin, exited.join('\n') + '\n')
    check(`${cols}: exited output and exit words match the frozen base`, exited.length > 0 && exited.join('\n') + '\n' === readFileSync(pin, 'utf8'), exited.join(' | '))
    const progress = chatOutput(screens[3]!, '! sh progress.sh')
    check(`${cols}: carriage-return progress is one latest-state line`, progress.filter(row => /\d%/.test(row)).length === 1 && progress.some(row => /[234]%/.test(row)) && !progress.some(row => /1%.*2%/.test(row)), progress.join(' | '))
    const many = chatOutput(screens[4]!, '! sh many.sh').filter(row => /line-\d\d/.test(row))
    const cap = cols === 80 ? 3 : 6
    check(`${cols}: the live tail keeps exactly the last ${cap} lines`, many.length === cap && many[0]!.includes(`line-${String(13 - cap).padStart(2, '0')}`) && many.at(-1)!.includes('line-12'), many.join(' | '))
    const silent = chatOutput(screens[5]!, '! sleep 6')
    check(`${cols}: a silent command shows no invented output`, silent.length <= 1 && !silent.some(row => /CODE|line-|%|no output/.test(row)), silent.join(' | '))
    check(`${cols}: the composer stays visible in every live frame`, [0, 1, 3, 4, 5].every(index => composer(screens[index]!)))
  } finally {
    run.cleanup()
  }
}
console.log(failures === 0 ? 'SHELL LIVE TAIL DRIVE GREEN' : `${failures} SHELL LIVE TAIL DRIVE FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
