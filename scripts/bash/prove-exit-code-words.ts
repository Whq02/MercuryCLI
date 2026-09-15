#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

console.log('============================================================')
console.log(' Bash tool — an exit of 1 from a lookup or a comparison is an answer')
console.log('============================================================')

section('§1 the interpretation, per command')
const { interpretCommandResult } = await import('../../src/tools/BashTool/commandSemantics.ts')
const verdict = (command: string, code: number): { isError: boolean; message?: string } => interpretCommandResult(command, code, '', '')
const answers = (command: string, code: number, words: string): boolean => {
  const v = verdict(command, code)
  return v.isError === false && (v.message ?? '').includes(words)
}
check('pgrep exit 1 reads as no process matched', answers('pgrep -x nothing', 1, 'no process matched'), JSON.stringify(verdict('pgrep -x nothing', 1)))
check("the record's shape: pgrep -fl with a quoted alternation", answers("pgrep -fl 'Atheltide.app/Contents/MacOS/Atheltide|Electron.app/Contents/MacOS/Electron'", 1, 'no process matched'), JSON.stringify(verdict("pgrep -fl 'a|b'", 1)))
check('pgrep exit 0 is plain success with no note', verdict('pgrep -x node', 0).isError === false && verdict('pgrep -x node', 0).message === undefined)
check('pgrep exit 2 (a bad option) stays an error', verdict('pgrep --nonsense', 2).isError === true)
check('cmp exit 1 reads as files differ', answers('cmp a b', 1, 'files differ'), JSON.stringify(verdict('cmp a b', 1)))
check('cmp exit 2 (a missing file) stays an error', verdict('cmp a missing', 2).isError === true)
for (const [command, words] of [
  ['grep zzz file', 'no matches found'],
  ['rg zzz', 'no matches found'],
  ['diff a b', 'files differ'],
  ['test -f missing', 'condition is false'],
  ['[ -f missing ]', 'condition is false'],
] as const) {
  check(`${command.split(' ')[0]} exit 1 keeps its answer`, answers(command, 1, words), JSON.stringify(verdict(command, 1)))
}
check('a pipeline is judged by its last stage', answers('ps aux | grep -q zzz', 1, 'no matches found'), JSON.stringify(verdict('ps aux | grep -q zzz', 1)))
check('a leading variable assignment does not hide the command', answers('LC_ALL=C pgrep -x nothing', 1, 'no process matched'), JSON.stringify(verdict('LC_ALL=C pgrep -x nothing', 1)))
check('a leading env does not hide the command', answers('env LC_ALL=C pgrep -x nothing', 1, 'no process matched'), JSON.stringify(verdict('env LC_ALL=C pgrep -x nothing', 1)))
check('an unrelated command exiting 1 stays an error naming the code', verdict('ls /no/such', 1).isError === true && /exit code 1/.test(verdict('ls /no/such', 1).message ?? ''), JSON.stringify(verdict('ls /no/such', 1)))
check('node exiting 1 stays an error', verdict('node script.js', 1).isError === true)
check('a chain whose last stage is not a lookup stays an error', verdict('pgrep -x nothing && echo running', 1).isError === true)

