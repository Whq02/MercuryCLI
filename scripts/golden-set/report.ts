import { readFileSync } from 'node:fs'
import { GOLDEN_TASKS } from './tasks.ts'

export interface RunRow {
  task: string
  name: string
  model: string
  run: number
  state: 'measured' | 'deferred'
  completed: boolean | null
  wrong_tool_calls: number | null
  wrong_tools: string[]
  calls: number | null
  repeated_identical_calls: number | null
  tokens_in: number | null
  tokens_out: number | null
  seconds: number | null
  commit: string
  transcript: string | null
  stderr: string | null
  fixture_evidence: string | null
  exit_code: number | null
  outcome: string
  answer: string
  reasons: string[]
  change_tools: string[]
  changed_files: string[]
  sentence_under_test: string
}

export interface Baseline {
  schema: 1
  commit: string
  src_tree: string
  bundle_sha256: string
  fixture_sha256: string
  task_sha256: string
  created_at: string
  limits: { maxTime: number; maxTurns: number; budget: number; effort: string }
  rows: RunRow[]
}

function cell(value: unknown): string {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function markdownOf(baseline: Baseline): string {
  const { rows, limits } = baseline
  const lines = [
    '# Golden-set baseline',
    '',
    `Mercury commit: \`${baseline.commit}\`; src tree: \`${baseline.src_tree}\`. Created ${baseline.created_at}.`,
    '',
    `Bundle SHA-256: \`${baseline.bundle_sha256}\`. Fixture SHA-256: \`${baseline.fixture_sha256}\`.`,
    '',
    `Per measured run: effort ${limits.effort}, at most ${limits.maxTurns} turns, ${limits.maxTime} seconds, and $${limits.budget.toFixed(2)}. Each attempt has a fresh fixture and scratch config home. Failed attempts are retained, not retried. Tokens in include cache reads/writes. Repeated counts canonical identical tool calls after their first occurrence; identical calls are a polling signal, not proof of polling.`,
    '',
    'Claude rows marked deferred have not run: the lead runs them from the main loop. An em dash is missing measurement, never zero.',
    '',
    '| Task | Model | Run | Completed | Wrong-tool calls | Calls | Repeated | Tokens in | Tokens out | Seconds | Commit | Transcript / deferral |',
    '| --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  ]
  const metric = (value: number | null): string => value === null ? '—' : String(value)
  for (const row of rows) lines.push(`| ${row.task} ${cell(row.name)} | ${cell(row.model)} | ${row.run} | ${row.completed === null ? 'deferred' : row.completed ? 'yes' : 'no'} | ${metric(row.wrong_tool_calls)}${row.wrong_tools.length ? `: ${cell(row.wrong_tools.join('; '))}` : ''} | ${metric(row.calls)} | ${metric(row.repeated_identical_calls)} | ${metric(row.tokens_in)} | ${metric(row.tokens_out)} | ${row.seconds === null ? '—' : row.seconds.toFixed(3)} | ${row.commit.slice(0, 12)} | ${row.transcript ? `\`${row.transcript}\`` : cell(row.reasons.join('; '))} |`)
  lines.push('', '## Per-task summary', '', '| Task | Model | Completed | Wrong-tool calls | Mean calls | Mean tokens in | Mean tokens out | Mean seconds |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  const models = [...new Set(rows.map(row => row.model))]
  for (const task of GOLDEN_TASKS) for (const model of models) {
    const selected = rows.filter(row => row.task === task.id && row.model === model)
    if (!selected.length) continue
    const measured = selected.filter(row => row.state === 'measured')
    const mean = (pick: (row: RunRow) => number | null): string => measured.length ? (measured.reduce((sum, row) => sum + (pick(row) ?? 0), 0) / measured.length).toFixed(1) : '—'
    lines.push(`| ${task.id} ${task.name} | ${cell(model)} | ${measured.length ? `${measured.filter(row => row.completed).length}/${measured.length}` : 'lead runs from the main loop'} | ${measured.length ? measured.reduce((sum, row) => sum + (row.wrong_tool_calls ?? 0), 0) : '—'} | ${mean(row => row.calls)} | ${mean(row => row.tokens_in)} | ${mean(row => row.tokens_out)} | ${mean(row => row.seconds)} |`)
  }
  lines.push('', '## Sentences under test', '')
  for (const task of GOLDEN_TASKS.filter(task => rows.some(row => row.task === task.id))) lines.push(`- **${task.id}**: ${task.sentenceUnderTest}`)
  lines.push('', '## Failed measured rows', '')
  for (const row of rows.filter(row => row.state === 'measured' && !row.completed)) lines.push(`- ${row.task} ${row.model} run ${row.run}: ${row.reasons.join('; ')}. Outcome: ${row.outcome}.`)
  lines.push('', '## Observations', '', 'The table records measurements. Transcript-grounded observations are added after the linked rows have been inspected; this is not an ablation and cannot establish that a sentence caused success or failure.', '')
  return lines.join('\n')
}

export function compareBaselines(beforePath: string, afterPath: string): string {
  const before = JSON.parse(readFileSync(beforePath, 'utf8')) as Baseline
  const after = JSON.parse(readFileSync(afterPath, 'utf8')) as Baseline
  if (before.fixture_sha256 !== after.fixture_sha256 || before.task_sha256 !== after.task_sha256) throw new Error('fixture or tasks changed; these are not comparable baselines')
  const key = (row: RunRow): string => `${row.task} / ${row.model} / run ${row.run}`
  const old = new Map(before.rows.filter(row => row.state === 'measured').map(row => [key(row), row]))
  const lines = [`Task flips: ${before.commit} → ${after.commit}`]
  let flips = 0
  for (const row of after.rows.filter(row => row.state === 'measured')) {
    const previous = old.get(key(row))
    if (!previous) {
      lines.push(`UNMATCHED ${key(row)}`)
      continue
    }
    old.delete(key(row))
    if (previous.completed !== row.completed) {
      flips++
      lines.push(`FLIP ${key(row)}: ${previous.completed ? 'completed' : 'failed'} → ${row.completed ? 'completed' : 'failed'}\n  before: ${previous.transcript}\n  after:  ${row.transcript}`)
    }
  }
  for (const key of old.keys()) lines.push(`UNMATCHED ${key}`)
  if (!flips) lines.push('No matched task/run changed completion.')
  return lines.join('\n')
}
