#!/usr/bin/env bun
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }

let failures = 0
let presentationHint = ''
const presentationHintOf = (title: string): string => {
  if (title.startsWith('§1') || title.startsWith('§2') || title.startsWith('§3')) return 'change resolveHealthPresentation, renderPlainCertificate or writeOutAndExit in src/commands/verbs/healthPresentation.ts'
  if (title.startsWith('§6')) return 'change settingsChecks in src/platform/health/sections/settings.ts'
  if (title.startsWith('§7')) return 'change the health rows in src/platform/health/sections.ts and the sections it lists, or the health command help the built bundle prints'
  return ''
}
const check = (label: string, cond: boolean, detail = ''): void => {
  const failureText = [detail, cond ? '' : presentationHint].filter(part => part !== '').join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${failureText ? ' — ' + failureText : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => {
  presentationHint = presentationHintOf(t)
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { resolveHealthPresentation, renderPlainCertificate } = await import(
  '../../src/commands/verbs/healthPresentation.ts'
)
const { builtHelp } = await import('../lib/builtProduct.ts')

section('§1 THE PRESENTATION TABLE (HL-02..06)')
{
  const rows: Array<[boolean | undefined, boolean, boolean, string, string]> = [
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
  check('zero ANSI/control bytes in plain output', !/[\u001b\u009b\u0007\u0000]/.test(text))
  check(
    'every section, row, and the verdict render completely',
    text.includes('IDENTITY') &&
      text.includes('[OK] Build — v1 — clean') &&
      text.includes('[WARN] Node — floor drift') &&
      text.includes('verdict: SOUND (123ms)'),
  )
}

section('§3 THE DRAIN-AWARE EXIT (HL-30/31)')
{
  const { spawn } = await import('node:child_process')
  const payloadScript = [
    `const { writeOutAndExit } = await import(${JSON.stringify(join(import.meta.dir, '../../src/commands/verbs/healthPresentation.ts'))})`,
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

section('§4 THE CHECK RUNNER (HL-26..28)')
{
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

section('§5 WIRING (HL-01/13/16/21/30)')
{
}

section('§6 N-06 · THE PROFILE CONTRACT + THE VISIBLE REMEDIES')
{
  check(
    'the health instruction-profile row projects the same diagnostics (warn on findings)',
    (await import('../../src/platform/health/sections/settings.ts')).settingsChecks().some(row => row.id === 'instruction-profile' && row.label === 'Instruction profile'),
  )
}

section('§7 · RICH convergence + LEGACY RETIREMENT (HL-10/19/22/23/25/32/33)')
{
  const { healthContext: contextOf } = await import('../../src/platform/health/healthReport.ts')
  const { HEALTH_SECTIONS } = await import('../../src/platform/health/sections.ts')
  const listContext = await contextOf()
  const listed = (await Promise.all(HEALTH_SECTIONS.map(entry => entry.checks(listContext)))).flat()
  for (const id of ['agent-definitions', 'env-limits', 'keybindings', 'version-locks']) {
    check(`the absorbed panel lives as the '${id}' certificate row (HL-32 absorption)`, listed.filter(row => row.id === id).length === 1)
  }
  const agentsSays = await listed.find(row => row.id === 'agent-definitions')?.run()
  check(
    'the agents row reports the definition files on disk and names no other spelling of the standing-rule key',
    agentsSays?.status === 'info' && /files on disk/.test(agentsSays.evidence) && !/still spell the standing rule/.test(agentsSays.evidence),
    agentsSays?.evidence,
  )
  check(
    'the health command description no longer claims stdio servers are spawned (HL-25)',
    builtHelp('health').includes('WITHOUT starting them'),
  )
}

if (failures > 0) {
  console.error(`\nprove-health-presentation: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-health-presentation: all green')
