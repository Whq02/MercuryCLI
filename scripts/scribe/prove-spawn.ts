#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-spawn.ts
//  PROOF (Phase 4 Task 4.1): spawnStreamJsonChild builds the right stream-json
//  invocation with a CLONED per-role env (never mutating the supervisor's
//  process.env), arms NO 30m kill timer (the child is long-lived), and returns
//  a child with an open writable stdin (the reply→stdin path).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-spawn.ts
//
//  The argv/env are built by a pure buildStreamJsonInvocation() so they're
//  asserted without spawning. The live stdin/alive check spawns a harmless STUB
//  (process.argv[1] redirected) — never the real hermes / a live API session.
// ============================================================================

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  buildStreamJsonInvocation,
  spawnStreamJsonChild,
} from '../../src/daemon/headlessRun.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const SPEC = {
  model: 'claude-opus-4-8[1m]',
  effort: 'xhigh',
  appendSystemPrompt: '<pack>implementer</pack>',
  role: 'MERCURY_IMPLEMENTER' as const,
  agentName: 'implementer',
  agentId: 'implementer@scribe',
  teamName: 'scribe',
}

console.log('============================================================')
console.log(' spawnStreamJsonChild — Phase-4 Task 4.1 proof')
console.log('============================================================')

section('buildStreamJsonInvocation — argv (pure)')
const inv = buildStreamJsonInvocation(SPEC)
const argvStr = inv.argv.join(' ')
check('argv has --input-format=stream-json', inv.argv.includes('--input-format=stream-json'))
check('argv has --output-format=stream-json', inv.argv.includes('--output-format=stream-json'))
check('argv has --model <literal>', inv.argv.includes('--model') && inv.argv[inv.argv.indexOf('--model') + 1] === SPEC.model)
check('argv has --append-system-prompt <pack>', inv.argv.includes('--append-system-prompt') && inv.argv[inv.argv.indexOf('--append-system-prompt') + 1] === SPEC.appendSystemPrompt)
check('argv has the --team-name/--agent-name/--agent-id triplet', argvStr.includes('--team-name scribe') && argvStr.includes('--agent-name implementer') && argvStr.includes('--agent-id implementer@scribe'))
check('argv runs in -p (headless) mode', inv.argv.includes('-p'))
// MAKE-OR-BREAK: print.ts exits 1 on `--output-format=stream-json && !verbose`,
// so WITHOUT --verbose the long-lived Implementer dies on its first output line
// and never runs a turn. (This is concrete proof the live path was never run.)
check('argv has --verbose (stream-json print mode requires it or the child exits 1)', inv.argv.includes('--verbose'))

section('buildStreamJsonInvocation — env is a CLONE (supervisor not mutated)')
const beforeModel = process.env.ANTHROPIC_MODEL
const beforeEffort = process.env.MERCURY_EFFORT_LEVEL
const beforeImpl = process.env.MERCURY_IMPLEMENTER
check('env.ANTHROPIC_MODEL === model', inv.env.ANTHROPIC_MODEL === SPEC.model)
check('env.MERCURY_EFFORT_LEVEL === xhigh', inv.env.MERCURY_EFFORT_LEVEL === 'xhigh')
check('env.MERCURY_SWARMS === 1', inv.env.MERCURY_SWARMS === '1')
check('env[role] === 1 (MERCURY_IMPLEMENTER)', inv.env.MERCURY_IMPLEMENTER === '1')
check('env is a DISTINCT object (not process.env)', inv.env !== process.env)
check('process.env.ANTHROPIC_MODEL NOT mutated', process.env.ANTHROPIC_MODEL === beforeModel)
check('process.env.MERCURY_EFFORT_LEVEL NOT mutated', process.env.MERCURY_EFFORT_LEVEL === beforeEffort)
check('process.env.MERCURY_IMPLEMENTER NOT mutated', process.env.MERCURY_IMPLEMENTER === beforeImpl)

