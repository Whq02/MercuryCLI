#!/usr/bin/env bun

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

function keysNamedBy(text: string): string[] {
  if (!/settings\.json/.test(text)) return []
  const keys: string[] = []
  for (const m of text.matchAll(/\b([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+)\b/g)) {
    const key = m[1]!
    if (key.endsWith('.json') || key.endsWith('.md') || key.endsWith('.ts') || key.startsWith('settings.')) continue
    keys.push(key)
  }
  return keys
}

section('§1 the remedy reader finds the keys a remedy names, and the report source names no retired key')
{
  const source = readFileSync(join(REPO, 'src', 'utils', 'healthReport.ts'), 'utf8')
  check('a remedy that names a dotted key under settings.json yields that key', keysNamedBy('Set guardrails.allow in settings.json to permit it.').join(',') === 'guardrails.allow')
  check('a remedy that names no settings.json yields nothing', keysNamedBy('Set guardrails.allow to permit it.').length === 0)
  check('file names and the settings.* prefix are not keys', keysNamedBy('Edit settings.json (settings.local.json, docs/SETTINGS.md).').length === 0)
  check('the schema declares guardrails.allow', keyExists('guardrails.allow'))
  check('the schema declares no top-level sandbox key', !keyExists('sandbox.enabled'))
  check('no remedy in the report source names a sandbox key', !/sandbox\.enabled|guardrails\.sandbox/.test(source), source.split('\n').filter(l => /sandbox\.enabled|guardrails\.sandbox/.test(l)).join(' | '))
}

section('§2 every settings key a live certificate\'s remedies name exists in the schema')
{
  const cert = healthJson()
  check('health --json answered a certificate', cert !== null)
  const checks = (cert?.sections ?? []).flatMap(s => s.checks ?? [])
  const named: Array<{ id: string; key: string }> = []
  for (const row of checks) for (const key of keysNamedBy(`${row.fix ?? ''}`)) named.push({ id: row.id, key })
  console.log(`  remedies naming a settings key on a bare home: ${named.length === 0 ? 'none' : JSON.stringify(named)}`)
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
