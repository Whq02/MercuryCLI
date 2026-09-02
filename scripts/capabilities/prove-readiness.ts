// ============================================================================
//  prove-readiness — the local-first readiness truth center (Sol 5.6 WS2).
//
//  The WS2 honesty line, behaviorally:
//   1. A CONFIGURED MCP server with no current-process connection reads
//      `configured` — never ready/live (before this pass, /capabilities
//      painted config-only servers as `live`).
//   2. The same server with a PUBLISHED failed connection reads `failed`
//      with a remedy; a published connected state reads `ready`. One source
//      (mcpGauge's publish seam) feeds UI + doctor — no parallel truths.
//   3. tool:search rides the live searchToolsAvailability probe.
//   4. The ENVIRONMENT section carries the full FLAG_REGISTRY (150+ rows,
//      no caps) with effective value + polarity: a =0'd default-on gate
//      reads `disabled` with the documented OFF contract.
//   5. Engine rows re-read env live (MERCURY_WORKFLOWS=0 ⇒ disabled).
//   6. Every record uses the shared vocabulary and carries id/kind/label/
//      detail/source/lastCheckedAt.
//   7. `doctor --json` embeds the same records (dist leg, guarded by the
//      build-tree stamp so a stale dist skips instead of lying).
//
//  Fresh bun children per scenario (getGlobalConfig caches per process).
// ============================================================================
import { spawnSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures++
}

const REPO = join(new URL('.', import.meta.url).pathname, '../..')
const BUN = process.env.BUN ?? join(homedir(), '.bun/bin/bun')

interface Rec {
  id: string
  kind: string
  label: string
  state: string
  detail: string
  remedy?: string
  source: string
  lastCheckedAt: number
}

const PROBE = `
const c = await import('./src/utils/config.ts')
c.enableConfigs()
const store = await import('./src/utils/cockpit/mcpGauge.ts')
const pub = process.env.PROBE_PUBLISH
if (pub === 'failed') {
  store.publishMcpConnections([{ name: 'probe-server', type: 'failed', config: { type: 'stdio', command: 'true', args: [], env: {}, scope: 'global' }, error: 'spawn definitely-missing ENOENT' }])
} else if (pub === 'connected') {
  store.publishMcpConnections([{ name: 'probe-server', type: 'connected', config: { type: 'stdio', command: 'true', args: [], env: {}, scope: 'global' }, client: {}, capabilities: {}, cleanup: async () => {} }])
}
const r = await import('./src/utils/readiness.ts')
console.log(JSON.stringify(r.collectReadiness().records))
`

function probe(configHome: string, extraEnv: Record<string, string> = {}): Rec[] {
  const res = spawnSync(BUN, ['-e', PROBE], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, MERCURY_CONFIG_DIR: configHome, ...extraEnv },
  })
  if (res.status !== 0) throw new Error(`probe failed: ${res.stderr?.slice(0, 400)}`)
  const line = (res.stdout ?? '').trim().split('\n').at(-1) ?? '[]'
  return JSON.parse(line) as Rec[]
}

const VOCAB = new Set(['ready', 'starting', 'configured', 'degraded', 'unavailable', 'disabled', 'failed', 'stale'])
const scratch = mkdtempSync(join(tmpdir(), 'readiness-'))

