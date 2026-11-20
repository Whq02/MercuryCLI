#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runIsolated(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn29-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    if (res.status !== 0) throw new Error(`isolated check failed (rc ${res.status}): ${(res.stderr || res.stdout).slice(-1200)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('1. src/utils/capability/manifest.ts — throwing isEnabled reads unavailable')
{
  const r = runIsolated(`
    const { compileToolCapabilityCard } = await import(SRC + '/utils/capability/manifest.ts')
    const base = {
      name: 'ProbeTool',
      capability: {
        class: 'observation',
        units: ['source-reading'],
        latency: 'fast',
        cancellation: 'not-applicable',
        intents: ['inspect state'],
      },
    }
    out.throwing = compileToolCapabilityCard({ ...base, isEnabled: () => { throw new Error('probe broke') } })
    out.enabled = compileToolCapabilityCard({ ...base, isEnabled: () => true })
    out.disabled = compileToolCapabilityCard({ ...base, isEnabled: () => false })
  `)
  const throwing = String(r.throwing ?? '')
  const enabled = String(r.enabled ?? '')
  const disabled = String(r.disabled ?? '')
  check(
    'manifest: throwing isEnabled marks capability card unavailable',
    throwing.includes('· unavailable]') && !throwing.includes('· available]'),
    throwing,
  )
  check(
    'manifest: control enabled and disabled cards unchanged',
    enabled.includes('· available]') && disabled.includes('· unavailable]'),
    `${enabled} | ${disabled}`,
  )
}

void skip
void POSIX_MODES

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
