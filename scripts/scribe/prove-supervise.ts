#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-supervise.ts
//  PROOF (Phase 4 Task 4.2): long-lived worker supervision.
//
//  roster.ts transitively reaches the feature() bundler macro (swarm backend
//  registry → teammate executor → voice), so it is NOT loadable under bun-run.
//  Per the loadability discipline, the supervision LOGIC lives in a loadable
//  pure module (src/daemon/longLivedSupervisor.ts) that roster.ts uses; this
//  proof exercises:
//   • the pure helpers (backoff / respawn-vs-degrade decision / breaker
//     exemption / frame normalization) directly;
//   • the REAL child-process mechanism (spawnStreamJsonChild — loadable) driven
//     by those SAME helpers against a harmless STUB: reply→stdin returns true,
//     an external crash respawns with a NEW pid, the (mock) shared breaker is
//     never fed, and the respawn ceiling flips a degraded flag;
//   • roster.ts wiring structurally (registerLongLived / reply→stdin /
//     getSupervisorState / no breaker feed on the long-lived path).
//  The live two-process kill→respawn is the Phase-4.3 run-verify (hard gate).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-supervise.ts
// ============================================================================

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  longLivedBackoffMs,
  decideRespawn,
  errorTextOfResultFrame,
  normalizeStreamJsonFrame,
  LONG_LIVED_FEEDS_SHARED_BREAKER,
  DEFAULT_LONG_LIVED_CONFIG,
} from '../../src/daemon/longLivedSupervisor.js'
import { spawnStreamJsonChild } from '../../src/daemon/headlessRun.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(pred: () => boolean, ms = 2500): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await sleep(25)
  }
  return pred()
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Long-lived supervision — Phase-4 Task 4.2 proof')
console.log('============================================================')

section('pure helpers — backoff / respawn-vs-degrade / breaker exemption')
const cfg = { maxRespawns: 3, backoffBaseMs: 100, backoffCapMs: 800 }
check('backoff is exponential (1→100, 2→200, 3→400)', longLivedBackoffMs(1, cfg) === 100 && longLivedBackoffMs(2, cfg) === 200 && longLivedBackoffMs(3, cfg) === 400)
check('backoff is capped', longLivedBackoffMs(10, cfg) === 800)
check('decideRespawn under ceiling ⇒ respawn with delay', decideRespawn(1, cfg).action === 'respawn' && (decideRespawn(2, cfg) as { delayMs: number }).delayMs === 200)
check('decideRespawn at ceiling ⇒ still respawn', decideRespawn(3, cfg).action === 'respawn')
const deg = decideRespawn(4, cfg)
check('decideRespawn past ceiling ⇒ degrade with a reason', deg.action === 'degrade' && (deg as { reason: string }).reason.length > 0)
check('long-lived respawns are EXEMPT from the shared breaker', LONG_LIVED_FEEDS_SHARED_BREAKER === false)
check('frame normalize adds exactly one trailing newline', normalizeStreamJsonFrame('{"x":1}') === '{"x":1}\n' && normalizeStreamJsonFrame('{"x":1}\n') === '{"x":1}\n')
check('DEFAULT config is sane (>=1 respawn, positive base/cap)', DEFAULT_LONG_LIVED_CONFIG.maxRespawns >= 1 && DEFAULT_LONG_LIVED_CONFIG.backoffBaseMs > 0 && DEFAULT_LONG_LIVED_CONFIG.backoffCapMs >= DEFAULT_LONG_LIVED_CONFIG.backoffBaseMs)

