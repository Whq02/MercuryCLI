#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'view-reaches-status-row-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
const { scenario, cleanupScenario, RUNTIME_CWD } = await import('./renderScenarios.ts')
const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
const { workspaceFolderOf } = await import('../../src/hooks/useFocusedWorkspaceBranch.ts')
const BACK = keyHintLabel('⇧← back')
const frameIndex = process.argv.indexOf('--frames')
const frameDir = frameIndex < 0 ? undefined : process.argv[frameIndex + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
type Capture = { grid: { c: string }[][] }
const rowsOf = (grid: { c: string }[][]): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').replace(/\s+$/, ''))
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const folder = workspaceFolderOf(RUNTIME_CWD)
const branch = ((): string | null => {
  try {
    const name = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: RUNTIME_CWD, encoding: 'utf8' }).trim()
    return name === '' || name === 'HEAD' ? null : name
  } catch {
    return null
  }
})()
const right = branch === null ? folder : `${folder} ⌥ ${branch}`
try {
  for (const [cols, rows] of [[120, 40], [178, 51], [200, 54]] as const) {
    const tag = `${cols}x${rows}`
    const cfg = scenario('resume-2turn', cols, rows)
    const out = join(home, `${tag}.json`)
    const config = `${out}.cfg.json`
    writeFileSync(config, JSON.stringify({ ...cfg, sends: [{ awaitText: 'Type a prompt', requireAwait: true, awaitSettleTicks: 6, data: '' }], readyText: 'Type a prompt', total: 160, out }))
    const result = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), config], {
      encoding: 'utf8', timeout: vshotBudgetMs(180_000), env: { ...process.env, MERCURY_AWAY_SUMMARY: '0' },
    })
    let payload: Capture | undefined
    try { payload = JSON.parse(readFileSync(out, 'utf8')) as Capture } catch {}
    check(`${tag}: the product painted the cockpit`, result.status === 0 && payload !== undefined, `rc ${result.status} ${(result.stderr ?? '').slice(-300)}`)
    if (payload === undefined) continue
    const lines = rowsOf(payload.grid)
    if (frameDir !== undefined) writeFileSync(join(frameDir, `${tag}.txt`), lines.join('\n') + '\n')
    const top = lines.findIndex(line => /^\s*(?:❯ )?lanes\b.*╭/.test(line))
    const left = top < 0 ? -1 : lines[top]!.indexOf('╭')
    const rightEdge = top < 0 ? -1 : lines[top]!.lastIndexOf('╮')
    const bottom = top < 0 ? -1 : lines.findIndex((line, index) => index > top && line[left] === '╰' && line[rightEdge] === '╯')
    const status = lines.findIndex(line => line.includes(BACK))
    check(`${tag}: the pane opens on its top border at row 0 beside the lanes label`, top === 0, `top ${top}`)
    check(`${tag}: no row reads ✶ VIEW (no title row above the view)`, !lines.some(line => line.includes('✶ VIEW')), lines.find(line => line.includes('VIEW')) ?? '')
    check(`${tag}: no sessions box under the view`, !lines.some(line => line.includes('⊞ SESSIONS') || line.includes('▣ this session')), lines.find(line => line.includes('SESSIONS')) ?? '')
    check(`${tag}: the pane's first interior row is the berth card's top edge, never a title`, top >= 0 && /^\s*╭/.test((lines[top + 1] ?? '').slice(left + 1, rightEdge)), lines[top + 1] ?? '')
    check(`${tag}: the view's bottom border sits directly above the status row`, bottom > top && status === bottom + 1, `pane bottom ${bottom}, status row ${status}`)
    const statusRow = lines[status] ?? ''
    check(`${tag}: the status row rests on ready · the model · the effort and ends with the folder, the branch and the way back`, new RegExp(`^ ready · [^·]+ · [^·]+ {2,}${escaped(right)} {2}${escaped(BACK)}$`).test(statusRow), statusRow)
    const below = lines.slice(bottom + 1).filter(line => (/[│╭╮╰╯]/.test(line.slice(0, left)) || /[│╭╮╰╯]/.test(line.slice(rightEdge + 1))) && !(line.length === cols && /^[╭│╰].*[╮│╯]$/.test(line)))
    check(`${tag}: nothing of the rails paints below the pane's bottom border (the rails end where the view ends)`, below.length === 0, below[0] ?? '')
  }
} finally {
  cleanupScenario('resume-2turn')
}
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`capture evidence: ${home}`)
console.log(`prove-view-reaches-status-row: ${failures === 0 ? 'green' : `${failures} failed`} (${basename(RUNTIME_CWD)})`)
process.exit(failures === 0 ? 0 : 1)
