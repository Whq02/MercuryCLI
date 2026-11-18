#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

section('§1 THE BLOCKED BRANCH')
{
  const pui = src('src/utils/processUserInput/processUserInput.ts')
  check('the result type declares hookBlocked', /hookBlocked\?: true/.test(pui))
  const branch = pui.slice(pui.indexOf('if (started.answer.block !== undefined)'), pui.indexOf('if (started.answer.stop !== undefined)'))
  check('the blocking branch MARKS the result (call-shaped)', /hookBlocked: true/.test(branch), branch.slice(0, 100).replace(/\s+/g, ' '))
  check('and carries the reason as resultText', /resultText/.test(branch))
}

section('§2 THE OUTCOME')
{
  const engine = src('src/rows/turn.ts')
  check(
    'a blocked prompt settles refused beside a refused command',
    /const refused = inputResult\.commandRefused === true \|\| inputResult\.hookBlocked === true/.test(engine) && /endTurn\(refused \? 'refused' : 'completed'/.test(engine),
  )
  check("and the hook's reason rides the error with class hook", /class: inputResult\.hookBlocked === true \? 'hook' : 'command'/.test(engine))
}

section('§3 THE PRINT ROAD (the existing groove, pinned)')
{
  const { FIXTURE_MODEL, fixtureCli } = await import('../lib/builtProduct.ts')
  const { exitCodeOf } = await import('../../src/rows/vocabulary.ts')
  const completed = await fixtureCli([{ kind: 'text', text: 'DONE.' }], ['run', '--model', FIXTURE_MODEL, 'hi'])
  const refusal = { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'the fixture says no' } as const
  const failed = await fixtureCli([refusal, refusal, refusal], ['run', '--model', FIXTURE_MODEL, 'hi'])
  check(
    'a non-completed outcome answers its sentence on stderr',
    completed.stdout === 'DONE.\n' && completed.stderr === '' && failed.stdout === '' && failed.stderr.includes('the fixture says no'),
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
  )
}

if (failures > 0) {
  console.error(`\nprove-blocked-prompt-honest: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-blocked-prompt-honest: all green')
