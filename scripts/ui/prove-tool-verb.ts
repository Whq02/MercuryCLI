#!/usr/bin/env bun
// prove-tool-verb.ts — table-locks the live spinner narrator's per-tool verb
// (utils/cockpit/toolVerb.ts): the mapping, clipping, honest-undefined for
// unmappable tools, and the transcript-tail scan that resolves the NEWEST
// in-flight tool.

import { activeToolVerb, toolVerbFor } from '../../src/utils/cockpit/toolVerb.js'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// ── toolVerbFor table ──
const cases: Array<[string, Record<string, unknown> | undefined, string | undefined]> = [
  ['Bash', { command: 'bun run build.ts' }, 'Running bun run build.ts'],
  ['Bash', { command: '  git   status\n--short  ' }, 'Running git status --short'],
  ['Bash', {}, 'Running a command'],
  ['Read', { file_path: '/a/b/HelmHome.tsx' }, 'Reading HelmHome.tsx'],
  //  (WP-6): Windows paths show the FILENAME, not the drive tail.
  ['Read', { file_path: 'C:\\CDay\\deadnight-del\\scene.gd' }, 'Reading scene.gd'],
  ['Grep', { pattern: 'setTimeout' }, 'Searching setTimeout'],
  ['Glob', { pattern: 'src/**/*.tsx' }, 'Globbing src/**/*.tsx'],
  ['Edit', { file_path: '/x/Deck.tsx' }, 'Editing Deck.tsx'],
  ['Write', { file_path: '/x/notes.md' }, 'Writing notes.md'],
  ['NotebookEdit', { notebook_path: '/n/b.ipynb' }, 'Editing b.ipynb'],
  ['WebFetch', { url: 'https://docs.anthropic.com/x/y' }, 'Fetching docs.anthropic.com'],
  ['WebSearch', { query: 'x' }, 'Searching the web'],
  ['Task', {}, 'Delegating'],
  ['mcp__weird__tool', { a: 1 }, undefined], // no honest short story ⇒ fall through
  ['SomethingNew', undefined, undefined],
]
for (const [name, input, want] of cases) {
  const got = toolVerbFor(name, input)
  t(`${name} ⇒ ${JSON.stringify(want)}`, got === want, JSON.stringify(got))
}

// clipping: long commands clip at 24 with an ellipsis, single-line
{
  const got = toolVerbFor('Bash', {
    command: 'bash scripts/run-all-suites.sh with a very long tail of arguments',
  })
  t('long command clips (≤ "Running " + 24)', !!got && got.length <= 'Running '.length + 24, got)
  t('clip ends with …', !!got && got.endsWith('…'))
}

// ── activeToolVerb transcript-tail scan ──
const asst = (blocks: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content: blocks } })
const tu = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input })
const msgs = [
  asst([tu('t1', 'Read', { file_path: '/a/old.ts' })]),
  { type: 'user', message: { role: 'user', content: 'x' } },
  asst([tu('t2', 'Bash', { command: 'bun test' }), tu('t3', 'Edit', { file_path: '/a/live.ts' })]),
]
t('newest in-flight wins (t3 over t2)', activeToolVerb(msgs, new Set(['t2', 't3'])) === 'Editing live.ts')
t('only in-flight ids count (t2 alone)', activeToolVerb(msgs, new Set(['t2'])) === 'Running bun test')
t('nothing in flight ⇒ undefined', activeToolVerb(msgs, new Set()) === undefined)
t('unknown id ⇒ undefined', activeToolVerb(msgs, new Set(['zzz'])) === undefined)
t('scan limit bounds the walk (old tool outside window)', activeToolVerb(msgs, new Set(['t1']), 1) === undefined)
t('empty transcript ⇒ undefined', activeToolVerb([], new Set(['t1'])) === undefined)
t('malformed messages never throw', activeToolVerb([null, 42, { type: 'assistant' }, asst(['x'])], new Set(['t1'])) === undefined)

process.exit(fail)
