#!/usr/bin/env bun
// gate-watch: src/utils/healthReport.ts scripts/settings/settings-schema.json
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

type SchemaNode = { properties?: Record<string, SchemaNode>; additionalProperties?: unknown; items?: SchemaNode }
const schema = JSON.parse(readFileSync(join(REPO, 'scripts', 'settings', 'settings-schema.json'), 'utf8')) as SchemaNode

function keyExists(path: string): boolean {
  let node: SchemaNode | undefined = schema
  for (const part of path.split('.')) {
    if (node === undefined) return false
    const next: SchemaNode | undefined = node.properties?.[part]
    if (next === undefined) {
      const extra = node.additionalProperties
      return extra === true || (typeof extra === 'object' && extra !== null && Object.keys(extra).length > 0)
    }
    node = next
  }
  return true
}

const scratchHome = mkdtempSync(join(tmpdir(), 'remedy-keys-home-'))
mkdirSync(join(scratchHome, '.mercury'), { recursive: true })

function healthJson(): { sections?: Array<{ checks?: Array<{ id: string; fix?: string; detail?: string; evidence?: string }> }> } | null {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MERCURY_CONFIG_DIR: join(scratchHome, '.mercury'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: 'fixture-anthropic-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    BROWSER: '/usr/bin/true',
  }
  try {
    return JSON.parse(execFileSync('node', [BIN, 'health', '--json'], { cwd: scratchHome, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })) as ReturnType<typeof healthJson>
  } catch (e) {
    const err = e as { stdout?: string }
    try {
      return JSON.parse(err.stdout ?? '') as ReturnType<typeof healthJson>
    } catch {
      return null
    }
  }
}

section('§1 the sandbox row names a key the settings schema declares')
{
  const source = readFileSync(join(REPO, 'src', 'utils', 'healthReport.ts'), 'utf8')
  check('the schema declares guardrails.sandbox.enabled', keyExists('guardrails.sandbox.enabled'))
  check('…and declares no top-level sandbox key (the old remedy named one the validator rejects)', !keyExists('sandbox.enabled'))
  check('the off-row remedy names guardrails.sandbox.enabled', source.includes("Set guardrails.sandbox.enabled: true in settings.json"), source.split('\n').filter(l => l.includes('sandbox.enabled')).join(' | '))
  check('the unavailable-row remedy names guardrails.sandbox.enabled', source.includes('unset guardrails.sandbox.enabled if intentional'), source.split('\n').filter(l => l.includes('sandbox.enabled')).join(' | '))
  check('no remedy in the report source names a bare sandbox.enabled', !/[^.]sandbox\.enabled/.test(source.replace(/guardrails\.sandbox\.enabled/g, '')), source.split('\n').filter(l => /[^.]sandbox\.enabled/.test(l)).join(' | '))
}

section('§2 every settings key a live certificate\'s remedies name exists in the schema')
{
  const cert = healthJson()
  check('health --json answered a certificate', cert !== null)
  const checks = (cert?.sections ?? []).flatMap(s => s.checks ?? [])
  const named: Array<{ id: string; key: string }> = []
  for (const row of checks) {
    const text = `${row.fix ?? ''}`
    if (!/settings\.json/.test(text)) continue
    for (const m of text.matchAll(/\b([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+)\b/g)) {
      const key = m[1]!
      if (key.endsWith('.json') || key.endsWith('.md') || key.endsWith('.ts') || key.startsWith('settings.')) continue
      named.push({ id: row.id, key })
    }
  }
  check('at least one remedy names a settings key (the sandbox row on a bare home)', named.some(n => n.id === 'sandbox'), JSON.stringify(named))
  const missing = named.filter(n => !keyExists(n.key))
  check('every key a remedy tells the user to set exists in the schema', missing.length === 0, JSON.stringify(missing))
}

rmSync(scratchHome, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-remedy-keys-exist — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-remedy-keys-exist — all checks pass')
process.exit(0)
