#!/usr/bin/env bun
// gate-watch: src/components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.tsx src/components/permissions/PermissionRequest.tsx
// gate-watch: src/tools/FileEditTool/sectionEdit.ts src/tools/FileEditTool/UI.tsx src/tools/RecordConventionTool/RecordConventionTool.ts
// gate-watch: src/components/permissions/GitPermissionRequest/GitPermissionRequest.tsx src/services/gitGraph/plan.ts src/services/gitGraph/observe.ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { type ArenaRun, grabScreens, requireDist, runArtifactArena, sendStamp } from '../streaming/artifactArena.ts'

requireDist()
const { preparePlan, _resetGitPlanStoreForTesting } = await import('../../src/services/gitGraph/plan.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

const onlyArg = process.argv.find(a => a.startsWith('--only='))
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean)) : null
const KEEP = process.argv.includes('--keep')
const RECORD = process.argv.includes('--record')
const FRAMES = join(import.meta.dir, 'fixtures', 'file-cards')
if (RECORD) mkdirSync(FRAMES, { recursive: true })
const frameDir = process.argv.includes('--frames') ? process.argv[process.argv.indexOf('--frames') + 1] : undefined
if (frameDir) mkdirSync(frameDir, { recursive: true })

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

SCENES.push({
  id: 'create-card',
  title: 'Create file',
  needle: 'Do you want to create',
  turns: cwd => [
    { kind: 'tool_use', preText: 'Writing the guide.\n', name: 'Write', input: { file_path: join(cwd, 'intro.md'), content: '# Intro\n\nThis guide explains how to get started with the project.\n' } },
    { kind: 'text', text: 'Done.' },
  ],
  mustShow: ['1  # Intro', '3  This guide explains how to get started with the project.'],
  mustNotShow: ['4  '],
  noRowLike: /│\s+4\s/,
  disk: cwd => readFileSync(join(cwd, 'intro.md'), 'utf8') === '# Intro\n\nThis guide explains how to get started with the project.\n',
})

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@local', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@local', GIT_AUTHOR_DATE: '2026-10-12T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-12T10:00:00Z' }
const COMMIT_SUBJECT = 'two files via the git tool'
const COMMIT_MESSAGE = `${COMMIT_SUBJECT}\n\nThe calculator and the notes, nothing else.`
let gitPlanId = ''
function seedGitRepo(cwd: string): void {
  const sh = (args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
  sh(['init', '--quiet', '--initial-branch=main'])
  for (const name of ['calc.py', 'NOTES.md', 'report.py']) writeFileSync(join(cwd, name), `${name} line one\n`)
  sh(['add', '.'])
  sh(['commit', '--quiet', '-m', 'seed'])
  for (const name of ['calc.py', 'NOTES.md', 'report.py']) writeFileSync(join(cwd, name), `${name} line one\n${name} line two\n`)
  sh(['add', '--', 'report.py'])
}
SCENES.push({
  id: 'git-apply',
  title: 'Git commit',
  needle: 'Do you want to proceed',
  turns: cwd => {
    seedGitRepo(cwd)
    const planned = preparePlan(processMainOwner(), cwd, [{ files: ['calc.py', 'NOTES.md'], message: COMMIT_MESSAGE }])
    gitPlanId = 'id' in planned ? planned.id : ''
    _resetGitPlanStoreForTesting()
    return [
      { kind: 'tool_use', preText: 'Planning the commit.\n', name: 'Git', input: { op: 'plan', groups: [{ files: ['calc.py', 'NOTES.md'], message: COMMIT_MESSAGE }] } },
      { kind: 'tool_use', preText: 'Committing.\n', name: 'Git', input: { op: 'apply', planId: gitPlanId } },
      { kind: 'text', text: 'Done.' },
    ]
  },
  mustShow: ['Git commit', `Commit: ${COMMIT_SUBJECT}`, 'calc.py, NOTES.md', 'The calculator and the notes, nothing else.', 'Stays uncommitted: report.py'],
  mustNotShow: ['⦿ Tool use', 'Typed local Git work graph', `Git(apply ${'gp-'}`],
  disk: cwd => {
    const sh = (args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV })
    const committed = sh(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort()
    const status = sh(['status', '--porcelain']).split('\n').filter(Boolean).sort()
    return sh(['log', '-1', '--format=%s']).trim() === COMMIT_SUBJECT && JSON.stringify(committed) === JSON.stringify(['NOTES.md', 'calc.py']) && JSON.stringify(status) === JSON.stringify(['M  report.py'])
  },
})

type RowScene = { id: string; seed: Record<string, string>; turns: (cwd: string) => ScriptedTurn[]; mustShow: string[]; mustNotShow: string[] }
const ROW_SCENES: RowScene[] = [
  {
    id: 'error-row',
    seed: { 'calc.py': 'def add(a, b):\n    return a + b\n' },
    turns: cwd => [
      { kind: 'tool_use', preText: 'Editing without a read.\n', name: 'Edit', input: { file_path: join(cwd, 'calc.py'), old_string: 'return a + b', new_string: 'return a - b' } },
      { kind: 'tool_use', preText: 'Reading it.\n', name: 'Read', input: { file_path: join(cwd, 'calc.py') } },
      { kind: 'tool_use', preText: 'Editing a line that is not there.\n', name: 'Edit', input: { file_path: join(cwd, 'calc.py'), old_string: 'return a * b', new_string: 'return a - b' } },
      { kind: 'text', text: 'Done.' },
    ],
    mustShow: ['▲ Read the file before editing it — it exists and was not read in this', "session, so it may be another session's work", '▲ The old_string was not found in the file.'],
    mustNotShow: ['▲ Error editing file'],
  },
]

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
    if (frameDir) writeFileSync(join(frameDir, `${scene.id}-100x30.txt`), trimRows(body))
    check(`${scene.id}: the card rows equal the stored frame ${stored.replace(`${import.meta.dir}/`, '')}`, existsSync(stored) && readFileSync(stored, 'utf8') === trimRows(body), existsSync(stored) ? 'rows differ' : 'no stored frame — run with --record')
  }
  const [final] = grabScreens(run, 100, 30, [-1])
  check(`${scene.id}: the turn settled`, rowsHaving(final!.rows, 'Done.'), final!.rows.slice(-8).join(' | '))
  if (scene.disk) check(`${scene.id}: the disk holds what the card said`, scene.disk(run.paths.cwd))
  if (!KEEP) run.cleanup()
}

