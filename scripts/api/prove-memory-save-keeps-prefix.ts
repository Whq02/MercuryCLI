#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runTurns } from '../lib/rows.ts'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'memory-save-prefix-pure-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.MERCURY_THINKING_BINDING
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_HOME

import { bindingDropsFor, handoffTurn, isHandoffRequest, startFixtureApi as startScriptedApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const RULE = 'always answer in British English'
const MODEL = 'claude-fable-5-1'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — memory-save-keeps-prefix exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const startFixtureApi = (turns: ScriptedTurn[]): ReturnType<typeof startScriptedApi> => startScriptedApi([...turns, ...Array.from({ length: 6 }, () => handoffTurn())], { bindingCheck: true })
const mainRequests = (api: FixtureApi): ReturnType<FixtureApi['messageRequests']> => api.messageRequests().filter(q => !isHandoffRequest(q))

type Block = Record<string, unknown>
type Body = { system?: unknown; tools?: unknown; messages?: unknown[]; model?: string }

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
const systemBlocks = (body: Body): string[] => (Array.isArray(body.system) ? (body.system as Array<{ text?: string }>).map(b => b.text ?? '') : [String(body.system ?? '')])
const memoryBlock = (body: Body): string => systemBlocks(body).find(text => text.includes('# Memory')) ?? ''
const thinkingBlocksOf = (body: Body): number => ((body.messages ?? []) as Array<{ content?: unknown }>).reduce((n, m) => n + (Array.isArray(m.content) ? (m.content as Block[]).filter(b => b.type === 'thinking').length : 0), 0)

function census(label: string, reqs: ReturnType<FixtureApi['messageRequests']>): void {
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
    let where = ''
    if (!systemSame) {
      const ps = systemBlocks(prev)
      const cs = systemBlocks(cur)
      for (let b = 0; b < Math.max(ps.length, cs.length); b++) {
        if ((ps[b] ?? '') !== (cs[b] ?? '')) {
          const a = ps[b] ?? ''
          const c = cs[b] ?? ''
          let at = 0
          while (at < a.length && at < c.length && a[at] === c[at]) at++
          where = `system block ${b} differs at char ${at}: ${j(a.slice(Math.max(0, at - 60), at + 120))} vs ${j(c.slice(Math.max(0, at - 60), at + 120))}`
          break
        }
      }
    }
    check(`${label} pair ${i}→${i + 1}: the top-level system is byte-identical`, systemSame, where)
    check(`${label} pair ${i}→${i + 1}: the tools array is byte-identical`, toolsSame)
    check(`${label} pair ${i}→${i + 1}: the shared messages prefix is byte-identical and the turn is appended`, firstDiff === -1 && cm.length > pm.length, `firstDiff=${firstDiff} ${pm.length}→${cm.length}`)
  }
}

function transcriptNotices(home: string, sessionId: string): string[] {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else if (entry.name === `${sessionId}.jsonl`) out.push(full)
    }
    return out
  }
  const root = join(home, '.mercury', 'projects')
  const files = existsSync(root) ? walk(root) : []
  const notices: string[] = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('Preserved thinking')) continue
      try {
        const row = JSON.parse(line) as { payload?: { kind?: string; content?: string } }
        if (row.payload?.kind === 'notice' && typeof row.payload.content === 'string') notices.push(row.payload.content)
      } catch {}
    }
  }
  return notices
}

const frontPageOf = (home: string): string => {
  const root = join(home, '.mercury', 'projects')
  if (!existsSync(root)) return ''
  for (const project of readdirSync(root)) {
    const page = join(root, project, 'memory', 'library', 'front-page.md')
    if (existsSync(page)) return readFileSync(page, 'utf8')
  }
  return ''
}

const rememberTurns = (): ScriptedTurn[] => [
  { kind: 'tool_use', name: 'ToolSearch', input: { query: 'select:Retain' }, thinking: 'find the memory tool', model: MODEL },
  { kind: 'tool_use', name: 'Retain', input: { items: [{ content: RULE, pin: true }] }, thinking: 'pin the rule as said', model: MODEL },
  { kind: 'text', text: 'PINNED-OK', thinking: 'the rule is pinned', model: MODEL },
]

