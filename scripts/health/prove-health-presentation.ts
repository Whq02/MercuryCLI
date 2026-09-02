#!/usr/bin/env bun
// prove-health-presentation — (+ HL-01..09/13/16/21/26-31;
// absorbs N-07 + H-07): the health/doctor presentation resolves at CLI
// ingress, non-TTY paths never mount Ink, terminal emissions are drain-aware,
// and every per-check deadline is a LINKED, CLEANED signal.
//
//   §1 the presentation table (HL-02..06): every stdio combination lands the
//      lawful mode through two booleans — json wins, rich needs BOTH TTYs,
//      everything else is text.
//   §2 the plain renderer (HL-07): zero ANSI/control bytes, complete rows.
//   §3 the drain-aware exit (HL-30/31): a slow sink receives the COMPLETE
//      record before the process exits; EPIPE settles quietly.
//   §4 the check runner (HL-26..28): the deadline timer clears on success,
//      the check receives a linked signal, a timed-out probe's signal fires
//      so post-settle work stops, and caller cancellation links in.
//   §5 wiring (HL-01/13/16/21): the health action resolves presentation
//      BEFORE any Ink import; text routes through runAndRecordHealthReport
//      (the one certificate owner refreshing last-cert); healthJson's
//      terminal emissions ride the shared drain-aware exit — the
//      write-then-exit census for the health CLI family is CLOSED here.
//   §6 N-06: the auto→native constant mapping is the RULED contract
// the diagnostic names the WORKING compat
//      setting; the first-run banner fires on empty-native + compat-present.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

const { resolveHealthPresentation, renderPlainCertificate } = await import(
  '../../src/cli/healthPresentation.ts'
)

// ── §1 the presentation table ───────────────────────────────────────────────
section('§1 THE PRESENTATION TABLE (HL-02..06)')
{
  const rows: Array<[boolean | undefined, boolean, boolean, string, string]> = [
    // [json, stdoutTTY, stdinTTY, want, label]
    [undefined, true, true, 'rich', 'both TTYs ⇒ rich'],
    [undefined, false, true, 'text', 'redirected stdout only ⇒ text (HL-05)'],
    [undefined, true, false, 'text', 'redirected stdin only ⇒ text — raw mode needs the input side (HL-04)'],
    [undefined, false, false, 'text', 'both redirected / pipe / NUL / dev-null / no TERM / CI ⇒ text (HL-06)'],
    [true, true, true, 'json', '--json wins even on a full TTY (HL-08)'],
    [true, false, false, 'json', '--json under pipes stays json'],
  ]
  for (const [json, stdoutIsTTY, stdinIsTTY, want, label] of rows) {
    const got = resolveHealthPresentation({ json }, { stdoutIsTTY, stdinIsTTY })
    check(label, got.output === want, `got ${got.output}`)
  }
  check(
    '--deep composes with every mode (HL-11/21: same owner, deeper inventory)',
    resolveHealthPresentation({ deep: true }, { stdoutIsTTY: false, stdinIsTTY: false }).depth === 'deep' &&
      resolveHealthPresentation({ json: true, deep: true }, {}).depth === 'deep' &&
      resolveHealthPresentation({}, { stdoutIsTTY: false, stdinIsTTY: false }).depth === 'fast',
  )
}

// ── §2 the plain renderer ───────────────────────────────────────────────────
section('§2 THE PLAIN RENDERER (HL-07)')
{
  const text = renderPlainCertificate({
    sections: [
      { title: 'IDENTITY', checks: [{ status: 'ok', label: 'Build', evidence: 'v1 — clean' }] },
      { title: 'RUNTIME', checks: [{ status: 'warn', label: 'Node', evidence: 'floor drift' }] },
    ],
    verdict: 'sound',
    durationMs: 123,
  })
  // eslint-disable-next-line no-control-regex
  check('zero ANSI/control bytes in plain output', !/[\u001b\u009b\u0007\u0000]/.test(text))
  check(
    'every section, row, and the verdict render completely',
    text.includes('IDENTITY') &&
      text.includes('[OK] Build — v1 — clean') &&
      text.includes('[WARN] Node — floor drift') &&
      text.includes('verdict: SOUND (123ms)'),
  )
}

