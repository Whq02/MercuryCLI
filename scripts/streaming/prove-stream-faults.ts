#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runArtifactArena, type ArenaOpts, type ArenaRun } from './artifactArena.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

function finalScreen(run: ArenaRun, cols = 120, rows = 40): string {
  const res = spawnSync(
    '/usr/bin/python3',
    [join(HERE, 'screengrab.py'), run.paths.drive, String(cols), String(rows), '-1'],
    { encoding: 'utf8', timeout: 60_000 },
  )
  return (JSON.parse(res.stdout) as { screens: { rows: string[] }[] }).screens[0]!.rows.join('\n')
}

async function scene(
  name: string,
  opts: Omit<ArenaOpts, 'keep'>,
  asserts: (fin: string, run: ArenaRun) => void,
): Promise<void> {
  const run = await runArtifactArena({ ...opts, keep: true })
  const fin = finalScreen(run, opts.cols ?? 120, opts.rows ?? 40)
  check(`${name}: composer usable at settle`, /type a prompt|↵ sends|\? for shortcuts/i.test(fin), 'the final screen shows no composer after the fault; this runs dist/mercury.mjs, so rebuild with bun run build.ts first, then look at how the turn ends after this fault')
  check(`${name}: no residual spinner`, !/\(\d+s · ↑/.test(fin), 'a spinner line such as (12s · ↑ is still on the final screen; the turn did not clear its busy state after this fault')
  asserts(fin, run)
  run.cleanup()
}

console.log('── FLUX S9 fault scenes (shipped artifact) ──')

await scene(
  'F1 pre-token error',
  {
    turns: [{ kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'fixture pre-token failure' }],
    sends: ['4500:hello', '5300:\\r'],
    seconds: 11,
  },
  fin => {
    check('F1: the error surfaced honestly', /[Ee]rror|failure|API/.test(fin), 'the final screen has no error text after a 400 before any token; the failed turn must print its error')
  },
)

await scene(
  'F2 mid-paragraph death',
  {
    turns: [{ kind: 'die', deltas: ['alpha bravo ', 'charlie ', 'delta '], whenModel: 'opus' }],
    sends: ['4500:hello', '5300:\\r'],
    seconds: 16,
  },
  fin => {
    check(
      'F2: honest outcome (partial text or a surfaced error, never silence)',
      /alpha bravo/.test(fin) || /[Ee]rror|interrupt|connection|fail/i.test(fin),
      'the final screen has neither the partial text nor an error after the stream died mid-paragraph; a dead stream must show one of them',
    )
  },
)

await scene(
  'F3 tool failure',
  {
    turns: cwd => [
      { kind: 'tool_use', name: 'Read', input: { file_path: `${cwd}/flux-missing.txt` } },
      { kind: 'text', text: 'recovered after the tool error.', whenModel: 'opus' },
    ],
    sends: ['4500:hello', '5300:\\r'],
    seconds: 14,
  },
  fin => {
    check('F3: the recovery turn painted', fin.includes('recovered after the tool error.'), 'the turn after the failed Read tool call never painted its text; the loop must continue after a tool error')
    check(
      'F3: errored work wears ✕ in the row lead (never ▲)',
      /│ ✕ (?:\d\d:\d\d:\d\d )?\[Mercury\] Read/.test(fin) && !fin.includes('▲'),
      'an errored tool row must wear ✕ in the row lead before the nameplate (not ▲)',
    )
  },
)

await scene(
  'F4 cancel-vs-completion race',
  {
    turns: [{ kind: 'paced', deltas: Array.from({ length: 50 }, (_, i) => `race${i} `), gapMs: 40, whenModel: 'opus' }],
    sends: ['4500:hello', '5300:\\r', '7500:\\x1b'],
    seconds: 12,
  },
  fin => {
    const completed = fin.includes('race49')
    const interrupted = /[Ii]nterrupted/.test(fin)
    check('F4: exactly one honest terminal state', completed || interrupted, 'neither completion nor interruption visible')
  },
)

{
  const run = await runArtifactArena({
    turns: [{ kind: 'paced', deltas: Array.from({ length: 100 }, (_, i) => (i % 4 === 3 ? `rs${i}.\n` : `rs${i} `)), gapMs: 40, whenModel: 'opus' }],
    sends: ['4500:hello', '5300:\\r'],
    seconds: 14,
    keep: true,
    resizes: ['7000:100:30', '7400:140:45', '7800:90:28', '8200:120:40'],
  })
  const fin = finalScreen(run, 120, 40)
  check('F5 resize storm: composer usable at settle', /type a prompt|↵ sends|\? for shortcuts/i.test(fin), 'the final screen shows no composer after the resizes; this runs dist/mercury.mjs, so rebuild with bun run build.ts first')
  check('F5: no residual spinner', !/\(\d+s · ↑/.test(fin), 'a spinner line such as (12s · ↑ is still on the final screen after the resizes')
  check('F5: the stream settled at the final geometry', fin.includes('rs99'), 'the last streamed chunk rs99 is missing from the final screen after the resizes; the stream must repaint fully at the final size')
  run.cleanup()
}

await scene(
  'F6 malformed markdown tail',
  {
    turns: [
      {
        kind: 'paced',
        whenModel: 'opus',
        deltas: ['Some prose first.\n\n', '```ts\n', 'const x = ', '1\n', '| a | b\n', '|---'],
        gapMs: 60,
      },
    ],
    sends: ['4500:hello', '5300:\\r'],
    seconds: 12,
  },
  fin => {
    check('F6: the malformed tail rendered without a wedge', fin.includes('Some prose first.'), 'the prose before the unterminated code fence and table is missing from the final screen; a malformed markdown tail must not stop earlier text from painting')
  },
)

await scene(
  'F7 cancel → resubmit',
  {
    turns: [
      { kind: 'hang', deltas: ['first turn text '], whenModel: 'opus' },
      { kind: 'text', text: 'second answer.', whenModel: 'opus' },
    ],
    sends: [
      '4500:hello', '5300:\\r',
      'after:first turn text:800:\\x1b',
      'after:nterrupted:600:again',
      'after:nterrupted:1400:\\r',
    ],
    seconds: 16,
  },
  fin => {
    check('F7: turn 1 interrupted honestly', /[Ii]nterrupted/.test(fin) && fin.includes('first turn text'), 'the final screen lacks Interrupted or the text streamed before Escape; a cancelled turn must keep its partial text and say it was interrupted')
    check('F7: turn 2 answered', fin.includes('second answer.'), 'the prompt typed after the interrupt got no answer; a cancelled turn must leave the composer able to submit again')
  },
)

console.log(failures === 0 ? '✅ FLUX stream-faults GREEN' : `❌ FLUX stream-faults RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
