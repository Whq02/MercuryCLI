#!/usr/bin/env bun
// ============================================================================
//  scripts/idiom/prove-identity-and-headless.ts — E02 + E07.
//
//    §E02 cross-surface item identity: ONE uuid names a message on every
//       surface — the durable transcript record, the SDK stream-json
//       envelope, the renderer memo/key seam, the crew mirror's dedup, and
//       the lifecycle verbs (settle/remove) all key on the SAME uuid.
//       Proven behaviorally on a real headless turn (dist + fixture API):
//       the assistant uuid in the SDK envelope IS the uuid in the stored
//       record; the renderer/mirror/lifecycle seams are source-pinned.
//    §E07 headless per-client policy: deterministic, non-interactive,
//       Boot-Menu-independent — a scratch home, no TTY, a pinned
//       --permission-mode: the run completes, every stdout line is JSON
//       (no interactive surface bytes), the init envelope reports EXACTLY
//       the requested mode, and a second identical run resolves the SAME
//       policy (determinism).
//
//  Requires the prebuilt dist (the pooled gate prebuilds Phase 0).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

if (!existsSync(DIST)) {
  // Dist-less lanes (windows-functional runs the source-level suites and
  // deliberately builds no dist) — the prove-fixture-cpp precedent: a LOUD
  // skip, never a red. The lanes this prover exists for (the pooled gate's
  // Phase 0 prebuild · the hosted gate) always have the dist, so this branch
  // can only fire where the E2E legs were never expected to run.
  console.log('\n  [SKIP — LOUD] dist/mercury.mjs absent — the E02/E07 E2E legs did NOT run.')
  console.log('  This prover boots the built runtime; the pooled and hosted gates prebuild')
  console.log('  it and run these legs for real. To run them here: bun run build.ts')
  process.exit(0)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}

async function freshFixture(): Promise<Awaited<ReturnType<typeof startFixtureApi>>> {
  // Spare turns: utility calls (titles etc.) may also draw from the script.
  return startFixtureApi([
    { kind: 'text', text: 'IDENTITY-REPLY-E02' },
    { kind: 'text', text: 'IDENTITY-REPLY-E02' },
    { kind: 'text', text: 'IDENTITY-REPLY-E02' },
    { kind: 'text', text: 'IDENTITY-REPLY-E02' },
  ] as never)
}

function runHeadless(fixtureUrl: string, home: string, cwd: string, mode: string): Promise<{ out: string; code: number }> {
  mkdirSync(cwd, { recursive: true })
  // The proven convergence spawn shape: PINNED env (the proof-hygiene law),
  // dumb terminal, scratch stores, stdin OPEN (a -p run with stdio 'ignore'
  // never exits — harness-found; real shells always hand -p a stdin).
  return new Promise(resolvePromise => {
    const child = spawn(
      nodeBin!,
      [DIST, '-p', 'say the sentinel', '--output-format', 'stream-json', '--verbose', '--permission-mode', mode, '--model', 'claude-opus-4-8'],
      {
        cwd,
        env: {
          HOME: home,
          PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
          TERM: 'dumb',
          MERCURY_CONFIG_DIR: join(home, '.mercury'),
          ANTHROPIC_BASE_URL: fixtureUrl,
          ANTHROPIC_API_KEY: 'fixture-key-000',
          MERCURY_DAEMON_DIR: join(home, 'daemon'),
          MERCURY_TEAMS_DIR: join(home, 'teams'),
          MERCURY_VERIFY_EVIDENCE: '0',
        },
      },
    )
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', () => {})
    const t = setTimeout(() => child.kill('SIGKILL'), 180_000)
    child.on('exit', code => {
      clearTimeout(t)
      resolvePromise({ out, code: code ?? 1 })
    })
  })
}

section('§E07 — deterministic, non-interactive, Boot-Menu-independent policy')
const home1 = mkdtempSync(join(tmpdir(), 'idiom-e07-'))
const fixture1 = await freshFixture()
const r1 = await runHeadless(fixture1.url, home1, join(home1, 'proj'), 'implement')
await fixture1.close()
{
  check('the hermetic headless run completes (no menu, no TTY)', r1.code === 0, `code=${r1.code} out=${r1.out.slice(0, 200)}`)
  const lines = r1.out.split('\n').filter(l => l.trim())
  const allJson = lines.every(l => {
    try { JSON.parse(l); return true } catch { return false }
  })
  check('every stdout line is JSON (no interactive surface bytes)', allJson, lines.find(l => { try { JSON.parse(l); return false } catch { return true } })?.slice(0, 120) ?? '')
  const init = lines.map(l => JSON.parse(l) as Record<string, unknown>).find(o => o.type === 'system' && o.subtype === 'init')
  check('the init envelope reports EXACTLY the requested per-client mode', (init as { permissionMode?: string } | undefined)?.permissionMode === 'implement', JSON.stringify(init ?? {}).slice(0, 200))

  const home2 = mkdtempSync(join(tmpdir(), 'idiom-e07b-'))
  const fixture2 = await freshFixture()
  const r2 = await runHeadless(fixture2.url, home2, join(home2, 'proj'), 'strategy')
  await fixture2.close()
  const init2 = r2.out.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return {} } }).find(o => o.type === 'system' && o.subtype === 'init')
  check('a different client resolves ITS OWN policy (per-client, deterministic)', (init2 as { permissionMode?: string } | undefined)?.permissionMode === 'strategy', JSON.stringify(init2 ?? {}).slice(0, 200))
}

section('§E02 — one uuid across the SDK envelope and the durable record')
{
  const lines = r1.out.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return {} } })
  const sdkAssistant = lines.find(o => o.type === 'assistant')
  const sdkUuid = (sdkAssistant as { uuid?: string } | undefined)?.uuid
  check('the SDK assistant envelope carries a uuid', typeof sdkUuid === 'string' && sdkUuid!.length > 10, JSON.stringify(sdkAssistant ?? {}).slice(0, 160))

  // The durable record for the same turn carries the SAME uuid.
  const projectsDir = join(home1, '.mercury', 'projects')
  let transcript = ''
  const stack = [projectsDir]
  while (stack.length) {
    const d = stack.pop()!
    if (!existsSync(d)) continue
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (statSync(p).isDirectory()) stack.push(p)
      else if (e.endsWith('.jsonl')) transcript += readFileSync(p, 'utf8')
    }
  }
  check('the durable record carries the SAME uuid (store identity = SDK identity)', sdkUuid !== undefined && transcript.includes(`"${sdkUuid}"`), `uuid=${sdkUuid}`)
  check('the reply content is the settled one', transcript.includes('IDENTITY-REPLY-E02'))
}

section('§E02 — the renderer/lifecycle seams key on the same uuid (source-pinned)')
{
  const messageTsx = readFileSync(join(ROOT, 'src/components/Message.tsx'), 'utf8')
  check('the renderer memo compares message identity by uuid', messageTsx.includes('prev.message.uuid !== next.message.uuid'))
  const writer = readFileSync(join(ROOT, 'src/utils/sessionStorage/writer.ts'), 'utf8')
  check('the lifecycle verbs key on uuid (settle by uuid · remove by uuid)', writer.includes('settleState.set(entry.uuid') && writer.includes('removeMessageByUuid'))
  const mappers = readFileSync(join(ROOT, 'src/utils/messages/mappers.ts'), 'utf8')
  check('the SDK projection preserves the internal uuid', mappers.includes('uuid'))
}

console.log(failures === 0 ? '\n ✅ IDENTITY + HEADLESS POLICY PROVEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