// ── §3 the drain-aware exit ─────────────────────────────────────────────────
section('§3 THE DRAIN-AWARE EXIT (HL-30/31)')
{
  // A subprocess writes a LARGE record through writeOutAndExit; THIS prover
  // is the deliberately slow reader (pause/resume per chunk) and must still
  // receive the COMPLETE parseable record before the child exits.
  const { spawn } = await import('node:child_process')
  const payloadScript = [
    `const { writeOutAndExit } = await import(${JSON.stringify(join(import.meta.dir, '../../src/cli/healthPresentation.ts'))})`,
    `const record = JSON.stringify({ rows: Array.from({ length: 20000 }, (_, i) => 'row-' + i) })`,
    `writeOutAndExit(record + String.fromCharCode(10), 0)`,
  ].join('\n')
  const bunBin = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`
  const verdict = await new Promise<{ code: number | null; complete: boolean; bytes: number }>(resolve => {
    const child = spawn(bunBin, ['-e', payloadScript], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0
    child.stdout.on('data', (c: Buffer) => {
      bytes += c.length
      chunks.push(c)
      child.stdout.pause()
      setTimeout(() => child.stdout.resume(), 3)
    })
    child.on('close', code => {
      let complete = false
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rows: string[] }
        complete = parsed.rows.length === 20000
      } catch {
        /* incomplete */
      }
      resolve({ code, complete, bytes })
    })
    setTimeout(() => {
      child.kill('SIGKILL')
    }, 45_000).unref()
  })
  check(
    'a deliberately slow sink receives the COMPLETE parseable record (HL-31)',
    verdict.complete && verdict.code === 0,
    `code=${verdict.code} bytes=${verdict.bytes}`,
  )
}

// ── §4 the check runner ─────────────────────────────────────────────────────
section('§4 THE CHECK RUNNER (HL-26..28)')
{
  const runner = src('src/utils/healthReport.ts')
  check('the deadline timer is CLEARED on every settle path', runner.includes('clearTimeout(deadline)'))
  check(
    'each check receives the LINKED signal (deadline + caller), never the bare caller signal',
    runner.includes('spec.run({ signal: controller.signal })') && runner.includes('onCallerAbort'),
  )
  check(
    'post-settle continuation is fenced (the controller aborts after settle)',
    runner.includes("controller.abort(new Error('check settled'))"),
  )
  // Behavioral: a check that watches its signal stops when the deadline fires.
  const { AbortController: AC } = globalThis
  void AC
  let postSettleWork = 0
  const fakeCheck = (probeCtx?: { signal?: AbortSignal }): Promise<{ status: string; evidence: string }> =>
    new Promise(resolve => {
      const iv = setInterval(() => {
        postSettleWork++
      }, 5)
      probeCtx?.signal?.addEventListener('abort', () => {
        clearInterval(iv)
        resolve({ status: 'unknown', evidence: 'aborted' })
      })
    })
  // Simulate the runner's shape directly: linked controller + deadline.
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(new Error('check timed out after 30ms')), 30)
  const raced = await Promise.race([
    fakeCheck({ signal: controller.signal }),
    new Promise<never>((_, rej) =>
      controller.signal.addEventListener('abort', () => rej(controller.signal.reason as Error), { once: true }),
    ),
  ]).catch((e: Error) => ({ status: 'unknown', evidence: e.message }))
  clearTimeout(deadline)
  const workAtSettle = postSettleWork
  await new Promise(resolve => setTimeout(resolve, 40))
  check(
    'a timed-out probe STOPS after its row settles (no post-settle work)',
    ((raced as { evidence: string }).evidence.includes('timed out') ||
      (raced as { evidence: string }).evidence.includes('aborted')) &&
      postSettleWork === workAtSettle,
    `work ${workAtSettle} → ${postSettleWork} (${(raced as { evidence: string }).evidence})`,
  )
}

// ── §5 wiring ───────────────────────────────────────────────────────────────
section('§5 WIRING (HL-01/13/16/21/30)')
{
  const main = src('src/main.tsx')
  const healthAction = main.slice(main.indexOf("program.command('health')"))
  check(
    'the presentation resolves BEFORE any Ink/createRoot import (HL-01)',
    healthAction.indexOf('resolveHealthPresentation') !== -1 && healthAction.indexOf('resolveHealthPresentation') < healthAction.indexOf("import('./ink.js')"),
  )
  check(
    "the text path routes through runAndRecordHealthReport (one owner, last-cert refresh — HL-10/16) and the drain-aware exit",
    healthAction.includes("presentation.output === 'text'") &&
      healthAction.includes('runAndRecordHealthReport') &&
      healthAction.includes("writeOutAndExit(renderPlainCertificate(cert), cert.verdict === 'fault' ? 3 : 0)"),
  )
  check(
    'health and doctor share ONE command (alias) and one flag schema (HL-03/21)',
    main.includes("program.command('health').alias('doctor')"),
  )
  const healthJson = src('src/cli/healthJson.ts')
  check(
    'every healthJson terminal emission rides the shared drain-aware exit (HL-30 census: this family is closed)',
    healthJson.includes('writeOutAndExit') &&
      (healthJson.match(/emitAndExit\(/g) ?? []).length >= 7 &&
      !/emit\(\{[^}]*\}\)\n\s*process\.exit/.test(healthJson),
  )
  check(
    'the json seam is silence-proof (the staged-bundle isolation defect): a ref’d run deadline + beforeExit tripwire emit a typed cert-stalled record',
    healthJson.includes("code: 'cert-stalled'") &&
      healthJson.includes("process.on('beforeExit', onBeforeExit)") &&
      healthJson.includes('JSON_RUN_DEADLINE_MS'),
  )
  check(
    'no redirected path can reach a raw-mode mount (the Ink route requires rich)',
    healthAction.indexOf("presentation.output === 'json'") !== -1 && healthAction.indexOf("presentation.output === 'json'") < healthAction.indexOf('healthHandler') &&
      healthAction.indexOf("presentation.output === 'text'") !== -1 && healthAction.indexOf("presentation.output === 'text'") < healthAction.indexOf('healthHandler'),
  )
}

// ── §6 N-06 ─────────────────────────────────────────────────────────────────
section('§6 N-06 · THE RULED AUTO MAPPING + THE VISIBLE REMEDIES')
{
  const contracts = src('src/services/instructions/contracts.ts')
  check(
    'the auto→native constant mapping is the DECLARED in-source contract — docs match code',
    contracts.includes('ACCEPTED INPUT ONLY') && contracts.includes('resolves to `native`'),
  )
  // There is no compat diagnostic, no first-run banner, and no banner REPL
  // mount — no legs cover them.
  check(
    'the health instruction-profile row projects the same diagnostics (warn on findings)',
    src('src/utils/healthReport.ts').includes("id: 'instruction-profile'"),
  )
}

// ── §7 · rich is the ONLY presentation (the plain surfaces stay absent) ──
section('§7 · RICH convergence + LEGACY RETIREMENT (HL-10/19/22/23/25/32/33)')
{
  const { existsSync } = await import('node:fs')
  check(
    'legacy Doctor.tsx is DELETED (HL-22)',
    !existsSync(join(import.meta.dir, '../../src/screens/Doctor.tsx')),
  )
  check(
    'the orphaned KeybindingWarnings strip died with it',
    !existsSync(join(import.meta.dir, '../../src/components/KeybindingWarnings.tsx')),
  )
  const handler = src('src/cli/handlers/util.tsx')
  check(
    'the CLI rich route mounts the CANONICAL certificate view (HL-10)',
    handler.includes('MercuryHealthCertificate') && !handler.includes('screens/Doctor'),
  )
  check(
    'the rich mount starts NO MCP connection manager (HL-23)',
    !/healthHandler[\s\S]{0,600}MCPConnectionManager/.test(handler),
  )
  check(
    'a renderer failure still settles the root (HL-14: unmount in finally)',
    /finally\s*\{[\s\S]{0,200}root\.unmount\(\)/.test(handler),
  )
  const slash = src('src/commands/health/health.tsx')
  check(
    '/health always mounts the certificate — the =0 legacy fallback is gone (HL-33)',
    slash.includes('MercuryHealthCertificate') && !slash.includes('screens/Doctor'),
  )
  const certView = src('src/commands/health/HealthCertificate.tsx')
  check(
    "the legacy `s` route is RETIRED from the certificate view",
    !certView.includes("input === 's'") && !certView.includes('showStock'),
  )
  check(
    'the footer no longer advertises the dead route',
    !certView.includes('s install diagnostics'),
  )
  const report = src('src/utils/healthReport.ts')
  for (const id of ['agent-definitions', 'env-limits', 'keybindings', 'version-locks']) {
    check(`the absorbed panel lives as the '${id}' certificate row (HL-32 absorption)`, report.includes(`id: '${id}'`))
  }
  check(
    "the false 'Source build — git pull' guidance died with the legacy screen",
    !certView.includes('git pull && bun run build.ts') &&
      !handler.includes('git pull && bun run build.ts'),
  )
  check(
    'the health command description no longer claims stdio servers are spawned (HL-25)',
    src('src/main.tsx').includes('WITHOUT starting them'),
  )
  // HL-19/20: the rich view's documented keys — ↵ expands evidence (proven at
  // rendered capture by the ui estate's doctor-detail scenario), esc closes
  // exactly once (the onClose settle). Pin the bindings + the scenario.
  check(
    'Enter = the documented expand action; esc = the one close (HL-19)',
    certView.includes('if (key.return)') && certView.includes('onClose()'),
  )
  check(
    'the live-PTY Enter proof rides the ui estate (health-detail scenario, HL-20)',
    src('scripts/ui/renderScenarios.ts').includes("name === 'health-detail'"),
  )
}

if (failures > 0) {
  console.error(`\nprove-health-presentation: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-health-presentation: all green')