try {
  const home = join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.mercury.json'), JSON.stringify({ mcpServers: { 'probe-server': { command: 'true' } } }))

  // ── (1) configured ≠ ready ────────────────────────────────────────────────
  const base = probe(home)
  const probeRow = base.find(r => r.id === 'mcp:probe-server')
  check(!!probeRow, 'configured MCP server has a readiness row')
  check(probeRow?.state === 'configured', `config-only server reads configured (got ${probeRow?.state})`)
  check(/no connection in this process/.test(probeRow?.detail ?? ''), 'detail says no current-process connection')
  check(!base.some(r => r.kind === 'mcp' && (r.state === 'ready' || (r.state as string) === 'live')), 'NO config-only MCP row ever reads ready/live')

  // ── (2) published runtime states upgrade honestly ────────────────────────
  const failed = probe(home, { PROBE_PUBLISH: 'failed' })
  const failedRow = failed.find(r => r.id === 'mcp:probe-server')
  check(failedRow?.state === 'failed', `published failed connection reads failed (got ${failedRow?.state})`)
  check(/ENOENT|failed/.test(failedRow?.detail ?? ''), 'failed row carries the server error')
  check(!!failedRow?.remedy, 'failed row carries a remedy')

  const connected = probe(home, { PROBE_PUBLISH: 'connected' })
  const connRow = connected.find(r => r.id === 'mcp:probe-server')
  check(connRow?.state === 'ready', `published connected state reads ready (got ${connRow?.state})`)

  // ── (3) search rides the live probe ──────────────────────────────────────
  const search = base.find(r => r.id === 'tool:search')
  check(!!search && (search.state === 'ready' || search.state === 'unavailable'), 'tool:search present with a probed state')
  check(/probe/.test(search?.source ?? ''), 'search source names the live probe')

  // ── (4) the environment section is the FULL registry, effective-valued ───
  const envRows = base.filter(r => r.kind === 'env')
  check(envRows.length >= 150, `environment section carries the registry (${envRows.length} rows ≥ 150 — no caps)`)
  const tabulaOff = probe(home, { MERCURY_TABULA: '0' })
  const tabulaRow = tabulaOff.find(r => r.id === 'env:MERCURY_TABULA')
  check(tabulaRow?.state === 'disabled', `=0'd default-on gate reads disabled (got ${tabulaRow?.state})`)
  check(/off — /.test(tabulaRow?.detail ?? ''), 'disabled gate detail carries the off contract')
  const wfEnv = base.find(r => r.id === 'env:MERCURY_WORKFLOWS')
  check(wfEnv?.state === 'ready', 'unset default-on gate reads ready (default)')

  // ── (5) engines re-read env live ─────────────────────────────────────────
  const wfOn = base.find(r => r.id === 'engine:workflows')
  check(wfOn?.state === 'ready', 'workflow engine ready by default')
  const wfOffRows = probe(home, { MERCURY_WORKFLOWS: '0' })
  const wfOff = wfOffRows.find(r => r.id === 'engine:workflows')
  check(wfOff?.state === 'disabled', `MERCURY_WORKFLOWS=0 ⇒ engine disabled (got ${wfOff?.state})`)

  // ── (5b) per-source failure isolation (carried from the deleted
  // capabilityInventory proof: ONE corrupt source degrades ITS rows alone) ──
  {
    const corruptHome = join(scratch, 'corrupt-extensions')
    mkdirSync(join(corruptHome, 'extensions'), { recursive: true })
    writeFileSync(join(corruptHome, '.mercury.json'), JSON.stringify({}))
    writeFileSync(join(corruptHome, 'extensions', 'installed.json'), '{ not json')
    const rows = probe(corruptHome)
    check(rows.length > 0, 'corrupt installed.json: the report still builds (no crash)')
    const ext = rows.find(r => r.id === 'extension:health')
    check(
      !!ext && (ext.state === 'unavailable' || ext.state === 'disabled'),
      `extensions degrade alone (got ${ext?.state ?? 'no row'})`,
    )
    check(rows.some(r => r.id === 'tool:search'), 'other sections stay collected (search row unaffected)')
  }

  // ── (6) vocabulary + shape totality ──────────────────────────────────────
  check(base.every(r => VOCAB.has(r.state)), 'every state is in the shared vocabulary')
  check(
    base.every(r => r.id && r.kind && r.label && r.detail && r.source && typeof r.lastCheckedAt === 'number'),
    'every record carries id/kind/label/detail/source/lastCheckedAt',
  )

  // ── (7) doctor --json embeds the same records (fresh-dist leg) ───────────
  const dist = join(REPO, 'dist', 'mercury.mjs')
  const stamp = join(REPO, 'dist', '.build-tree')
  let distFresh = false
  if (existsSync(dist) && existsSync(stamp)) {
    try {
      const idx = mkdtempSync(join(tmpdir(), 'readiness-tree-'))
      const env = { ...process.env, GIT_INDEX_FILE: join(idx, 'index') }
      execSync('git read-tree HEAD', { cwd: REPO, env, stdio: 'pipe' })
      execSync('git add -A', { cwd: REPO, env, stdio: 'pipe' })
      const tree = execSync('git write-tree', { cwd: REPO, env, stdio: 'pipe' }).toString().trim()
      rmSync(idx, { recursive: true, force: true })
      distFresh = tree === readFileSync(stamp, 'utf8').trim()
    } catch {
      distFresh = false
    }
  }
  if (!distFresh) {
    console.log('· doctor --json leg SKIPPED (dist not built from this tree — the gate prebuilds)')
  } else {
    const d = spawnSync('node', [dist, 'doctor', '--json'], {
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, MERCURY_CONFIG_DIR: home },
    })
    check(d.status === 0, `doctor --json exits 0 (${d.status})`)
    try {
      const cert = JSON.parse(d.stdout) as { verdict?: string; readiness?: Rec[] }
      check(Array.isArray(cert.readiness), 'certificate embeds readiness records')
      const dProbe = (cert.readiness ?? []).find(r => r.id === 'mcp:probe-server')
      check(dProbe?.state === 'configured', `headless run never connected ⇒ configured (got ${dProbe?.state})`)
      check((cert.readiness ?? []).every(r => VOCAB.has(r.state)), 'headless records share the vocabulary')
    } catch (e) {
      check(false, `doctor --json parse: ${String(e).slice(0, 120)}`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '✅ readiness truth GREEN' : `❌ readiness truth RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
