#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import {
  type ArenaRun,
  grabScreens,
  requireDist,
  runArtifactArena,
  sendStamp,
} from '../streaming/artifactArena.ts'

requireDist()

const onlyArg = process.argv.find(a => a.startsWith('--only='))
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean)) : null
const KEEP = process.argv.includes('--keep')
const CAPTURE_DIR = process.env.MERCURY_CARD_FIT_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const CTRL_F = '\\x06'
const RESIZE_AT = 15000
const CHORD_AFTER_RESIZE = [17500, 20000]

const paragraph = (i: number): string => {
  let s = `Paragraph ${String(i + 1).padStart(2, '0')} of the handoff: `
  let k = 0
  while (s.length < 350) s += `word${(k++ % 9) + 1} `
  return s.slice(0, 350)
}
const LONG_BEFORE = Array.from({ length: 20 }, (_, i) => paragraph(i)).join('\n') + '\n'
const LONG_AFTER = LONG_BEFORE.replaceAll('of the handoff', 'of the revised handoff')
const numbered = (n: number, word: string): string => Array.from({ length: n }, (_, i) => `${word} ${i + 1} of the body`).join('\n') + '\n'

type Scene = {
  id: string
  title: string
  needle: string
  overHeight: boolean
  beyondCut: [string, string]
  turns: (cwd: string) => ScriptedTurn[]
  seed?: (configDir: string, cwd: string) => void
}

const SCENES: Scene[] = [
  {
    id: 'edit',
    title: 'Edit file',
    needle: 'Do you want to make this edit',
    overHeight: true,
    beyondCut: ['Paragraph 04', 'Paragraph 07'],
    turns: cwd => [
      { kind: 'tool_use', preText: 'Reading the handoff.\n', name: 'Read', input: { file_path: join(cwd, 'HANDOFF.md') } },
      { kind: 'tool_use', preText: 'Editing the handoff.\n', name: 'Edit', input: { file_path: join(cwd, 'HANDOFF.md'), old_string: LONG_BEFORE, new_string: LONG_AFTER } },
      { kind: 'text', text: 'Done.' },
    ],
    seed: (_configDir, cwd) => writeFileSync(join(cwd, 'HANDOFF.md'), LONG_BEFORE),
  },
  {
    id: 'write',
    title: 'Create file',
    needle: 'Do you want to create',
    overHeight: true,
    beyondCut: ['line 12 of the body', 'line 22 of the body'],
    turns: cwd => [
      { kind: 'tool_use', preText: 'Writing a file.\n', name: 'Write', input: { file_path: join(cwd, 'fresh.txt'), content: numbered(60, 'line') } },
      { kind: 'text', text: 'Done.' },
    ],
  },
  {
    id: 'notebook',
    title: 'Edit notebook',
    needle: 'Do you want to make this edit',
    overHeight: true,
    beyondCut: ['row 12 of the body', 'row 22 of the body'],
    turns: cwd => [
      { kind: 'tool_use', preText: 'Reading the notebook.\n', name: 'Read', input: { file_path: join(cwd, 'book.ipynb') } },
      { kind: 'tool_use', preText: 'Editing a cell.\n', name: 'NotebookEdit', input: { notebook_path: join(cwd, 'book.ipynb'), cell_id: 'c0', new_source: numbered(60, 'row'), cell_type: 'code', edit_mode: 'replace' } },
      { kind: 'text', text: 'Done.' },
    ],
    seed: (_configDir, cwd) =>
      writeFileSync(
        join(cwd, 'book.ipynb'),
        JSON.stringify({
          cells: [{ id: 'c0', cell_type: 'code', source: ['print("one")\n'], metadata: {}, outputs: [], execution_count: null }],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        }),
      ),
  },
  {
    id: 'bash',
    title: 'Bash command',
    needle: 'Do you want to proceed',
    overHeight: true,
    beyondCut: ['line 12 of the body', 'line 22 of the body'],
    turns: () => [
      { kind: 'tool_use', preText: 'Writing the notes.\n', name: 'Bash', input: { command: `cat <<'NOTES' > notes.txt\n${numbered(60, 'line')}NOTES`, description: 'write the notes' } },
      { kind: 'text', text: 'Done.' },
    ],
  },
  {
    id: 'webfetch',
    title: 'Fetch',
    needle: 'Do you want to allow Mercury to fetch',
    overHeight: false,
    beyondCut: ['', ''],
    turns: () => [
      { kind: 'tool_use', preText: 'Fetching the page.\n', name: 'WebFetch', input: { url: 'https://example.invalid/handoff', prompt: Array.from({ length: 60 }, (_, i) => `clause ${i + 1} of the prompt asks for the handoff's summary in plain words`).join('; ') } },
      { kind: 'text', text: 'Done.' },
    ],
  },
]

function sessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sessionFiles(path))
    else if (name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

const rowsHaving = (rows: string[], needle: string): boolean => rows.some(r => r.includes(needle))
const optionsRow = (rows: string[]): boolean => rows.some(r => /(?:❯\s*)?1\. Yes/.test(r))
const tailRow = (rows: string[]): boolean => rows.some(r => r.includes('more line') && r.includes('ctrl+f expands'))
const bandRow = (rows: string[]): boolean => rows.some(r => r.includes('this session') || r.includes('SESSIONS'))

function dump(id: string, label: string, rows: string[]): void {
  if (!CAPTURE_DIR) return
  writeFileSync(join(CAPTURE_DIR, `${id}--${label}.txt`), rows.map(r => r.replace(/\s+$/, '')).join('\n') + '\n')
}
function printFrame(label: string, rows: string[]): void {
  console.log(`\n┌── ${label} ──`)
  for (const r of rows) console.log(`│${r.replace(/\s+$/, '')}`)
  console.log('└──')
}

const chordSends = (run: ArenaRun): number[] =>
  run.sendLog.filter(s => Buffer.from(s.b64, 'base64').toString('latin1') === '\x06').map(s => sendStamp(run, s))

for (const scene of SCENES) {
  if (ONLY && !ONLY.has(scene.id)) continue
  section(`${scene.id} — an over-height ${scene.title} body at 100×30, the chord, the resize, the chord`)
  const run = await runArtifactArena({
    cols: 100,
    rows: 30,
    turns: scene.turns,
    seedHome: scene.seed,
    sends: [
      'after:Type a prompt:300:hello',
      'after:hello:400:\\r',
      `after:${scene.needle}:1500:${CTRL_F}`,
      `after:${scene.needle}:3500:${CTRL_F}`,
      ...CHORD_AFTER_RESIZE.map(at => `${at}:${CTRL_F}`),
    ],
    resizes: [`${RESIZE_AT}:120:40`],
    seconds: 24,
    keep: true,
  })
  const chords = chordSends(run)
  check(`${scene.id}: the four chords were delivered (the card painted its needle)`, chords.length === 4, `chords at ${chords.join(', ')} · driver: ${run.driverOut.slice(-300)}`)
  if (chords.length === 4) {
    const [c1, c2, c3, c4] = chords as [number, number, number, number]
    const [f1, f2, f3] = grabScreens(run, 100, 30, [c1 - 600, c1 + 900, c2 + 900])
    const [f4, f5, f6] = grabScreens(run, 120, 40, [c3 - 600, c3 + 900, c4 + 900])
    const frames: Array<[string, string[], 'collapsed' | 'expanded', string]> = [
      ['100x30-collapsed', f1!.rows, 'collapsed', scene.beyondCut[0]],
      ['100x30-expanded', f2!.rows, 'expanded', scene.beyondCut[0]],
      ['100x30-collapsed-again', f3!.rows, 'collapsed', scene.beyondCut[0]],
      ['120x40-collapsed', f4!.rows, 'collapsed', scene.beyondCut[1]],
      ['120x40-expanded', f5!.rows, 'expanded', scene.beyondCut[1]],
      ['120x40-collapsed-again', f6!.rows, 'collapsed', scene.beyondCut[1]],
    ]
    for (const [label, rows, state, beyond] of frames) {
      dump(scene.id, label, rows)
      if (!scene.overHeight) {
        check(`${scene.id} ${label}: the card title is on the frame`, rowsHaving(rows, scene.title))
        check(`${scene.id} ${label}: the options row is ON the frame`, optionsRow(rows))
        check(`${scene.id} ${label}: no tail — the body fits whole`, !tailRow(rows))
        check(`${scene.id} ${label}: the frame band beneath the card is still on the pane`, bandRow(rows))
      } else if (state === 'collapsed') {
        check(`${scene.id} ${label}: the card title is on the frame`, rowsHaving(rows, scene.title))
        check(`${scene.id} ${label}: the options row is ON the frame`, optionsRow(rows))
        check(`${scene.id} ${label}: the tail names the cut and the chord`, tailRow(rows))
        check(`${scene.id} ${label}: the frame band beneath the card is still on the pane`, bandRow(rows))
        check(`${scene.id} ${label}: the body beyond the cut (${beyond}) is not painted`, !rowsHaving(rows, beyond))
      } else {
        check(`${scene.id} ${label}: the collapsed tail is gone`, !tailRow(rows))
        check(`${scene.id} ${label}: the body beyond the cut (${beyond}) is painted — the whole body, on the explicit chord`, rowsHaving(rows, beyond))
      }
    }
    printFrame(`${scene.id} 100x30 collapsed`, f1!.rows)
    printFrame(`${scene.id} 120x40 collapsed`, f4!.rows)
  } else {
    const [final] = grabScreens(run, 120, 40, [-1])
    printFrame(`${scene.id} final screen (no card needle)`, final!.rows)
  }
  if (!KEEP) run.cleanup()
}

if (!ONLY || ONLY.has('sovereign')) {
  section('sovereign — an edit to .mercury/HANDOFF.md under the bypass posture paints NO card')
  const SHORT_BEFORE = 'alpha line one\nbeta line two\n'
  const SHORT_AFTER = 'alpha line one\ngamma line two\n'
  const run = await runArtifactArena({
    cols: 110,
    rows: 40,
    turns: cwd => [
      { kind: 'tool_use', preText: 'Reading the handoff.\n', name: 'Read', input: { file_path: join(cwd, '.mercury', 'HANDOFF.md') } },
      { kind: 'tool_use', preText: 'Editing the handoff.\n', name: 'Edit', input: { file_path: join(cwd, '.mercury', 'HANDOFF.md'), old_string: SHORT_BEFORE, new_string: SHORT_AFTER } },
      { kind: 'text', text: 'Done.' },
    ],
    seedHome: (configDir, cwd) => {
      mkdirSync(join(cwd, '.mercury'), { recursive: true })
      writeFileSync(join(cwd, '.mercury', 'HANDOFF.md'), SHORT_BEFORE)
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }))
    },
    extraEnv: { MERCURY_SKIP_PERMISSIONS: '1' },
    sends: ['after:Type a prompt:300:hello', 'after:hello:400:\\r'],
    seconds: 22,
    keep: true,
  })
  const [final] = grabScreens(run, 110, 40, [-1])
  const rows = final!.rows
  dump('sovereign', 'final', rows)
  printFrame('sovereign final', rows)
  const edited = existsSync(join(run.paths.cwd, '.mercury', 'HANDOFF.md')) ? readFileSync(join(run.paths.cwd, '.mercury', 'HANDOFF.md'), 'utf8') : ''
  check('sovereign: the turn settled (the fixture\'s closing text landed)', rowsHaving(rows, 'Done.'), run.driverOut.slice(-300))
  check('sovereign: NO consent card painted (no question row)', !rowsHaving(rows, 'Do you want to'))
  check('sovereign: NO consent card painted (no card title)', !rowsHaving(rows, '⦿ Edit file'))
  check('sovereign: the edit landed on disk', edited.includes('gamma line two'))
  check('sovereign: the transcript row names the allowance with the posture\'s word', rowsHaving(rows, 'Allowed by sovereign mode'))
  check('sovereign: …and the road\'s own sentence (the sensitive-file check)', rowsHaving(rows, 'Allowed by sovereign mode') && rowsHaving(rows, 'sensitive file'))
  const persisted = sessionFiles(join(run.paths.home, '.claude', 'projects'))
    .map(f => readFileSync(f, 'utf8'))
    .some(text => text.includes('"bypassed_ask"') && text.includes('"safetyCheckAsk"') && text.includes('sensitive file'))
  check('sovereign: the allowance row persists in the session file (the posture, the road, the sentence)', persisted)
  if (!KEEP) run.cleanup()
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-consent-card-fits-drive: ALL LAWS HOLD' : `prove-consent-card-fits-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