if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    interface Arena { home: string; cwd: string; env: Record<string, string> }
    function makeArena(fixture: FixtureApi): Arena {
      const home = mkdtempSync(join(tmpdir(), 'memory-save-home-'))
      const cwd = mkdtempSync(join(tmpdir(), 'memory-save-cwd-'))
      mkdirSync(join(home, '.mercury'), { recursive: true })
      const godotBin = join(home, 'godot')
      writeFileSync(godotBin, '#!/bin/sh\nexit 0\n')
      chmodSync(godotBin, 0o755)
      return {
        home,
        cwd,
        env: {
          HOME: home,
          PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
          MERCURY_GODOT_EXECUTABLE: godotBin,
          TERM: 'dumb',
          MERCURY_CONFIG_DIR: join(home, '.mercury'),
          MERCURY_CREDENTIAL_STORE: 'file',
          MERCURY_LOCAL_PROBE_TARGETS: 'none',
          ANTHROPIC_BASE_URL: fixture.url,
          ANTHROPIC_API_KEY: 'fixture-key-000',
          MERCURY_DAEMON_DIR: join(home, 'daemon'),
          MERCURY_THINKING_BINDING: 'drop_block',
          BROWSER: '/usr/bin/true',
        },
      }
    }
    function run(arena: Arena, args: string[]): Promise<{ exit: number | null; stdout: string; stderr: string }> {
      return new Promise(resolvePromise => {
        const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => (stdout += d))
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolvePromise({ exit, stdout, stderr })
        })
      })
    }
    const common = ['--model', MODEL, '--allowed-tools', 'Read,Retain,ToolSearch']
    const rows = ['--format', 'rows']

    function judge(label: string, arena: Arena, sid: string, reqs: ReturnType<FixtureApi['messageRequests']>, expected: number, stdout: string): void {
      check(`${label}: ${expected} message requests (the question, the search, the save, the answer, the second question)`, reqs.length === expected, String(reqs.length))
      census(label, reqs)
      check(`${label}: the API dropped no thinking block on any request (the fixture replays the binding check)`, reqs.every(q => bindingDropsFor(q.body).length === 0), reqs.map(q => j(bindingDropsFor(q.body))).join(' | '))
      const last = reqs[reqs.length - 1]?.body as Body | undefined
      check(`${label}: the last request replays every earlier thinking block (four minted before it)`, last !== undefined && thinkingBlocksOf(last) === 4, String(last && thinkingBlocksOf(last)))
      check(`${label}: no preserved-thinking receipt in the transcript, no drop in the ledger`, transcriptNotices(arena.home, sid).length === 0 && !existsSync(join(arena.home, '.mercury', 'preserved-thinking.json')), j(transcriptNotices(arena.home, sid)))
      check(`${label}: the save landed — the tool answered stored and the rule is on the shelf on disk`, stdout.includes('1 stored') && frontPageOf(arena.home).includes(RULE), frontPageOf(arena.home).slice(-300))
      const first = reqs[0]?.body as Body | undefined
      check(`${label}: the Memory section the model reads is the first request's, byte for byte, after the save as before it`, first !== undefined && last !== undefined && memoryBlock(first) !== '' && memoryBlock(first) === memoryBlock(last), `first=${memoryBlock(first ?? {}).length} last=${memoryBlock(last ?? {}).length}`)
      check(`${label}: the new rule reaches the model through the tool result, not through a moved prompt`, last !== undefined && !memoryBlock(last).includes(RULE) && j(last.messages).includes('pinned rule is on the shelf'), j(last?.messages).slice(-400))
    }

    section('§1 one process (the cockpit\'s shape): a reasoning turn, "remember: …" pinned through Retain, another reasoning turn')
    {
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'SUM-ONE-1600', thinking: 'the first forty odd numbers sum to a square', model: MODEL },
        ...rememberTurns(),
        { kind: 'text', text: 'SUM-TWO-2550', thinking: 'the first fifty even numbers', model: MODEL },
      ]
      const fixture = await startFixtureApi(turns)
      const arena = makeArena(fixture)
      const SID = 'c0ffee00-0000-4000-8000-00000000d001'
      const r = await runTurns({ node: nodeBin, dist: DIST, args: [...common, '--session-id', SID], cwd: arena.cwd, env: arena.env, timeoutMs: 90_000, turns: [
        { prompt: 'Do not use tools. What is the sum of the first 40 odd numbers?' },
        { prompt: `remember: ${RULE}` },
        { prompt: 'Do not use tools. What is the sum of the first 50 even numbers?' },
      ] })
      check('§1 the three-turn process exits 0 and every turn answered', r.exit === 0 && r.stdout.includes('SUM-ONE-1600') && r.stdout.includes('PINNED-OK') && r.stdout.includes('SUM-TWO-2550'), `exit=${r.exit} stderr=${r.stderr.slice(0, 400)}`)
      judge('§1', arena, SID, mainRequests(fixture), 5, r.stdout)
      await fixture.close()
    }

    section('§2 three processes on one session (the headless -c shape of the field\'s row): the save in the middle process')
    {
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'SUM-ONE-1600', thinking: 'the first forty odd numbers sum to a square', model: MODEL },
        ...rememberTurns(),
        { kind: 'text', text: 'SUM-TWO-2550', thinking: 'the first fifty even numbers', model: MODEL },
        { kind: 'text', text: 'HELLO-FRESH', thinking: 'a fresh session', model: MODEL },
      ]
      const fixture = await startFixtureApi(turns)
      const arena = makeArena(fixture)
      const SID = 'c0ffee00-0000-4000-8000-00000000d002'
      const a = await run(arena, ['run', 'Do not use tools. What is the sum of the first 40 odd numbers?', ...common, ...rows, '--session-id', SID])
      check('§2 process A exits 0 and answers', a.exit === 0 && a.stdout.includes('SUM-ONE-1600'), `exit=${a.exit} stderr=${a.stderr.slice(0, 300)}`)
      const b = await run(arena, ['run', `remember: ${RULE}`, ...common, ...rows, '--resume', SID])
      check('§2 process B (resumed) pins the rule and exits 0', b.exit === 0 && b.stdout.includes('PINNED-OK') && b.stdout.includes('1 stored'), `exit=${b.exit} stderr=${b.stderr.slice(0, 300)}`)
      const c = await run(arena, ['run', 'Do not use tools. What is the sum of the first 50 even numbers?', ...common, ...rows, '--resume', SID])
      check('§2 process C (resumed) answers and exits 0', c.exit === 0 && c.stdout.includes('SUM-TWO-2550'), `exit=${c.exit} stderr=${c.stderr.slice(0, 300)}`)
      judge('§2', arena, SID, mainRequests(fixture), 5, a.stdout + b.stdout + c.stdout)
      const fresh = await run(arena, ['run', 'Do not use tools. Say hello.', ...common, ...rows, '--session-id', 'c0ffee00-0000-4000-8000-00000000d003'])
      const freshRequest = mainRequests(fixture).at(-1)?.body as Body | undefined
      const pinnedAt = memoryBlock(freshRequest ?? {}).indexOf('## Pinned')
      check('§2 a NEW session in the same project reads the rule on its front page (the shelf updates at the next session)', fresh.exit === 0 && fresh.stdout.includes('HELLO-FRESH') && freshRequest !== undefined && memoryBlock(freshRequest).includes(RULE), `exit=${fresh.exit} ${memoryBlock(freshRequest ?? {}).slice(Math.max(0, pinnedAt), pinnedAt + 300)}`)
      await fixture.close()
    }

    section('§3 the notice law as it stands: a drop that does happen is said once — one receipt in the transcript, the ledger counts it, the health row names it')
    {
      const DROP = { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'S3-ONE', thinking: 'one', model: MODEL },
        { kind: 'text', text: 'S3-TWO', thinking: 'two', model: MODEL, inputTransformations: [DROP] },
        { kind: 'text', text: 'S3-THREE', thinking: 'three', model: MODEL, inputTransformations: [DROP, { ...DROP, path: 'messages.3.content.0' }] },
      ]
      const fixture = await startScriptedApi([...turns, ...Array.from({ length: 6 }, () => handoffTurn())])
      const arena = makeArena(fixture)
      const SID = 'c0ffee00-0000-4000-8000-00000000d004'
      const r = await runTurns({ node: nodeBin, dist: DIST, args: [...common, '--session-id', SID], cwd: arena.cwd, env: arena.env, timeoutMs: 90_000, turns: [{ prompt: 'one' }, { prompt: 'two' }, { prompt: 'three' }] })
      check('§3 the three-turn process exits 0', r.exit === 0 && r.stdout.includes('S3-THREE'), `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`)
      const notices = transcriptNotices(arena.home, SID)
      check('§3 the first unlawful drop writes exactly one receipt into the transcript; the recurrent drop writes none', notices.length === 1 && notices[0]!.includes('dropped 1 thinking block') && notices[0]!.includes('client-side edit'), j(notices))
      const ledgerPath = join(arena.home, '.mercury', 'preserved-thinking.json')
      const ledger = existsSync(ledgerPath) ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as { last?: { kind?: string; consecutive?: number }; session?: { id?: string; drops?: number; notice?: string } }) : null
      check('§3 the ledger records the run and the session\'s drops with the receipt sentence', ledger?.last?.kind === 'recurrent' && ledger.last.consecutive === 2 && ledger.session?.id === SID && ledger.session.drops === 2 && (ledger.session.notice ?? '').startsWith('Preserved thinking:'), j(ledger))
      check('§3 the rows stream carries no notice row for the drop (the receipt lives in the transcript and the health row — the pinned law the field\'s THK-02 disputes)', !r.frames.some(f => f.type === 'notice' && String((f as { text?: unknown }).text ?? '').includes('Preserved thinking')), j(r.frames.filter(f => f.type === 'notice')))
      await fixture.close()
    }
  }
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? `✅ MEMORY SAVE KEEPS THE PREFIX (${checks} checks)` : `❌ ${failures} of ${checks} MEMORY-SAVE-KEEPS-PREFIX CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