section('env strips the SIBLING role var (a scribe-tagged parent must not crash-loop the Implementer)')
// If the daemon is auto-started from the foreground Scribe (MERCURY_SCRIBE=1), the
// env clone (...process.env) would inherit MERCURY_SCRIBE into the Implementer child
// → assertSingleRole() sees BOTH roles → throws → crash-loop. The invocation MUST
// sanitize the sibling role so exactly one role var is ever present.
const savedScribe = process.env.MERCURY_SCRIBE
process.env.MERCURY_SCRIBE = '1' // simulate a scribe-tagged parent
const invFromScribeParent = buildStreamJsonInvocation(SPEC)
check('child env DROPS the inherited sibling MERCURY_SCRIBE', invFromScribeParent.env.MERCURY_SCRIBE === undefined)
check('child env keeps its OWN role MERCURY_IMPLEMENTER=1', invFromScribeParent.env.MERCURY_IMPLEMENTER === '1')
if (savedScribe === undefined) delete process.env.MERCURY_SCRIBE
else process.env.MERCURY_SCRIBE = savedScribe

section('no 30m kill timer for this variant (structural)')
const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'headlessRun.ts'), 'utf-8')
const fnBody = src.slice(src.indexOf('export function spawnStreamJsonChild'))
const fnOnly = fnBody.slice(0, fnBody.indexOf('\n}\n') + 2)
check('spawnStreamJsonChild body has NO setTimeout', !/setTimeout/.test(fnOnly))
check('spawnStreamJsonChild body has NO SIGKILL', !/SIGKILL/.test(fnOnly))
check('spawnStreamJsonChild body has NO getRunTimeoutMs', !/getRunTimeoutMs/.test(fnOnly))

section('live: spawn a STUB → open writable stdin, stays alive (no kill timer)')
{
  const dir = mkdtempSync(join(tmpdir(), 'hermes-spawn-'))
  const stub = join(dir, 'stub.mjs')
  writeFileSync(stub, 'process.stdin.resume();process.stdin.on("data",()=>{});setInterval(()=>{},100000);\n')
  const savedArgv1 = process.argv[1]
  process.argv[1] = stub // getSelfInvocation() → this stub, not real hermes
  try {
    const handle = spawnStreamJsonChild({ ...SPEC, cwd: dir })
    check('returns a child with a pid', typeof handle.child.pid === 'number' && handle.child.pid! > 0)
    check('child stdin is an open writable stream', !!handle.child.stdin && handle.child.stdin.writable === true)
    // write a stream-json line — must not throw
    let wrote = false
    try { handle.child.stdin!.write('{"type":"user"}\n'); wrote = true } catch { wrote = false }
    check('can write a frame to the child stdin', wrote)
    await sleep(200)
    check('child is STILL ALIVE after 200ms (no kill timer fired)', handle.child.exitCode === null && handle.child.signalCode === null)
    handle.child.kill('SIGKILL')
  } finally {
    process.argv[1] = savedArgv1
  }
}

section('implementer permission posture — run-#2/#3 parity with the party seats')
{
  // Structural: the REAL spec in main.ts carries both fields (the spec is
  // inline there, not a builder — so pin the source, like the party proof
  // pins its spawn wiring).
  const mainSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'main.ts'), 'utf-8')
  const specBlock = mainSrc.slice(mainSrc.indexOf("registerLongLived('implementer'"))
  // Terminate at the spawn log line that FOLLOWS the registration — the spec
  // object itself contains a `: {})` (the workflows spread), so a bare `})`
  // scan would truncate before the posture fields.
  const specOnly = specBlock.slice(0, specBlock.indexOf('Amanuensis Implementer spawned'))
  check("main.ts implementer spec carries permissionMode: 'flow' (asks classify, never terminal-deny)", /permissionMode: 'flow'/.test(specOnly))
  check('main.ts implementer spec carries allowedTools: resolveWorkerReconAllow() (classifier-fault immune recon)', /allowedTools: resolveWorkerReconAllow\(\)/.test(specOnly))
  // Behavioral: a spec with those fields produces the right argv through the
  // SAME seam the daemon uses (the recon allowlist's own laws are proven in
  // scripts/daemon/prove-worker-recon.ts — one seam).
  const posted = buildStreamJsonInvocation({ ...SPEC, permissionMode: 'flow', allowedTools: ['Bash(rg:*)', 'Bash(git status:*)'] })
  const pi = posted.argv.indexOf('--permission-mode')
  check('argv carries --permission-mode flow', pi >= 0 && posted.argv[pi + 1] === 'flow')
  const ai = posted.argv.indexOf('--allowedTools')
  check('argv carries the recon --allowedTools rules', ai >= 0 && posted.argv[ai + 1] === 'Bash(rg:*)' && posted.argv[ai + 2] === 'Bash(git status:*)')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SPAWN PROOFS PASS')
else console.log(`❌ ${failures} SPAWN PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
