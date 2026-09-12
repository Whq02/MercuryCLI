#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://github.com/example/mercury' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'dead-thinking-pure-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.MERCURY_THINKING_BINDING
delete process.env.MERCURY_PREFIX_INDUCE_EDIT
delete process.env.ANTHROPIC_BASE_URL

import { bindingDropsFor, startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const MODEL = 'claude-fable-5-1'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — dead-thinking proofs exceeded 280s')
  process.exit(1)
}, 280_000)
guard.unref?.()

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'cache_control') continue
      out[k] = k === 'input' || k === 'input_schema' ? v : withoutCacheControl(v)
    }
    return out
  }
  return value
}

const WINDOWS_INPUT = {
  timeout: 120000,
  command: 'type "C:\\Users\\WHQ\\Documents\\notes.txt" && echo done\r\n',
  description: '',
  run_in_background: false,
}
const TILDE_INPUT = { file_path: '~\\Documents\\notes.txt' }

section("§1 the ledger's words — two sends of a Windows-shaped tool row name nothing; a moved byte inside it is named as the doctor spells it")
{
  const { judgeAndRecordPrefix, resetPrefixLedger } = await import('../../src/services/providers/anthropic/prefixLedger.ts')
  const system = [{ type: 'text', text: 'You are Mercury.' }]
  const tools = [
    { name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
    { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
  ]
  const thinking = (text: string): Record<string, unknown> => ({ type: 'thinking', thinking: text, signature: `sig-${text}` })
  const history = (input: Record<string, unknown>, tail: unknown[]): unknown[] => [
    { role: 'user', content: [{ type: 'text', text: 'read my notes' }] },
    { role: 'assistant', content: [thinking('plan'), { type: 'tool_use', id: 'toolu_1', name: 'Bash', input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
    { role: 'assistant', content: [thinking('read it'), { type: 'tool_use', id: 'toolu_2', name: 'Read', input: TILDE_INPUT }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'line one\r\nline two\r\n' }] },
    ...tail,
  ]
  const owner = 'dead-thinking-pure'
  const key = `${owner}|first|${MODEL}`
  const ids = (messages: unknown[]): Array<string | null> => messages.map((m, i) => ((m as { role: string }).role === 'assistant' ? `msg_${i}` : null))

  resetPrefixLedger()
  const first = history(WINDOWS_INPUT, [])
  const v1 = judgeAndRecordPrefix(owner, key, { system, tools, messages: first }, ids(first))
  check('§1 the first send records without a comparison', v1.compared === false && v1.mismatch === null)
  const second = history(WINDOWS_INPUT, [
    { role: 'assistant', content: [thinking('answer'), { type: 'text', text: 'Two lines.' }] },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
  ])
  const v2 = judgeAndRecordPrefix(owner, key, { system, tools, messages: second }, ids(second))
  check("§1 the second send, byte-identical over the shared rows (a backslash path, CRLF, an empty optional, the model's key order, a tilde path), names nothing", v2.compared === true && v2.mismatch === null, j(v2.mismatch))
  const moved = history({ ...WINDOWS_INPUT, command: WINDOWS_INPUT.command.replace('C:\\Users', 'C:/Users') }, [
    { role: 'assistant', content: [thinking('answer'), { type: 'text', text: 'Two lines.' }] },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    { role: 'assistant', content: [thinking('more'), { type: 'text', text: 'Anything else?' }] },
    { role: 'user', content: [{ type: 'text', text: 'no' }] },
  ])
  const v3 = judgeAndRecordPrefix(owner, key, { system, tools, messages: moved }, ids(moved))
  check('§1 a byte moved inside the settled tool_use is named the way the doctor row spells it', v3.mismatch?.part === "turn 1's assistant row: tool_use block 0" && v3.mismatch.path === 'messages[1].content[1]', j(v3.mismatch))
  resetPrefixLedger()
}

if (!existsSync(DIST)) {
  console.log('\n(dist/mercury.mjs absent — §2 and §3 need the prebuilt bundle; skipping)')
} else {
  const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
  const nodeBin = existsSync(vendoredNode) ? vendoredNode : Bun.which('node')
  if (!nodeBin) {
    console.log('\n(no node binary — §2 and §3 need one; skipping)')
  } else {
    interface RunResult { exit: number | null; stdout: string; stderr: string }
    interface Arena { home: string; cwd: string; env: Record<string, string> }
    function makeArena(fixture: FixtureApi, extraEnv: Record<string, string> = {}): Arena {
      const home = mkdtempSync(join(tmpdir(), 'dead-thinking-home-'))
      const cwd = mkdtempSync(join(tmpdir(), 'dead-thinking-cwd-'))
      mkdirSync(join(home, '.claude'), { recursive: true })
      return {
        home,
        cwd,
        env: {
          HOME: home,
          PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
          TERM: 'dumb',
          MERCURY_CONFIG_DIR: join(home, '.claude'),
          MERCURY_CREDENTIAL_STORE: 'file',
          ANTHROPIC_BASE_URL: fixture.url,
          ANTHROPIC_API_KEY: 'fixture-key-000',
          MERCURY_DAEMON_DIR: join(home, 'daemon'),
          MERCURY_TEAMS_DIR: join(home, 'teams'),
          MERCURY_THINKING_BINDING: 'drop_block',
          ...extraEnv,
        },
      }
    }
    function runStreaming(arena: Arena, args: string[], prompts: string[]): Promise<RunResult> {
      return new Promise(resolvePromise => {
        const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
        let stdout = ''
        let stderr = ''
        let sent = 0
        let resultsSeen = 0
        const sendNext = (): void => {
          if (sent >= prompts.length) {
            child.stdin.end()
            return
          }
          const prompt = prompts[sent]!
          sent++
          child.stdin.write(j({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
        }
        child.stdout.on('data', d => {
          stdout += d
          const results = stdout.split('\n').filter(l => l.includes('"type":"result"')).length
          while (resultsSeen < results) {
            resultsSeen++
            sendNext()
          }
        })
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolvePromise({ exit, stdout, stderr })
        })
        child.on('spawn', () => sendNext())
      })
    }
    type Body = { system?: unknown; tools?: unknown; messages?: unknown[]; model?: string }
    type Captured = ReturnType<FixtureApi['messageRequests']>
    function census(label: string, reqs: Captured): void {
      for (let i = 1; i < reqs.length; i++) {
        const prev = reqs[i - 1]!.body as Body
        const cur = reqs[i]!.body as Body
        const systemSame = j(withoutCacheControl(prev.system)) === j(withoutCacheControl(cur.system))
        const toolsSame = j(withoutCacheControl(prev.tools)) === j(withoutCacheControl(cur.tools))
        const pm = (prev.messages ?? []) as unknown[]
        const cm = (cur.messages ?? []) as unknown[]
        let firstDiff = -1
        for (let k = 0; k < pm.length; k++) {
          if (j(withoutCacheControl(pm[k])) !== j(withoutCacheControl(cm[k]))) {
            firstDiff = k
            break
          }
        }
        check(`${label} pair ${i}→${i + 1}: the system, the tools and the shared messages are byte-identical and the turn is appended`, systemSame && toolsSame && firstDiff === -1 && cm.length > pm.length, `system=${systemSame} tools=${toolsSame} firstDiff=${firstDiff} ${pm.length}→${cm.length}`)
        if (firstDiff !== -1) {
          console.log(`      prev[${firstDiff}]: ${j(withoutCacheControl(pm[firstDiff])).slice(0, 600)}`)
          console.log(`      cur [${firstDiff}]: ${j(withoutCacheControl(cm[firstDiff])).slice(0, 600)}`)
        }
      }
    }
    const dropPaths = (req: { body: unknown }): string[] => (bindingDropsFor(req.body) as Array<{ path: string }>).map(d => d.path)
    const liveThinking = (req: { body: unknown }): string[] =>
      (((req.body as Body).messages ?? []) as Array<{ role: string; content: unknown }>).flatMap((m, k) =>
        Array.isArray(m.content) ? (m.content as Array<{ type: string }>).flatMap((b, bi) => (b.type === 'thinking' ? [`${k}.${bi}`] : [])) : [],
      )
    function transcriptLines(arena: Arena, sessionId: string, needle: string): string[] {
      const walk = (dir: string): string[] => {
        const out: string[] = []
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) out.push(...walk(full))
          else if (entry.name === `${sessionId}.jsonl`) out.push(full)
        }
        return out
      }
      const root = join(arena.home, '.claude', 'projects')
      const files = existsSync(root) ? walk(root) : []
      const lines: string[] = []
      for (const file of files) for (const line of readFileSync(file, 'utf8').split('\n')) if (line.includes(needle)) lines.push(line)
      return lines
    }
    const debugLines = (file: string, needle: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l.includes(needle)) : [])
    const readLedger = (arena: Arena): { last?: { kind?: string; consecutive?: number; count?: number; path?: string; part?: string }; longestRun?: number } | null => {
      const file = join(arena.home, '.claude', 'preserved-thinking.json')
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ReturnType<typeof readLedger>) : null
    }

    section('§2 the wire — Windows-shaped tool rounds in one process, then a resume: nothing moves, nothing drops')
    {
      const turns: ScriptedTurn[] = [
        { kind: 'tool_use', name: 'Bash', input: { command: 'printf "%s" "C:\\\\Users\\\\WHQ\\\\Documents\\\\notes.txt" && printf "line one\\r\\nline two\\r\\n"', description: 'Print a Windows path and CRLF lines' }, thinking: 'plan: run the shell', model: MODEL },
        { kind: 'tool_use', name: 'Write', input: {}, thinking: 'plan: write the file', model: MODEL },
        { kind: 'tool_use', name: 'Read', input: {}, thinking: 'plan: read the file back', model: MODEL },
        { kind: 'tool_use', name: 'Edit', input: {}, thinking: 'plan: edit one line', model: MODEL },
        { kind: 'text', text: 'S2-TURN-1-DONE', thinking: 'the rounds are done', model: MODEL },
        { kind: 'tool_use', name: 'Bash', input: { timeout: 5000, command: 'echo second', description: '', run_in_background: false }, thinking: 'plan: a second shell round', model: MODEL },
        { kind: 'text', text: 'S2-TURN-2-DONE', thinking: 'second turn done', model: MODEL },
        { kind: 'text', text: 'S2-TURN-3-DONE', thinking: 'third turn done', model: MODEL },
        { kind: 'text', text: 'S2-RESUMED-DONE', thinking: 'resumed turn done', model: MODEL },
      ]
      const fixture = await startFixtureApi(turns, { bindingCheck: true })
      const arena = makeArena(fixture)
      const filePath = join(arena.cwd, 'win-notes.txt')
      ;(turns[1] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: filePath, content: 'alpha  \r\nbeta\t\r\nC:\\Users\\WHQ\\x\r\n' }
      ;(turns[2] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: filePath }
      ;(turns[3] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: filePath, old_string: 'beta', new_string: 'gamma  ', replace_all: false }
      const SID = 'c0ffee00-0000-4000-8000-00000000dead'
      const debugFile = join(arena.home, 's2.debug.log')
      const common = ['--model', MODEL, '--allowed-tools', 'Bash', 'Write', 'Read', 'Edit', '--output-format', 'stream-json']
      const r = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...common, '--session-id', SID, '--debug-file', debugFile], [
        'run the shell, write the file, read it, edit it',
        'one more shell round',
        'anything else?',
      ])
      check('§2 the three-turn process exits 0 and every turn answered', r.exit === 0 && ['S2-TURN-1-DONE', 'S2-TURN-2-DONE', 'S2-TURN-3-DONE'].every(t => r.stdout.includes(t)), `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`)
      const r2 = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...common, '--resume', SID, '--debug-file', debugFile], ['and after the resume?'])
      check('§2 the resumed process exits 0 and answered', r2.exit === 0 && r2.stdout.includes('S2-RESUMED-DONE'), `exit=${r2.exit} stderr=${r2.stderr.slice(0, 300)}`)
      const reqs = fixture.messageRequests()
      check('§2 nine message requests (five rounds, a two-round turn, a plain turn, the resumed turn)', reqs.length === 9, String(reqs.length))
      census('§2', reqs)
      check('§2 the fixture refused nothing and its binding check dropped nothing on any request', fixture.refusals.length === 0 && reqs.every(q => dropPaths(q).length === 0), `refusals=${fixture.refusals.length} drops=${j(reqs.map(dropPaths))}`)
      const settledInputs = (((reqs[reqs.length - 1]!.body as Body).messages ?? []) as Array<{ role: string; content: unknown }>)
        .flatMap(m => (m.role === 'assistant' && Array.isArray(m.content) ? (m.content as Array<{ type: string; input?: unknown }>).filter(b => b.type === 'tool_use').map(b => j(b.input)) : []))
      check('§2 the resumed request replays every settled tool row with the bytes the first send carried (the backslash path and the CRLF as decoded once, the empty optional kept, the decoded key order)', j(settledInputs) === j([
        j({ command: 'printf "%s" "C:\\\\Users\\\\WHQ\\\\Documents\\\\notes.txt" && printf "line one\\r\\nline two\\r\\n"', description: 'Print a Windows path and CRLF lines' }),
        j({ file_path: filePath, content: 'alpha\r\nbeta\r\nC:\\Users\\WHQ\\x\r\n' }),
        j({ file_path: filePath }),
        j({ file_path: filePath, old_string: 'beta', new_string: 'gamma', replace_all: false }),
        j({ command: 'echo second', description: '', timeout: 5000, run_in_background: false }),
      ]), j(settledInputs))
      check('§2 the ledger named no rewrite and no receipt written', debugLines(debugFile, 'the prefix ledger names a rewrite of sent history').length === 0 && transcriptLines(arena, SID, 'Preserved thinking').length === 0 && readLedger(arena) === null, j(debugLines(debugFile, 'the prefix ledger names a rewrite of sent history')))
      await fixture.close()
    }

    section('§3 the wire — one prefix move, then a three-round tool loop in ONE turn: the dropped block stays dead from the next round on')
    {
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'S3-TURN-1-DONE', thinking: 'first turn thinking, bound to the unedited prefix', model: MODEL },
        { kind: 'tool_use', name: 'Read', input: {}, thinking: 'round one', model: MODEL },
        { kind: 'tool_use', name: 'Read', input: {}, thinking: 'round two', model: MODEL },
        { kind: 'tool_use', name: 'Read', input: {}, thinking: 'round three', model: MODEL },
        { kind: 'text', text: 'S3-TURN-2-DONE', thinking: 'the loop is done', model: MODEL },
        { kind: 'text', text: 'S3-TURN-3-DONE', thinking: 'third turn', model: MODEL },
      ]
      const fixture = await startFixtureApi(turns, { bindingCheck: true })
      const arena = makeArena(fixture, { MERCURY_PREFIX_INDUCE_EDIT: 'turn:0' })
      const notePath = join(arena.cwd, 'note.txt')
      writeFileSync(notePath, 'a note\n')
      for (const k of [1, 2, 3]) (turns[k] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: notePath }
      const SID = 'c0ffee00-0000-4000-8000-00000000dea1'
      const debugFile = join(arena.home, 's3.debug.log')
      const common = ['--model', MODEL, '--allowed-tools', 'Read', '--output-format', 'stream-json']
      const r = await runStreaming(arena, ['-p', '--input-format', 'stream-json', ...common, '--session-id', SID, '--debug-file', debugFile], [
        'begin without tools',
        'now read the note three times in a row',
        'and now?',
      ])
      check('§3 the three-turn process exits 0 and every turn answered', r.exit === 0 && ['S3-TURN-1-DONE', 'S3-TURN-2-DONE', 'S3-TURN-3-DONE'].every(t => r.stdout.includes(t)), `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`)
      const reqs = fixture.messageRequests()
      check("§3 six message requests (turn 1; the loop's four rounds; turn 3)", reqs.length === 6, String(reqs.length))
      const drops = reqs.map(dropPaths)
      console.log(`    drops per request: ${j(drops)}`)
      console.log(`    live thinking per request: ${j(reqs.map(liveThinking))}`)
      check("§3 request 2 (the first request after the edit) drops exactly the first turn's block", j(drops[1]) === j(['messages.1.content.0']), j(drops[1]))
      check("§3 the loop's later rounds (requests 3, 4, 5) drop NOTHING — the dead block left the wire from the next round on", drops.slice(2, 5).every(d => d.length === 0), j(drops.slice(2, 5)))
      check('§3 request 3 no longer carries the dropped block (messages[1] sends no thinking)', !liveThinking(reqs[2]!).includes('1.0'), j(liveThinking(reqs[2]!)))
      check('§3 the next turn (request 6) drops nothing', drops[5]?.length === 0, j(drops[5]))
      check('§3 the fixture refused nothing', fixture.refusals.length === 0, j(fixture.refusals))
      const deadRows = transcriptLines(arena, SID, '"dead_thinking"')
      check('§3 exactly one dead-block record was written (the one drop)', deadRows.length === 1, String(deadRows.length))
      const notices = transcriptLines(arena, SID, 'Preserved thinking')
      check("§3 the one receipt names the edit and the ledger's part (the first drop's warning-level receipt, written once, never painted)", notices.length === 1 && notices[0]!.includes("turn 0's user row"), `${notices.length} ${(notices[0] ?? '').slice(0, 200)}`)
      const ledger = readLedger(arena)
      check('§3 the doctor records ONE first drop (consecutive 1), never a run of consecutive rewrites', ledger?.last?.kind === 'first' && ledger.last.consecutive === 1 && ledger.longestRun === 1 && ledger.last.count === 1, j(ledger))
      const named = debugLines(debugFile, 'the prefix ledger names a rewrite of sent history')
      check('§3 the ledger named the moved part once, on the request the edit first rode', named.length === 1, String(named.length))
      await fixture.close()
    }
  }
}

clearTimeout(guard)
console.log(`\n${failures === 0 ? '✅' : '❌'} dead thinking within the turn: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
