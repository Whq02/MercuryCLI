#!/usr/bin/env bun
// gate-watch: src/commands/keybindings/keybindings.ts src/utils/editor.ts src/utils/promptEditor.ts src/utils/process.ts src/utils/gracefulShutdown.ts src/ink/ink.tsx src/ink/components/App.tsx
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { grabScreens, nodeBinPath, requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'

requireDist()

const COLS = 80
const ROWS = 30
const ANSWER = 'Still here.'
const TOAST_BUDGET = 61

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const flat = (rows: string[] | undefined): string => (rows ?? []).map(r => r.replace(/\s+$/, '')).join('\n')
const words = (rows: string[] | undefined): string => flat(rows).replace(/\s+/g, ' ')

const scratchBin = join(process.env.TMPDIR ?? '/tmp', `kb-editor-safe-bin-${process.pid}`)
mkdirSync(scratchBin, { recursive: true })
const quick = join(scratchBin, 'qedit')
writeFileSync(quick, '#!/bin/sh\nexit 0\n')
chmodSync(quick, 0o755)
const emptyBin = join(scratchBin, 'empty')
mkdirSync(emptyBin, { recursive: true })

function debugLines(run: ArenaRun, pattern: RegExp): string[] {
  const dir = join(run.paths.home, '.mercury', 'debug')
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.txt')) continue
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) if (pattern.test(line)) out.push(line.trim())
  }
  return out
}

async function leg(tag: string, env: Record<string, string>, receipt: string): Promise<void> {
  const run = await runArtifactArena({
    cols: COLS,
    rows: ROWS,
    turns: [{ kind: 'text', text: ANSWER }],
    sends: [
      { awaitText: 'Type a prompt', text: '/keybindings' },
      { awaitText: '/keybindings', afterPrevMs: 300, text: '\r' },
      { awaitText: '└', afterPrevMs: 1200, text: 'say hello' },
      { awaitText: 'say hello', afterPrevMs: 300, text: '\r' },
      { awaitText: ANSWER.slice(0, -1), afterPrevMs: 800, text: '' },
    ],
    anchor: null,
    seconds: 50,
    keep: true,
    extraEnv: { DEBUG: '1', ...env },
  })
  try {
    const sent = run.sendLog.length
    check(`${tag}: the drive delivered every send (the receipt painted, the prompt was typed, the answer landed)`, sent === 5, `${sent} sends · ${run.driverOut.slice(-300)}`)
    const afterReceipt = run.sendLog[2]?.screen
    const receiptRow = (afterReceipt ?? []).find(r => r.includes(receipt.slice(0, 24)))
    const wholeRow = receiptRow !== undefined && receiptRow.includes(receipt) && receiptRow.slice(receiptRow.indexOf(receipt) + receipt.length).trim() === ''
    check(`${tag}: the receipt stands whole on one row at ${COLS} columns, nothing cut after it — "${receipt}"`, wholeRow, flat(afterReceipt))
    check(`${tag}: the receipt fits the footer toast at ${COLS} columns (${receipt.length} ≤ ${TOAST_BUDGET})`, receipt.length <= TOAST_BUDGET)
    const [final] = grabScreens(run, COLS, ROWS, [-1])
    check(`${tag}: the session is alive afterwards — a prompt still answers (${ANSWER})`, words(final!.rows).includes(ANSWER) && words(final!.rows).includes('say hello'), flat(final!.rows))
    check(`${tag}: the product never exited on its own during the drive`, run.outcome.exitCode === null || run.outcome.killedByWall || run.outcome.ended !== 'eof', JSON.stringify(run.outcome))
    const handovers = debugLines(run, /suspendStdin: removed/)
    const refused = debugLines(run, /editor refused before any spawn|is not an editor|is not on PATH/)
    if (env.MERCURY_EDITOR_HANDOVER_FAULT === undefined && env.EDITOR !== 'qedit') {
      check(`${tag}: the terminal was never handed to a child (no stdin handover in the log) — the refusal came before any spawn`, handovers.length === 0, handovers.join(' | '))
      void refused
    } else {
      check(`${tag}: the editor really ran (one stdin handover in the log)`, handovers.length >= 1, handovers.join(' | '))
      const fault = env.MERCURY_EDITOR_HANDOVER_FAULT
      const raised = debugLines(run, new RegExp(`MERCURY_EDITOR_HANDOVER_FAULT=${fault}: raising`))
      check(`${tag}: the seam raised the simulated console fault after the hand-back`, raised.length === 1, raised.join(' | '))
      const notHangup = debugLines(run, /while the terminal was lent to an editor — the terminal is still here/)
      check(`${tag}: the stdin fault was read as the hand-off's doing, never as a hangup (the session stayed)`, notHangup.length >= 1, debugLines(run, /terminal gone|stdin/).join(' | '))
      const gone = debugLines(run, /terminal gone: stdin read/)
      check(`${tag}: no "terminal gone" line — the hangup shutdown never ran`, gone.length === 0, gone.join(' | '))
      const recovered = debugLines(run, fault === 'read' ? /stdin recovery after read EIO: the reader was destroyed by the hand-off — a fresh reader on the same terminal takes over/ : /stdin recovery after setRawMode EIO: input re-armed/)
      check(`${tag}: input was re-armed (${fault === 'read' ? 'a fresh reader took over the destroyed one' : 'raw mode re-armed on the same reader'})`, recovered.length >= 1, debugLines(run, /stdin recovery|stdin reader moved/).join(' | '))
    }
  } finally {
    run.cleanup()
  }
}

section('§1 VISUAL=true — the value Mercury\'s own tool shell hands to every child, the Windows box\'s F39W-14C-12: refused in words before any spawn; the session lives on')
await leg('true', { VISUAL: 'true', EDITOR: 'true' }, 'VISUAL=true is not an editor — set VISUAL to an editor')

section('§2 EDITOR names an executable that is nowhere — refused in words before any spawn')
await leg('missing', { EDITOR: 'nosuch-editor-9000' }, 'EDITOR=nosuch-edito… is not on PATH — set EDITOR to an editor')

section('§3 EDITOR and VISUAL empty, no editor on PATH — read as unset; the by-hand road is named, nothing is spawned')
await leg('empty', { EDITOR: '', VISUAL: '', PATH: `${emptyBin}:${dirname(nodeBinPath())}` }, 'EDITOR is unset — edit ~/.mercury/keybindings.json by hand')

section('§4 a script that exits at once (the Windows shape of a lent console: the child returns and the stdin reader dies with a read error) — the receipt names it; the session survives the fault and a fresh reader takes the next keys')
await leg('quick-read-fault', { EDITOR: 'qedit', PATH: `/usr/bin:/bin:${dirname(nodeBinPath())}:${scratchBin}`, MERCURY_EDITOR_HANDOVER_FAULT: 'read' }, 'EDITOR=qedit returned at once; set an editor that waits')

section('§5 the same script, the other fault shape (the raw-mode re-arm fails on the console after the hand-back) — the session survives and re-arms')
await leg('quick-mode-fault', { EDITOR: 'qedit', PATH: `/usr/bin:/bin:${dirname(nodeBinPath())}:${scratchBin}`, MERCURY_EDITOR_HANDOVER_FAULT: 'mode' }, 'EDITOR=qedit returned at once; set an editor that waits')

console.log(`\n${failures === 0 ? '✅ keybindings-editor-safe PROVEN' : `❌ ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
