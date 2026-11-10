#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runArtifactArena } from './artifactArena.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)

console.log("the arena's own Enter reaches the Boot face alone, and every send of a run is on its record with its author")

const helper = await import('../lib/bootFace.ts').catch(() => null)
const scratch = mkdtempSync(join(tmpdir(), 'arena-face-'))
const fixture = join(import.meta.dir, 'fixtures', 'first-screen.mjs')
let scene = 0
async function show(lines: string[], options: { sends?: string[]; passBootFace?: boolean; then?: string[] } = {}) {
  const keys = join(scratch, `keys-${++scene}.jsonl`)
  const run = await runArtifactArena({ turns: [], sends: options.sends ?? [], seconds: 3, distPath: fixture, anchor: null, extraEnv: { FIRST_SCREEN: JSON.stringify(lines), FIRST_SCREEN_THEN: JSON.stringify(options.then ?? []), FIRST_SCREEN_KEYS: keys }, ...(options.passBootFace === false ? { passBootFace: false } : {}) })
  const typed = existsSync(keys) ? readFileSync(keys, 'utf8').split('\n').filter(Boolean).flatMap(line => JSON.parse(line) as number[]) : []
  const every = (run as { sends?: Array<{ by?: string }> }).sends ?? null
  const sent = (run as { sent?: { drive: number; arena: number } }).sent ?? null
  const report = run.outcome.report as { sends: number; unfired: string[]; skipped?: string[] } | null
  return { run, typed, every, sent, report }
}

try {
  console.log('\n§1 a first screen that is not the Boot face')
  const card = await show([
    '╭──────────────────────────────────────────────────────╮',
    '│  ⦿ Tool use                                          │',
    '│  Do you want to proceed?                             │',
    '│  ❯ 1. Yes                                            │',
    '│  ↑↓ choose · ↵ confirm · esc cancel · tab amend      │',
    '╰──────────────────────────────────────────────────────╯',
  ])
  check('a permission card receives no key from the arena', card.run.outcome.complete && card.typed.length === 0, `typed ${j(card.typed)} · ${card.run.outcome.reason ?? ''}`)
  check('…and the record says so: no arena send, nothing unfired, the pass named as skipped', card.sent !== null && card.sent.arena === 0 && card.sent.drive === 0 && card.every?.length === 0 && card.report?.unfired.length === 0 && card.report?.skipped?.length === 1, j({ sent: card.sent, report: card.report }))
  const board = await show(['│ SESSIONS              + new session · n │', '│ ▸ ● MCP Popup        flux-ar…       00m │', '│ ↑↓ choose · ↵ enter · n new · p pause   │'])
  check("the board's SESSIONS pane receives no key from the arena", board.run.outcome.complete && board.typed.length === 0 && board.sent?.arena === 0, `typed ${j(board.typed)} · sent ${j(board.sent)}`)
  const plain = await show(['Type a prompt'])
  check('a boot that never paints the face gets no arena send and no failure from it', plain.run.outcome.complete && plain.typed.length === 0 && plain.sent?.arena === 0 && plain.report?.unfired.length === 0, j({ typed: plain.typed, sent: plain.sent, report: plain.report }))

  console.log('\n§2 the Boot face')
  const face = await show(['                    >_ ready  ·  ↵ start  ·  m menu  ·  ↑↓ choose'])
  check('the Boot face receives exactly one Enter', face.run.outcome.complete && j(face.typed) === j([13]), `typed ${j(face.typed)}`)
  check("…and that Enter is on the record as the arena's: one row marked by arena, counted, and not among the drive's own sends", face.sent?.arena === 1 && face.sent.drive === 0 && face.every?.length === 1 && face.every[0]?.by === 'arena' && face.run.sendLog.length === 0 && face.report?.sends === 1, j({ sent: face.sent, every: face.every?.map(row => row.by), sendLog: face.run.sendLog.length, driver: face.report?.sends }))
  const compact = await show(['        │ ↵ start · ↑↓ choose                                 │'])
  check('the compact face, whose ready line stands in the card, receives it too', j(compact.typed) === j([13]) && compact.sent?.arena === 1, j({ typed: compact.typed, sent: compact.sent }))
  const pieces = await show(['', '', '', '', '          >_ ready  ·  ↵ start'], { then: ['\x1b[2;1H│ ❯ New Session            start a chat here │', '\x1b[5;31H  ·  ↑↓ choose'] })
  check('a face whose ready line reaches the terminal in two writes with another row between (a painter that writes only the cells that changed) is read off the screen, not the byte stream', j(pieces.typed) === j([13]) && pieces.sent?.arena === 1, j({ typed: pieces.typed, sent: pieces.sent, report: pieces.report }))
  const own = await show(['                    >_ ready  ·  ↵ start  ·  ↑↓ choose'], { sends: ['after:ready:200:x', ...(helper !== null ? [helper.afterBootFace(1500, 'y')] : [])] })
  const authors = own.every?.map(row => row.by) ?? []
  check("a drive's own sends beside it stay the drive's, each key arrives in its turn (x, the arena's Enter, y), and both counts sum to the driver's", j(own.typed) === j([120, 13, 121]) && own.sent?.arena === 1 && own.sent.drive === 2 && own.run.sendLog.length === 2 && own.run.sendLog.every(row => (row as { by?: string }).by === 'drive') && j(authors) === j(['drive', 'arena', 'drive']) && own.report?.sends === own.every?.length, j({ typed: own.typed, sent: own.sent, authors, driver: own.report?.sends }))
  const off = await show(['                    >_ ready  ·  ↵ start  ·  m menu  ·  ↑↓ choose'], { passBootFace: false })
  check('a drive that tests the Boot face itself turns the pass off: no key, no row, nothing skipped', off.typed.length === 0 && off.sent?.arena === 0 && off.every?.length === 0 && off.report?.skipped?.length === 0, j({ typed: off.typed, sent: off.sent, report: off.report }))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-arena-face-pass: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
