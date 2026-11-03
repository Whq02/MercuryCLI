import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeGoldenTask, type GoldenJudgeInput, type GoldenToolCall } from './judge.ts'
import { GOLDEN_TASKS } from './tasks.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export function judgeSelfCheck(scratch: string): { passed: boolean; checks: string[] } {
  const root = mkdtempSync(join(scratch, 'judge-check-'))
  const checks: string[] = []
  let passed = true
  const check = (name: string, result: boolean): void => {
    checks.push(`${result ? 'PASS' : 'FAIL'} ${name}`)
    if (!result) passed = false
  }
  const context: GoldenToolCall[] = [
    { tool: 'ToolSearch', input: { query: 'context remaining tokens' }, index: 1, output: 'Loaded ContextLeft', resultIndex: 2 },
    { tool: 'ContextLeft', input: {}, index: 3, output: 'Left until the fold (autocompact): 200,000 tokens (80% of the window), measured on the wire.', resultIndex: 4 },
  ]
  const answers: Record<string, string> = {
    T1: 'src/a.ts has 5 lines.', T2: 'Done.', T3: 'Renamed.',
    T4: 'Two call sites: src/b.ts and src/c.ts.', T5: 'Parser Contract', T6: 'Example Domain',
    T7: '200,000 tokens are left until autocompact.', T8: 'Fixed the typo.',
    T9: 'The last line was noise line 60000.', T10: 'There are zero FIXME comments.',
  }
  try {
    mkdirSync(join(root, 'home'))
    for (const task of GOLDEN_TASKS) {
      const cwd = join(root, task.id)
      cpSync(FIXTURE, cwd, { recursive: true })
      const replace = (path: string, old: string, replacement: string): void => writeFileSync(join(cwd, path), readFileSync(join(cwd, path), 'utf8').replaceAll(old, replacement))
      if (task.id === 'T2') replace('src/b.ts', "greeting = 'hello'", "greeting = 'hello there'")
      if (task.id === 'T3') { replace('src/a.ts', 'LIMIT', 'MAX_ITEMS'); replace('src/c.ts', 'LIMIT', 'MAX_ITEMS') }
      if (task.id === 'T8') replace('src/util.ts', 'retreiveFirstCell', 'retrieveFirstCell')
      const calls: GoldenToolCall[] = task.id === 'T7' ? context : task.id === 'T1' || task.id === 'T9' ? [{ tool: 'Bash', input: { command: task.id === 'T1' ? './slow.sh' : './noisy.sh' }, index: 1, output: 'observed execution', resultIndex: 2 }] : []
      const input: GoldenJudgeInput = { task, cwd, configHome: join(root, 'home'), answer: answers[task.id]!, calls, seconds: 1, outcomeStatus: 'completed' }
      check(`${task.id} correct final state/answer accepted`, judgeGoldenTask(input).completed)
      let negative: GoldenJudgeInput = { ...input, outcomeStatus: 'failed' }
      if (task.id === 'T2') { replace('src/b.ts', "greeting = 'hello there'", "greeting = 'hello'"); negative = input }
      if (task.id === 'T4') negative = { ...input, answer: 'Three call sites: src/a.ts, src/b.ts, src/c.ts.' }
      if (task.id === 'T5') negative = { ...input, answer: 'Golden Fixture Specification' }
      if (task.id === 'T6') negative = { ...input, answer: 'The title is unknown.' }
      if (task.id === 'T7') negative = { ...input, calls: context.slice(1) }
      if (task.id === 'T8') { writeFileSync(join(cwd, 'EXTRA.md'), 'Unrequested documentation.\n'); negative = input }
      if (task.id === 'T9') negative = { ...input, answer: 'noise line 59999' }
      if (task.id === 'T10') negative = { ...input, answer: 'The command failed with an error.' }
      check(`${task.id} sabotaged state/answer rejected`, !judgeGoldenTask(negative).completed)
      if (task.id === 'T1') check('T1 watchdog rejected despite correct answer', !judgeGoldenTask({ ...input, calls: [...calls, { tool: 'Bash', input: { command: '(sleep 1; kill $pid) &' }, index: 3 }] }).completed)
      if (task.id === 'T6') check('T6 curl is recorded as wrong tool independently of completion', judgeGoldenTask({ ...input, calls: [{ tool: 'Bash', input: { command: 'curl https://example.com' }, index: 1 }] }).wrongToolCalls.length === 1)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  return { passed, checks }
}
