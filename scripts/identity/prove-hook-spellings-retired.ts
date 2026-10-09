#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const J = (...parts: string[]): string => parts.join('')

const RETIRED_EVENTS = [
  J('Pre', 'ToolUse'), J('Post', 'ToolUse'), J('Post', 'ToolUseFailure'),
  J('User', 'PromptSubmit'), J('User', 'PromptExpansion'), J('Session', 'Start'), J('Session', 'End'),
  J('Stop', 'Failure'), J('Subagent', 'Start'), J('Subagent', 'Stop'), J('Pre', 'Compact'), J('Post', 'Compact'),
  J('Task', 'Created'), J('Task', 'Completed'), J('Elicitation', 'Result'), J('Config', 'Change'),
  J('Worktree', 'Create'), J('Worktree', 'Remove'), J('Instructions', 'Loaded'), J('Cwd', 'Changed'), J('File', 'Changed'),
]
const RETIRED_FIELDS = [
  J('hook', '_event_name'), J('hookSpecific', 'Output'), J('updatedMCP', 'ToolOutput'),
  J('suppress', 'Output'), J('stop_hook', '_active'), J('last_assistant', '_message'),
  J('http', 'Destinations'), J('http', 'Environment'), J('allowed', 'EnvVars'),
]
const RETIRED_WORDS = new RegExp(`\\b(${[...RETIRED_EVENTS, ...RETIRED_FIELDS].join('|')})\\b`)

const EXCLUDED: Array<[string, string]> = [
  ['docs/releases/', 'published release pages are history'],
  ['src/constants/changelog.ts', 'past release notes stay as published'],
  ['scripts/identity/prove-hook-spellings-retired.ts', 'this census composes the words it hunts'],
  ['scripts/identity/prove-retired-keys-unknown.ts', 'names the retired spellings it proves unknown'],
  ['scripts/sessionStorage/prove-old-transcript-kinds-parse.ts', 'holds old transcript rows by design'],
  ['scripts/ui/prove-old-transcript-rows.ts', 'holds old transcript rows by design'],
  ['scripts/interview/baselines/', 'frozen journey capture records'],
  ['scripts/visual-contract/baselines/', 'frozen capture records of earlier screens'],
  ['scripts/agent-experience/baselines/', 'frozen mechanical baselines of earlier prompts'],
  ['scripts/mission-runner/corpus/', 'fixture repositories of foreign source'],
]

const tracked = execFileSync('git', ['ls-files', 'src', 'docs', 'scripts'], { cwd: ROOT }).toString().split('\n').filter(Boolean)
const hits = new Map<string, number>()
for (const rel of tracked) {
  if (EXCLUDED.some(([prefix]) => rel.startsWith(prefix))) continue
  if (!/\.(ts|tsx|md|json|sh|mjs)$/.test(rel)) continue
  let text: string
  try {
    text = readFileSync(join(ROOT, rel), 'utf8')
  } catch {
    continue
  }
  let count = 0
  for (const line of text.split('\n')) if (RETIRED_WORDS.test(line)) count++
  if (count > 0) hits.set(rel, count)
}

const sorted = [...hits].sort((a, b) => b[1] - a[1])
for (const [rel, count] of sorted) console.log(`  ${String(count).padStart(4)}  ${rel}`)
console.log(`\nretired hook spellings: ${sorted.length} file(s), ${sorted.reduce((n, [, c]) => n + c, 0)} line(s)`)
if (sorted.length > 0) {
  console.error('prove-hook-spellings-retired: a retired hook spelling is still written somewhere Mercury reads')
  process.exit(1)
}
console.log('prove-hook-spellings-retired: all green')
