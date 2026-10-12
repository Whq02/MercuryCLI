#!/usr/bin/env bun
// gate-watch: src/components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.tsx src/components/permissions/PermissionRequest.tsx
// gate-watch: src/tools/FileEditTool/sectionEdit.ts src/tools/FileEditTool/UI.tsx src/tools/RecordConventionTool/RecordConventionTool.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { type ArenaRun, grabScreens, requireDist, runArtifactArena, sendStamp } from '../streaming/artifactArena.ts'

requireDist()

const onlyArg = process.argv.find(a => a.startsWith('--only='))
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean)) : null
const KEEP = process.argv.includes('--keep')
const RECORD = process.argv.includes('--record')
const FRAMES = join(import.meta.dir, 'fixtures', 'file-cards')
if (RECORD) mkdirSync(FRAMES, { recursive: true })

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

const CARD_NOMINAL_MS = 8000
const NOTES = [
  '# Notes',
  '',
  '## Shopping list',
  '',
  '- apples',
  '- sourdough bread',
  '- coffee',
  '',
  '## Ideas',
  '',
  '1. Write a tiny parser',
  '2. Draw a map',
  '3. Learn the cello',
].join('\n') + '\n'
const NONL = 'first line\nSECOND LINE\nlast line without newline'

type Scene = {
  id: string
  title: string
  needle: string
  turns: (cwd: string) => ScriptedTurn[]
  seed?: Record<string, string>
  mustShow: string[]
  mustNotShow: string[]
  noRowLike?: RegExp
  disk?: (cwd: string) => boolean
}

const SCENES: Scene[] = [
  {
    id: 'append',
    title: 'Edit file',
    needle: 'Do you want to make this edit',
    seed: { 'NOTES.md': NOTES },
    turns: cwd => [
      { kind: 'tool_use', preText: 'Adding the line.\n', name: 'Edit', input: { file_path: join(cwd, 'NOTES.md'), append: 'tail line' } },
      { kind: 'text', text: 'Done.' },
    ],
    mustShow: ['+tail line', '3. Learn the cello'],
    mustNotShow: ['-# Notes', '-## Shopping list', '-3. Learn the cello', 'no visible change'],
    noRowLike: /│\s+\d+\s-/,
    disk: cwd => readFileSync(join(cwd, 'NOTES.md'), 'utf8') === `${NOTES}tail line\n`,
  },
  {
    id: 'append-nonl',
    title: 'Edit file',
    needle: 'Do you want to make this edit',
    seed: { 'nonl.txt': NONL },
    turns: cwd => [
      { kind: 'tool_use', preText: 'Adding the line.\n', name: 'Edit', input: { file_path: join(cwd, 'nonl.txt'), append: 'tail line' } },
      { kind: 'text', text: 'Done.' },
    ],
    mustShow: ['+tail line'],
    mustNotShow: ['-first line', '-SECOND LINE', 'no visible change'],
    disk: cwd => readFileSync(join(cwd, 'nonl.txt'), 'utf8') === `${NONL}\ntail line`,
  },
  {
    id: 'append-empty',
    title: 'Edit file',
    needle: 'Do you want to make this edit',
    seed: { 'empty.txt': '' },
    turns: cwd => [
      { kind: 'tool_use', preText: 'Filling the file.\n', name: 'Edit', input: { file_path: join(cwd, 'empty.txt'), append: 'now not empty' } },
      { kind: 'text', text: 'Done.' },
    ],
    mustShow: ['+now not empty'],
    mustNotShow: ['no visible change'],
    disk: cwd => readFileSync(join(cwd, 'empty.txt'), 'utf8') === 'now not empty\n',
  },
]

const RULE = 'Always run the tests with python -m unittest discover tests, never pytest'
SCENES.push({
  id: 'convention',
  title: 'Record a convention',
  needle: 'Do you want to record this rule in',
  turns: () => [
    { kind: 'tool_use', preText: 'Recording the rule.\n', name: 'RecordConvention', input: { rule: RULE } },
    { kind: 'text', text: 'Done.' },
  ],
  mustShow: ['MERCURY.md', `+- ${RULE}`],
  mustNotShow: ['⦿ Tool use', 'Record a durable project convention the user stated'],
  disk: cwd => existsSync(join(cwd, 'MERCURY.md')) && readFileSync(join(cwd, 'MERCURY.md'), 'utf8').endsWith(`\n- ${RULE}\n`),
})