section('§2 the built product: print mode, the model played by the fixture, the results read off the wire')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
const nodeBin = existsSync(vendoredNode) ? vendoredNode : Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  check('dist/mercury.mjs and a node binary present (the pooled gate prebuilds the dist)', false, DIST)
} else {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'exit-code-words-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'exit-code-words-cwd-')))
  const configDir = join(home, '.mercury')
  seedFirstRun(configDir, [cwd])
  writeFileSync(join(cwd, 'a.txt'), 'alpha\n')
  writeFileSync(join(cwd, 'b.txt'), 'beta\n')
  const MODEL = 'claude-opus-4-8'
  const turns: ScriptedTurn[] = [
    { kind: 'tool_use', name: 'Bash', input: { command: 'pgrep -x mercury-proof-no-such-process', description: 'a process that does not run' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: "pgrep -fl 'mercury-proof-no-such-[p]rocess|another-no-such-[n]ame'", description: "the record's shape" }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: `cmp "${cwd}/a.txt" "${cwd}/b.txt"`, description: 'two files that differ' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: `grep -c zzz "${cwd}/a.txt"`, description: 'a count of nothing' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: `test -f "${cwd}/missing.txt"`, description: 'a false condition' }, whenModel: MODEL },
    { kind: 'tool_use', name: 'Bash', input: { command: `ls "${cwd}/no-such-dir"`, description: 'a real failure' }, whenModel: MODEL },
    { kind: 'text', text: 'exit-code-probe: done', whenModel: MODEL },
    { kind: 'text', text: 'exit-code-probe: done', whenModel: MODEL },
  ]
  const fixture = await startFixtureApi(turns)
  const env = {
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
    TERM: 'dumb',
    SHELL: '/bin/bash',
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_VERIFY_EVIDENCE: '0',
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
  }
  const startedAt = Date.now()
  const outcome = await new Promise<{ exit: number | null; stdout: string; stderr: string; ms: number }>(resolveRun => {
    const child = spawn(nodeBin, [DIST, '-p', 'exit-code-probe: run the six', '--model', MODEL, '--dangerously-bypass-permissions'], { cwd, env, detached: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const deadline = setTimeout(() => {
      try {
        process.kill(-(child.pid as number), 'SIGKILL')
      } catch {
        void 0
      }
    }, 120_000)
    child.on('close', exit => {
      clearTimeout(deadline)
      resolveRun({ exit, stdout, stderr, ms: Date.now() - startedAt })
    })
  })
  await fixture.close()
  const requests = fixture.messageRequests()
  const last = requests[requests.length - 1]
  const results: { text: string; isError: boolean }[] = []
  for (const message of ((last?.body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? [])) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const block of message.content as Array<{ type?: string; content?: unknown; is_error?: boolean }>) {
      if (block.type !== 'tool_result') continue
      const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? (block.content as Array<{ text?: string }>).map(b => b.text ?? '').join('') : ''
      results.push({ text, isError: block.is_error === true })
    }
  }
  console.log(`        note: print mode exit ${outcome.exit} after ${outcome.ms}ms; ${requests.length} model requests`)
  for (const [i, r] of results.entries()) console.log(`        note: result ${i + 1}${r.isError ? ' (error)' : ''}: ${JSON.stringify(r.text.slice(0, 140))}`)
  check('the artifact ran the six calls and closed the turn', outcome.exit === 0 && /exit-code-probe: done/.test(outcome.stdout), `exit ${outcome.exit} ${JSON.stringify(outcome.stderr.slice(-300))}`)
  check('six results reached the model', results.length === 6, String(results.length))
  const [byName, byPattern, differ, count, falsy, failure] = results
  const noMatch = (r: { text: string; isError: boolean } | undefined): boolean => r !== undefined && !r.isError && r.text.includes('no process matched (exit code 1)') && !/Exited with code/.test(r.text)
  check('artifact: pgrep by name — a result, not an error, naming the code and the answer', noMatch(byName), JSON.stringify(byName))
  check("artifact: pgrep with the record's -fl alternation — the same", noMatch(byPattern), JSON.stringify(byPattern))
  check('artifact: cmp on two files that differ — a result naming the difference and the code', differ !== undefined && !differ.isError && /differ/.test(differ.text) && differ.text.includes('(exit code 1)'), JSON.stringify(differ))
  check('artifact: grep -c with no match keeps its count and names the code', count !== undefined && !count.isError && count.text.startsWith('0') && count.text.includes('no matches found (exit code 1)'), JSON.stringify(count))
  check('artifact: a false test is a result naming the condition and the code', falsy !== undefined && !falsy.isError && falsy.text.includes('condition is false (exit code 1)'), JSON.stringify(falsy))
  check('artifact: a real failure stays an error carrying its exit code', failure !== undefined && failure.isError && /Exited with code 1/.test(failure.text), JSON.stringify(failure))
  const leftovers = spawnSync('pgrep', ['-f', configDir], { encoding: 'utf8' }).stdout.trim()
  check('no process of this run left behind', leftovers === '', leftovers)
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ ALL EXIT-CODE-WORDS PROOFS PASS' : `\n❌ ${failures} EXIT-CODE-WORDS PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