for (const scene of ROW_SCENES) {
  if (ONLY && !ONLY.has(scene.id)) continue
  section(`${scene.id} — a refused edit's transcript row carries the reason in the tool's own words`)
  const run = await runArtifactArena({
    cols: 110,
    rows: 40,
    turns: scene.turns,
    seedCwd: scene.seed,
    sends: ['after:Type a prompt:300:hello', 'after:hello:400:\\r'],
    seconds: 18,
    keep: true,
  })
  const [final] = grabScreens(run, 110, 40, [-1])
  const rows = final!.rows.map(r => r.replace(/\s+$/, ''))
  printFrame(`${scene.id} final at 110x40`, rows)
  const joined = rows.join('\n')
  check(`${scene.id}: the turn settled`, rowsHaving(rows, 'Done.'), run.driverOut.slice(-300))
  for (const needle of scene.mustShow) check(`${scene.id}: a row reads "${needle}"`, joined.includes(needle), joined.slice(-900))
  for (const needle of scene.mustNotShow) check(`${scene.id}: no row reads "${needle}" (RED on the base: the bare line, no reason)`, !joined.includes(needle), joined.slice(-900))
  const stored = join(FRAMES, `${scene.id}-110x40.txt`)
  const pane = (r: string): string => r.replace(/\s*│\s*$/, '').replace(/^.*?│ ?/, '').replace(/^│ ?/, '').trimEnd()
  const rowsOfInterest = rows.filter((r, i) => r.includes('▲ ') || r.includes('▨ Update') || (i > 0 && rows[i - 1]!.includes('▲ ') && pane(r).trim() !== '')).map(pane)
  if (RECORD) writeFileSync(stored, rowsOfInterest.join('\n') + '\n')
  if (frameDir) writeFileSync(join(frameDir, `${scene.id}-110x40.txt`), rowsOfInterest.join('\n') + '\n')
  check(`${scene.id}: the error rows equal the stored frame ${stored.replace(`${import.meta.dir}/`, '')}`, existsSync(stored) && readFileSync(stored, 'utf8') === rowsOfInterest.join('\n') + '\n', existsSync(stored) ? `rows differ: ${rowsOfInterest.join(' | ')}` : 'no stored frame — run with --record')
  if (!KEEP) run.cleanup()
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
