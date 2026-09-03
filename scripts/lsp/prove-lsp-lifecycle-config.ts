// prove-lsp-lifecycle-config — the closure for the two language-server-schema
// lifecycle fields that would otherwise be ACCEPTED by validation and THROWN at
// construction ("not yet implemented"):
//
//   restartOnCrash  — now WIRED: default/true keeps lazy crash-recovery
//                     (restart on next use, ≤ maxRestarts); FALSE makes a
//                     crashed instance refuse the lazy respawn with a named
//                     error.
//   shutdownTimeout — now WIRED: bounds the graceful shutdown/exit handshake
//                     before the child is force-killed (default 2000ms).
//
// Driven against the REAL createLSPServerInstance + LSPClient over a scripted
// stdio server (fixtures/fake-lsp-server.mjs) — deterministic, no network,
// no real language server. The shutdown case is time-is-the-contract (a
// deadline IS the behavior): a 250ms configured deadline must return well
// under the 2000ms default while still actually waiting.

// Fork-sim BEFORE any import that folds off MACRO.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repo = path.resolve(import.meta.dir, '../..')

// F6 ambient-state law: never read the operator's machine — hermetic home.
const scratchHome = mkdtempSync(path.join(tmpdir(), 'mercury-lsp-lifecycle-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_LSP
delete process.env.MERCURY_LSP_SERVERS

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const { createLSPServerInstance } = await import(
  '../../src/services/lsp/LSPServerInstance.js'
)
const { LspServerConfigSchema } = await import(
  '../../src/services/lsp/schema.js'
)

const FAKE = path.join(repo, 'scripts/lsp/fixtures/fake-lsp-server.mjs')

function instance(
  name: string,
  mode: string,
  extra: Record<string, unknown> = {},
) {
  return createLSPServerInstance(name, {
    command: process.execPath,
    args: [FAKE],
    extensionToLanguage: { '.fake': 'fake' },
    transport: 'stdio' as const,
    env: { FAKE_LSP_MODE: mode },
    workspaceFolder: repo,
    startupTimeout: 8000,
    scope: 'dynamic' as const,
    source: 'lifecycle-proof',
    ...extra,
  } as Parameters<typeof createLSPServerInstance>[1])
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor(pred: () => boolean, deadlineMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < deadlineMs) {
    if (pred()) return true
    await sleep(25)
  }
  return pred()
}

console.log('prove-lsp-lifecycle-config — restartOnCrash + shutdownTimeout are real')

// ── 0. The schema still accepts both fields (the acceptance side) ──────────
{
  const parsed = LspServerConfigSchema().safeParse({
    command: '/usr/bin/true',
    extensionToLanguage: { '.x': 'x' },
    restartOnCrash: false,
    shutdownTimeout: 1234,
  })
  check('schema accepts restartOnCrash + shutdownTimeout', parsed.success)
}

// ── 1. Construction no longer throws on the fields ─────────────────────────
{
  let threw: string | null = null
  try {
    instance('construct-probe', 'normal', { restartOnCrash: false, shutdownTimeout: 500 })
  } catch (e) {
    threw = (e as Error).message
  }
  check('construction accepts both fields (no not-yet-implemented throw)', threw === null, threw ?? '')
}

// ── 2. Default: a crashed server lazily restarts on next use ───────────────
{
  const inst = instance('crash-default', 'crash-after-init')
  await inst.start()
  check('crash-default: first start reaches running', inst.state === 'running')
  const crashed = await waitFor(() => inst.state === 'error', 4000)
  check('crash-default: the scripted crash lands (state=error)', crashed, `state=${inst.state}`)
  let recovered = false
  try {
    await inst.start()
    // start() RESOLVING is the lazy restart — a refused respawn THROWS the
    // typed refusal (the restartOnCrash:false arm below pins that side).
    // The crash-after-init fixture re-crashes on its own schedule (after the
    // client's start has settled — its timer outlasts the handshake on any
    // box), so only start() RESOLVING is read here, never a later state.
    recovered = true
  } catch {
    recovered = false
  }
  check('crash-default: start() after a crash RECOVERS (lazy restart)', recovered, `state=${inst.state}`)
  // Reap the respawned child (it will crash again on its own, but be tidy).
  await inst.stop().catch(() => {})
}

// ── 3. restartOnCrash:false — a crashed instance refuses the lazy respawn ──
{
  const inst = instance('crash-pinned', 'crash-after-init', { restartOnCrash: false })
  await inst.start()
  const crashed = await waitFor(() => inst.state === 'error', 4000)
  check('restartOnCrash:false — the scripted crash lands', crashed, `state=${inst.state}`)
  let refusal: string | null = null
  try {
    await inst.start()
  } catch (e) {
    refusal = (e as Error).message
  }
  check(
    'restartOnCrash:false — start() refuses with the named error',
    refusal !== null && /restartOnCrash is false/.test(refusal),
    refusal ?? 'no throw',
  )
}

// ── 4. restartOnCrash:true — explicit true keeps recovery ──────────────────
{
  const inst = instance('crash-true', 'crash-after-init', { restartOnCrash: true })
  await inst.start()
  await waitFor(() => inst.state === 'error', 4000)
  let recovered = false
  try {
    await inst.start()
    recovered = inst.state === 'running'
  } catch {
    recovered = false
  }
  check('restartOnCrash:true — start() after a crash recovers', recovered, `state=${inst.state}`)
  await inst.stop().catch(() => {})
}

// ── 5. shutdownTimeout bounds a wedged graceful shutdown ───────────────────
{
  const inst = instance('wedged-stop', 'ignore-shutdown', { shutdownTimeout: 250 })
  await inst.start()
  check('ignore-shutdown: start reaches running', inst.state === 'running')
  const t0 = Date.now()
  await inst.stop()
  const elapsed = Date.now() - t0
  check('shutdownTimeout: stop() resolves (child force-killed)', inst.state === 'stopped', `state=${inst.state}`)
  check(
    `shutdownTimeout: the 250ms deadline governed the wait (elapsed ${elapsed}ms — must be ≥200 and <1800; the unconfigured default is 2000)`,
    elapsed >= 200 && elapsed < 1800,
  )
}

rmSync(scratchHome, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nprove-lsp-lifecycle-config: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-lsp-lifecycle-config: green')
process.exit(0)