const FIRST_RULE = 'Never change the existing tests in the tests folder without asking first'
SCENES.push({
  id: 'convention-append',
  title: 'Record a convention',
  needle: 'Do you want to record this rule in',
  seed: { 'MERCURY.md': `# MERCURY.md\nStanding orders for the Mercury harness in this repository.\n\n- ${FIRST_RULE}\n` },
  turns: () => [
    { kind: 'tool_use', preText: 'Recording the rule.\n', name: 'RecordConvention', input: { rule: RULE } },
    { kind: 'text', text: 'Done.' },
  ],
  mustShow: ['MERCURY.md', `+- ${RULE}`, `- ${FIRST_RULE}`],
  mustNotShow: ['⦿ Tool use', `-- ${FIRST_RULE}`, '-# MERCURY.md'],
  noRowLike: /│\s+\d+\s-/,
  disk: cwd => readFileSync(join(cwd, 'MERCURY.md'), 'utf8') === `# MERCURY.md\nStanding orders for the Mercury harness in this repository.\n\n- ${FIRST_RULE}\n- ${RULE}\n`,
})

const rowsHaving = (rows: string[], needle: string): boolean => rows.some(r => r.includes(needle))
const cardRows = (rows: string[]): string[] => {
  const start = rows.findIndex(r => r.includes('⦿ '))
  if (start === -1) return []
  const end = rows.findIndex((r, i) => i > start && /^\s*╰/.test(r))
  return rows.slice(start, end === -1 ? rows.length : end + 1)
}
const trimRows = (rows: string[]): string => rows.map(r => r.replace(/\s+$/, '')).join('\n') + '\n'
function printFrame(label: string, rows: string[]): void {
  console.log(`\n┌── ${label} ──`)
  for (const r of rows) console.log(`│${r.replace(/\s+$/, '')}`)
  console.log('└──')
}
const needleSends = (run: ArenaRun): number[] => run.sendLog.filter(s => Buffer.from(s.b64, 'base64').toString('latin1') === '1').map(s => sendStamp(run, s))

for (const scene of SCENES) {
  if (ONLY && !ONLY.has(scene.id)) continue
  section(`${scene.id} — the ${scene.title} card says what it will do`)
  const run = await runArtifactArena({
    cols: 100,
    rows: 30,
    turns: scene.turns,
    seedCwd: scene.seed ?? {},
    sends: ['after:Type a prompt:300:hello', 'after:hello:400:\\r', `after:${scene.needle}:2500:1`],
    anchor: { needle: scene.needle, atMs: CARD_NOMINAL_MS },
    seconds: 20,
    keep: true,
  })
  const yesAt = needleSends(run)[0]
  check(`${scene.id}: the card painted its question and was answered`, yesAt !== undefined, run.driverOut.slice(-300))
  if (yesAt !== undefined) {
    const [card] = grabScreens(run, 100, 30, [yesAt - 800])
    const rows = card!.rows
    printFrame(`${scene.id} card at 100x30`, rows)
    const body = cardRows(rows)
    check(`${scene.id}: the card title is on the frame`, rowsHaving(body, scene.title), body.join(' | ').slice(0, 200))
    for (const needle of scene.mustShow) check(`${scene.id}: the card shows "${needle}"`, rowsHaving(body, needle), body.join('\n').slice(0, 600))
    for (const needle of scene.mustNotShow) check(`${scene.id}: the card does not show "${needle}"`, !rowsHaving(body, needle), body.join('\n').slice(0, 600))
    if (scene.noRowLike) check(`${scene.id}: no row of the card reads as a deleted line`, !body.some(r => scene.noRowLike!.test(r)), body.filter(r => scene.noRowLike!.test(r)).join(' | '))
    const stored = join(FRAMES, `${scene.id}-100x30.txt`)
    if (RECORD) writeFileSync(stored, trimRows(body))
    check(`${scene.id}: the card rows equal the stored frame ${stored.replace(`${import.meta.dir}/`, '')}`, existsSync(stored) && readFileSync(stored, 'utf8') === trimRows(body), existsSync(stored) ? 'rows differ' : 'no stored frame — run with --record')
  }
  const [final] = grabScreens(run, 100, 30, [-1])
  check(`${scene.id}: the turn settled`, rowsHaving(final!.rows, 'Done.'), final!.rows.slice(-8).join(' | '))
  if (scene.disk) check(`${scene.id}: the disk holds what the card said`, scene.disk(run.paths.cwd))
  if (!KEEP) run.cleanup()
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
