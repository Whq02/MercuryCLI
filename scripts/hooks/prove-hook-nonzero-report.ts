#!/usr/bin/env bun
// ============================================================================
//  scripts/hooks/prove-hook-nonzero-report.ts — a non-zero hook exit REPORTS
//  (FC-083). The /hooks browser promises on every event screen that "any
//  other non-zero shows stderr to the user only and continues" — but a
//  headless run's hook_non_blocking_error attachment reached no stream: a
//  settled -p turn with a hook exiting 1 delivered its answer and said
//  nothing anywhere (driven at diagnosis over a mock endpoint). And the one
//  channel that carried anything, the --debug log, printed the hook's
//  STDOUT where the promise names stderr.
//
//  §1 LIVE: a settled -p turn over this prover's own SSE mock endpoint — the
//     hook fails, the turn proceeds (exit 0, answer delivered), and stderr
//     carries the one-line report with the hook's stderr.
//  §2 the debug channel prefers stderr on error (call-shaped).
//  §3 the interactive road keeps its attachment renderer (call-shaped).
//
//  Run: ~/.bun/bin/bun run scripts/hooks/prove-hook-nonzero-report.ts
// ============================================================================
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

console.log('§1 LIVE — the settled turn reports the failed hook')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — this leg drives the artifact)', false)
  } else {
    // The mock endpoint: SSE chat completions, no credential — the turn
    // SETTLES, which is the honest ground (an auth-dead run cannot tell
    // "dropped always" from "dropped with the turn"). Spawned as a NODE
    // child: the artifact's fetch settles against node's http server; an
    // in-bun server flaked the stream mid-turn.
    const port = 18461
    const mockPath = join(mkdtempSync(join(tmpdir(), 'hook-report-mock-')), 'mock.mjs')
    writeFileSync(
      mockPath,
      [
        "import { createServer } from 'node:http'",
        'const server = createServer((req, res) => {',
        "  let body = ''",
        "  req.on('data', c => (body += c))",
        "  req.on('end', () => {",
        "    if (req.url && req.url.includes('/models')) {",
        "      res.writeHead(200, { 'content-type': 'application/json' })",
        "      res.end(JSON.stringify({ object: 'list', data: [{ id: 'w17-mock', object: 'model' }] }))",
        '      return',
        '    }',
        "    if (req.url && req.url.includes('/chat/completions')) {",
        "      res.writeHead(200, { 'content-type': 'text/event-stream' })",
        '      const frame = o => res.write(`data: ${JSON.stringify(o)}\\n\\n`)',
        "      const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'w17-mock' }",
        "      frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'MOCK-ANSWER' }, finish_reason: null }] })",
        "      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })",
        "      res.write('data: [DONE]\\n\\n')",
        '      res.end()',
        '      return',
        '    }',
        "    res.writeHead(404).end('{}')",
        '  })',
        '})',
        `server.listen(${port}, '127.0.0.1', () => console.log('ready'))`,
      ].join('\n'),
    )
    const { spawn } = await import('node:child_process')
    const mock = spawn('node', [mockPath], { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>(resolve => {
      mock.stdout.on('data', d => {
        if (String(d).includes('ready')) resolve()
      })
      setTimeout(resolve, 3000)
    })

    const home = realpathSync(mkdtempSync(join(tmpdir(), 'hook-report-home-')))
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'hook-report-proj-')))
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        model: 'compat/w17-mock',
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'echo FEEDBACK-SENTINEL 1>&2; exit 1' }] },
          ],
        },
      }),
    )
    const run = spawnSync('node', [DIST, '-p', 'hi'], {
      cwd: proj,
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: home,
        MERCURY_COMPAT_BASE_URL: `http://127.0.0.1:${port}/v1`,
        MERCURY_COMPAT_API_KEY: 'fixture',
        NODE_ENV: undefined,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        MERCURY_OAUTH_TOKEN: undefined,
      } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 90000,
    })
    mock.kill()
    const out = run.stdout ?? ''
    const err = run.stderr ?? ''
    check('the turn SETTLES and the answer is delivered (the hook never blocks)', run.status === 0 && out.includes('MOCK-ANSWER'), `rc=${run.status} out=${out.slice(0, 60)}`)
    check(
      "stderr carries the one-line report with the hook's stderr (the promise kept)",
      err.includes('failed with exit 1') && err.includes('FEEDBACK-SENTINEL'),
      err.slice(0, 140).replace(/\s+/g, ' '),
    )
    // The on-disk half (the Windows field's TASK-018 wave 5): the settled
    // turn's transcript KEEPS the hook's failure row — the record the
    // daemon-hosted cockpit paints from. Base: isLoggableMessage dropped
    // every attachment for external transcripts, so the composed
    // hook_non_blocking_error reached no file and therefore no frame.
    const { readdirSync, statSync } = await import('node:fs')
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap(f => {
        const p = join(dir, f)
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsonl') ? [p] : []
      })
    const files = existsSync(join(home, 'projects')) ? walk(join(home, 'projects')) : []
    const rows = files
      .flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean))
      .map(l => {
        try {
          return JSON.parse(l) as { payload?: { kind?: string; attachmentType?: string } }
        } catch {
          return null
        }
      })
      .filter((r): r is { payload?: { kind?: string; attachmentType?: string } } => r !== null)
    const hookRows = rows.filter(r => r.payload?.kind === 'attachment' && r.payload?.attachmentType === 'hook_non_blocking_error')
    check(
      "the transcript file keeps the hook's failure row carrying its stderr (the cockpit paints from this file)",
      hookRows.length >= 1 && JSON.stringify(hookRows).includes('FEEDBACK-SENTINEL'),
      `${files.length} file(s) · ${rows.length} row(s) · kinds=${[...new Set(rows.map(r => r.payload?.kind))].join(',')}`,
    )
    const { recordToEntry } = await import('../../src/fabric/entryCodec.js')
    const decoded = hookRows[0] !== undefined
      ? (recordToEntry(hookRows[0] as never) as { type?: string; attachment?: { type?: string; stderr?: string } })
      : undefined
    check(
      "…and the cockpit's decoder hands it back as the renderer's attachment",
      decoded?.type === 'attachment' && decoded.attachment?.type === 'hook_non_blocking_error' && String(decoded.attachment?.stderr ?? '').includes('FEEDBACK-SENTINEL'),
      JSON.stringify(decoded ?? null).slice(0, 200),
    )
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
}