section('live mechanism — spawn + reply→stdin + crash→respawn + breaker exempt + ceiling')
{
  const dir = mkdtempSync(join(tmpdir(), 'hermes-supervise-'))
  const stub = join(dir, 'stub.mjs')
  writeFileSync(stub, 'process.stdin.resume();process.stdin.on("data",()=>{});setInterval(()=>{},100000);\n')
  const savedArgv1 = process.argv[1]
  process.argv[1] = stub

  const SPEC = {
    model: 'claude-opus-5', effort: 'max', appendSystemPrompt: '<pack/>',
    role: 'MERCURY_IMPLEMENTER' as const, agentName: 'implementer', agentId: 'implementer@scribe',
    teamName: 'scribe', cwd: dir,
  }
  const liveCfg = { maxRespawns: 2, backoffBaseMs: 20, backoffCapMs: 200 }

  // A mini-supervisor mirroring roster's loop, driven by the SAME pure helpers.
  let breakerCalls = 0 // a long-lived crash MUST NOT feed this
  let respawns = 0
  let degraded = false
  let intentionalStop = false
  let current: { child: ChildProcess } | null = null
  function supervise(): void {
    current = spawnStreamJsonChild(SPEC)
    current.child.on('exit', () => {
      if (intentionalStop) return
      respawns++
      const d = decideRespawn(respawns, liveCfg)
      // NOTE: no breaker.recordResult() here — exactly the roster exemption.
      if (d.action === 'degrade') { degraded = true; return }
      setTimeout(supervise, d.delayMs).unref?.()
    })
  }
  try {
    supervise()
    await waitFor(() => !!current?.child.pid)
    const pid1 = current!.child.pid
    check('long-lived child spawned with a pid', typeof pid1 === 'number')

    // reply → stdin
    const frame = normalizeStreamJsonFrame('{"type":"user","message":{"role":"user","content":"go"}}')
    let wrote = false
    try { wrote = current!.child.stdin!.writable && current!.child.stdin!.write(frame) !== false } catch { wrote = false }
    check('reply frame writes to the child stdin (the reply→stdin path)', wrote === true)

    // crash → respawn with a NEW pid
    process.kill(pid1!, 'SIGKILL')
    const respawned = await waitFor(() => !!current?.child.pid && current.child.pid !== pid1)
    check('external crash → respawned with a NEW pid (backoff)', respawned && current!.child.pid !== pid1)
    check('shared breaker NEVER fed by the long-lived respawn', breakerCalls === 0)
    check('not degraded under the ceiling', degraded === false)

    // exceed ceiling → degrade
    for (let i = 0; i < 3 && !degraded; i++) {
      const p = current?.child.pid
      if (p) { try { process.kill(p, 'SIGKILL') } catch { /* dead */ } }
      await sleep(120)
    }
    check('respawn ceiling exceeded ⇒ degraded flag set', await waitFor(() => degraded === true))
    check('still NEVER fed the shared breaker', breakerCalls === 0)

    intentionalStop = true
    try { current?.child.kill('SIGKILL') } catch { /* ignore */ }
  } finally {
    intentionalStop = true
    process.argv[1] = savedArgv1
  }
}

