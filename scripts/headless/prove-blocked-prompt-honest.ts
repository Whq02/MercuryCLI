#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' | ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)


section('§3 THE PRINT ROAD (the existing groove, pinned)')
{
  const { FIXTURE_MODEL, fixtureCli } = await import('../lib/builtProduct.ts')
  const { exitCodeOf } = await import('../../src/engine/rows/vocabulary.ts')
  const completed = await fixtureCli([{ kind: 'text', text: 'DONE.' }], ['run', '--model', FIXTURE_MODEL, 'hi'])
  const refusal = { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'the fixture says no' } as const
  const failed = await fixtureCli([refusal, refusal, refusal], ['run', '--model', FIXTURE_MODEL, 'hi'])
  check(
    'a non-completed outcome answers its sentence on stderr',
    completed.stdout === 'DONE.\n' && completed.stderr === '' && failed.stdout === '' && failed.stderr.includes('the fixture says no'),
    '',
    'change finishPrintRun in src/daemon/runner/runnerRunEnd.ts so a completed run writes its answer to stdout and any other status writes its sentence to stderr with nothing on stdout',
  )
  const asksToRead = { kind: 'tool_use', name: 'Read', input: { file_path: join(import.meta.dir, 'no-such-file') } } as const
  const ended = async (argv: string[]): Promise<{ exit: number | null; status: unknown }> => {
    const ran = await fixtureCli([asksToRead, { kind: 'text', text: 'DONE.' }], ['run', '--format', 'json', ...argv, '--model', FIXTURE_MODEL, 'hi'])
    try {
      return { exit: ran.status, status: (JSON.parse(ran.stdout) as { status?: unknown }).status }
    } catch {
      return { exit: ran.status, status: ran.stdout.slice(0, 200) }
    }
  }
  const limited = await ended(['--max-turns', '1'])
  const blocked = await ended([])
  check(
    'and the exit code derives from the status alone',
    completed.status === exitCodeOf('completed') &&
      failed.status === exitCodeOf('failed') &&
      completed.status !== failed.status &&
      limited.status === 'turn_limit' &&
      limited.exit === exitCodeOf('turn_limit') &&
      blocked.status === 'blocked' &&
      blocked.exit === exitCodeOf('blocked'),
    JSON.stringify({ completed: completed.status, failed: failed.status, limited, blocked }),
    'change exitCodeOf in src/engine/rows/vocabulary.ts, or the exit line of finishPrintRun in src/daemon/runner/runnerRunEnd.ts, so the exit code follows the outcome status alone and the json status reads turn_limit or blocked as the run ended',
  )
}

if (failures > 0) {
  console.error(`\nprove-blocked-prompt-honest: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-blocked-prompt-honest: all green')