console.log('§2 the debug channel prefers stderr on error (call-shaped)')
{
  const src = readFileSync(join(ROOT, 'src', 'utils', 'hooks', 'hookEvents.ts'), 'utf8')
  check(
    "emitHookResponse picks stderr first for outcome 'error'",
    /params\.outcome === 'error'\s*\n?\s*\? params\.stderr \|\| params\.stdout/.test(src),
  )
}

console.log('§3 the interactive road keeps its renderer (call-shaped)')
{
  const engine = readFileSync(join(ROOT, 'src', 'utils', 'hooks', 'engine.ts'), 'utf8')
  check('the engine writes the headless report line', /getIsNonInteractiveSession\(\)/.test(engine) && /failed with exit/.test(engine))
  const renderer = readFileSync(join(ROOT, 'src', 'components', 'messages', 'AttachmentMessage.tsx'), 'utf8')
  check(
    'the attachment renderer still names the error interactively',
    /hook_non_blocking_error/.test(renderer) && /reported an error/.test(renderer),
  )
}

console.log("§4 the failure row is the operator's record — the transcript filter keeps it (module-level)")
{
  const { isLoggableMessage } = await import('../../src/utils/sessionStorage/chain.js')
  const att = (type: string, extra: Record<string, unknown> = {}): never =>
    ({ type: 'attachment', uuid: 'u', timestamp: 't', attachment: { type, ...extra } }) as never
  check('hook_non_blocking_error persists', isLoggableMessage(att('hook_non_blocking_error', { hookName: 'h', hookEvent: 'UserPromptSubmit', stderr: 'x' })))
  check('hook_error_during_execution persists', isLoggableMessage(att('hook_error_during_execution', { hookName: 'h', hookEvent: 'PreToolUse' })))
  // The binding law (Claude Fable 5.1 preserved thinking, the TRANSCRIPT
  // lane): a row the REQUEST renders is part of the prefix the model's
  // thinking is bound to, so it persists and a resume replays it; a row
  // that renders nothing for the model stays out (the operator's record,
  // not a context dump) — the two laws meet at "does the projection emit".
  check('a context attachment WITH content persists (the request renders it — hook_additional_context)', isLoggableMessage(att('hook_additional_context', { hookName: 'h', content: ['ctx'] })))
  check('a context attachment without content stays out (renders nothing)', !isLoggableMessage(att('hook_additional_context', { hookName: 'h', content: [] })))
  check('a quiet success row stays out too (hook_success, empty)', !isLoggableMessage(att('hook_success', { hookName: 'h', hookEvent: 'UserPromptSubmit', content: '' })))
  check('a success row the model reads persists (hook_success on UserPromptSubmit with content)', isLoggableMessage(att('hook_success', { hookName: 'h', hookEvent: 'UserPromptSubmit', content: 'remember the style guide' })))
  check('a success row on an event the model never reads stays out (hook_success, PreToolUse)', !isLoggableMessage(att('hook_success', { hookName: 'h', hookEvent: 'PreToolUse', content: 'noise' })))
}

console.log(failures === 0 ? '\nprove-hook-nonzero-report: all green' : `\nprove-hook-nonzero-report: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