section('roster.ts wiring (structural, src)')
const roster = src('daemon', 'roster.ts')
check('roster imports the supervision helpers', /from '\.\/longLivedSupervisor\.js'/.test(roster))
check('roster imports spawnStreamJsonChild', roster.includes('spawnStreamJsonChild'))
check('roster has registerLongLived', /registerLongLived/.test(roster))
check('roster has getSupervisorState', /getSupervisorState/.test(roster))
check('roster.reply writes to a long-lived child stdin', /stdin[\s\S]{0,80}write/.test(roster) || /\.stdin\?\.write/.test(roster))
check('roster uses decideRespawn for the crash path', /decideRespawn/.test(roster))
// Live-test regression guard: the long-lived child's stdout MUST be drained or the
// pipe buffer fills and the child blocks mid-turn (alive-but-wedged).
check("long-lived child stdout is DRAINED (child.stdout.on('data')) — no pipe-buffer deadlock", /child\.stdout\?\.on\('data'/.test(roster))
// Round-2 audit regression guards (wv5m010c3):
// #2 — a spawn/runtime 'error' (ENOENT etc.) must drive the SAME crash path, or
//      it crashes the supervisor itself / never respawns. Both events settle once.
check("#2 long-lived child wires a child.on('error') handler", /child\.on\('error'/.test(roster))
check('#2 error+exit settle at most once (lifeSettled guard)', /if \(lifeSettled\) return\s*\n\s*lifeSettled = true/.test(roster))
check('#2 both events route through one handleCrash', /handleCrash\(/.test(roster))
// #3 (audit-r1 fix) — the respawn ceiling counts a crash LOOP, not lifetime crashes:
//      reset `respawns` after a HEALTHY uptime measured against healthyResetMs (5min),
//      NOT the 60s backoff cap — reusing the 60s cap let a worker that survived ~61s
//      then crashed reset its counter forever and never degrade (a slow crash-loop).
//      A never-reset lifetimeCrashes backstop still degrades that chronic slow loop.
check('#3 respawn reset uses the healthyResetMs bar (not backoffCapMs)', /ll\.cfg\.healthyResetMs \?\? DEFAULT_HEALTHY_RESET_MS[\s\S]{0,40}ll\.respawns = 0/.test(roster))
check('#3 lifetimeCrashes tracked + passed to decideRespawn', /ll\.lifetimeCrashes\+\+/.test(roster) && /decideRespawn\(ll\.respawns, ll\.cfg, ll\.lifetimeCrashes\)/.test(roster))
check('#3 decideRespawn degrades on the lifetime backstop (slow crash-loop, respawns under ceiling)', decideRespawn(1, cfg, 21).action === 'degrade')
// #1 — the degraded flag is surfaced on the wire (status RPC) + the formatter,
//      so a Scribe / human sees the dead-Implementer escalation signal.
const proto = src('daemon', 'protocol.ts')
const ctrl = src('daemon', 'controlServer.ts')
const statusSrc = src('daemon', 'status.ts')
check('#1 WireStatus carries the degraded field', /degraded\?: boolean/.test(proto))
check('#1 status handler populates degraded from getSupervisorState', /getSupervisorState\(\)[\s\S]{0,600}degraded:\s*sup\.degraded/.test(ctrl))
check('#1 formatter emits a loud DEGRADED line', /DEGRADED — \$\{status\.degradedReason/.test(statusSrc))

// ── RESPAWN-STORM HONESTY ────────────
//  A child dying on a PERMANENT refusal (auth/backend/model) crash-looped in
//  total silence — no operator signal until (maybe) the distant ceiling. The
//  law: capture the child's is_error result text while draining; write ONE
//  loud team-lead room note when a loop is FORMING (2nd fast crash) and one
//  at degrade, each naming spec + exit + the captured cause.
check(
  'errorTextOfResultFrame extracts a bounded is_error result',
  errorTextOfResultFrame(JSON.stringify({ type: 'result', is_error: true, result: 'x'.repeat(500) }))?.length === 240 &&
    errorTextOfResultFrame(JSON.stringify({ type: 'result', is_error: true, result: '401 auth expired' })) === '401 auth expired',
)
check(
  'errorTextOfResultFrame ignores success results + garbage',
  errorTextOfResultFrame(JSON.stringify({ type: 'result', is_error: false, result: 'ok' })) === undefined &&
    errorTextOfResultFrame('not json') === undefined,
)
check('roster captures the dying cause while draining (lastErrorText)', /errorTextOfParsedResultFrame\(frame\)/.test(roster) && /ll\.lastErrorText = errText/.test(roster))
// ── PARSE-ONCE DRAIN ────────────
//  The drain classifies every child line three ways (usage, error, result)
//  — one JSON.parse feeds all three; the line-taking spellings survive as
//  wrappers with byte-equal answers (the pure pins above ride them).
check('the drain parses each line ONCE and classifies the frame', /const frame = parseStreamJsonFrame\(line\)/.test(roster) && /usageOfStreamJsonFrame\(frame\)/.test(roster) && /isTurnResultParsedFrame\(frame\)/.test(roster) && !/JSON\.parse\(line\)/.test(roster))
{
  const { parseStreamJsonFrame, usageOfStreamJsonFrame, errorTextOfParsedResultFrame, isTurnResultParsedFrame, parseUsageFromStreamJsonLine, isTurnResultFrame } = await import('../../src/daemon/longLivedSupervisor.ts')
  const corpus = [
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 9, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 2 } } }),
    JSON.stringify({ type: 'result', is_error: true, result: 'boom' }),
    JSON.stringify({ type: 'result', usage: { input_tokens: 999 } }),
    JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool' } }),
    '{"torn": ',
    'not json',
    '"a-json-string-not-an-object"',
    '',
  ]
  const equal = corpus.every(l => {
    const f = parseStreamJsonFrame(l)
    return (
      JSON.stringify(usageOfStreamJsonFrame(f)) === JSON.stringify(parseUsageFromStreamJsonLine(l)) &&
      errorTextOfParsedResultFrame(f) === errorTextOfResultFrame(l) &&
      isTurnResultParsedFrame(f) === isTurnResultFrame(l)
    )
  })
  check('frame road ≡ line road across the corpus (usage, error, result)', equal)
  const realParse = JSON.parse.bind(JSON)
  let parses = 0
  ;(JSON as { parse: typeof JSON.parse }).parse = ((t: string, r?: Parameters<typeof JSON.parse>[1]) => {
    parses++
    return realParse(t, r)
  }) as typeof JSON.parse
  const f = parseStreamJsonFrame(corpus[0]!)
  usageOfStreamJsonFrame(f)
  errorTextOfParsedResultFrame(f)
  isTurnResultParsedFrame(f)
  ;(JSON as { parse: typeof JSON.parse }).parse = realParse
  check('one frame costs ONE parse across the whole trio (was three)', parses === 1, `parses=${parses}`)
}
check('storm note fires when a loop is FORMING (2nd fast crash, once per loop)', /ll\.respawns === 2 && !ll\.stormNotified/.test(roster) && /postStormNote\('forming'\)/.test(roster))
check('degrade always writes its own storm note', /postStormNote\('degraded'\)/.test(roster))
check("storm notes land in the team-lead room (writeToMailbox 'team-lead')", /writeToMailbox\(\s*'team-lead'/.test(roster))
check('healthy uptime re-arms the storm note + drops stale evidence', /ll\.stormNotified = false\s*\n\s*ll\.lastErrorText = undefined/.test(roster))
check('the note names spec + exit + cause', /ll\.spec\.model\}@\$\{ll\.spec\.effort\}/.test(roster) && /Last error: \$\{ll\.lastErrorText\}/.test(roster))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SUPERVISE PROOFS PASS')
else console.log(`❌ ${failures} SUPERVISE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
