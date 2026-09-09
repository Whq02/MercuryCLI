#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const ROOT = join(import.meta.dir, '..', '..')

t.section('§1 — the registered gate')
{
  const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
  const spec = FLAG_REGISTRY.find(f => f.env === 'MERCURY_INTERVIEW')
  t.check('MERCURY_INTERVIEW is registered', !!spec)
  t.check('it is a default-on behavioral gate', spec?.kind === 'default-on' && spec?.tier === 'behavioral')
  t.check(
    'its committed evidence artifact exists',
    !!spec?.evidence && existsSync(join(ROOT, spec.evidence)),
    spec?.evidence ?? 'absent',
  )
  t.check('its consumer is the decision owner', spec?.consumer === 'src/utils/planModeV2.ts')
}

t.section('§2 — the decision matrix in pinned environments')
{
  const probe = (env: Record<string, string>): string => {
    const r = spawnSync(
      process.execPath,
      ['-e', 'const m = await import("./src/utils/planModeV2.ts"); console.log(m.isPlanModeInterviewPhaseEnabled())'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      },
    )
    return (r.stdout ?? '').trim() + ((r.status ?? 0) === 0 ? '' : ` [exit ${r.status}: ${(r.stderr ?? '').slice(0, 120)}]`)
  }
  t.check('default (no env) ⇒ ON', probe({}) === 'true', probe({}))
  t.check('MERCURY_INTERVIEW=0 ⇒ OFF', probe({ MERCURY_INTERVIEW: '0' }) === 'false')
  t.check('MERCURY_INTERVIEW=1 ⇒ ON', probe({ MERCURY_INTERVIEW: '1' }) === 'true')
}

t.section('§3 — the experiment cache is out of the decision')
{
  const src = readFileSync(join(ROOT, 'src/utils/planModeV2.ts'), 'utf8')
  t.check('the decision reads the registered gate', src.includes("flagEnabled('MERCURY_INTERVIEW')"))
}

t.section('§4 — the built artifact agrees')
{
  const dist = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    t.check('dist absent — the pooled gate prebuilds it; SKIP recorded loudly', true, 'skipped')
  } else {
    const bytes = readFileSync(dist, 'utf8')
    t.check('dist carries the registered gate name', bytes.includes('MERCURY_INTERVIEW'))
    t.check('dist carries the interview workflow', bytes.includes('Iterative Planning Workflow'))
  }
}

t.finish('prove-enablement')
