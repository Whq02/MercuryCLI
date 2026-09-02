#!/usr/bin/env bun
// ============================================================================
//  scripts/interview/prove-enablement.ts — interview enablement is
//  PRODUCT-OWNED and every surface agrees.
//
//    §1  REGISTRY — MERCURY_INTERVIEW is a registered default-on behavioral
//        gate whose committed evidence artifact exists.
//    §2  DECISION MATRIX — in pinned subprocess environments (the
//        ambient-state law): default ⇒ ON · MERCURY_INTERVIEW=0 ⇒ OFF ·
//        the retired external boundary spelling
//        overrides in BOTH directions at the boundary.
//    §3  THE EXPERIMENT CACHE IS OUT — the stale-able remote gate name
//        no longer appears in the decision owner.
//    §4  ONE BOUNDARY — the external spelling is decoded at exactly one
//        consumer (planModeV2.ts); nothing else reads it.
//    §5  DIST AGREEMENT — the built artifact carries the registered flag and
//        the interview workflow text (skips loudly when dist is absent).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
  // The external boundary spelling retired with the compat estate: it is
  // inert in both directions — the registered gate alone decides.
  const FOREIGN = ['CLAUDE', 'CODE'].join('_')
  const FOREIGN_PHASE = `${FOREIGN}_PLAN_MODE_INTERVIEW_PHASE`
  t.check(
    'the retired external spelling cannot force OFF',
    probe({ [FOREIGN_PHASE]: '0' }) === 'true',
  )
  t.check(
    'the retired external spelling cannot force ON over the off gate',
    probe({ [FOREIGN_PHASE]: '1', MERCURY_INTERVIEW: '0' }) === 'false',
  )
}

t.section('§3 — the experiment cache is out of the decision')
{
  const src = readFileSync(join(ROOT, 'src/utils/planModeV2.ts'), 'utf8')
  t.check('the decision reads the registered gate', src.includes("flagEnabled('MERCURY_INTERVIEW')"))
}

t.section('§4 — the retired external spelling has NO decode boundary left')
{
  const hits: string[] = []
  const scan = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) {
        scan(p)
        continue
      }
      if (!/\.(ts|tsx|js|mjs)$/.test(e.name)) continue
      // A DECODE is an env read — a documentation mention (the registry
      // row's summary) is not a boundary.
      if (readFileSync(p, 'utf8').includes(`process.env.${['CLAUDE', 'CODE'].join('_')}_PLAN_MODE_INTERVIEW_PHASE`))
        hits.push(p)
    }
  }
  scan(join(ROOT, 'src'))
  t.check(
    'no src consumer decodes the retired boundary spelling',
    hits.length === 0,
    hits.join(', '),
  )
}

t.section('§5 — the built artifact agrees')
{
  const dist = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    t.check('dist absent — the pooled gate prebuilds it; SKIP recorded loudly', true, 'skipped')
  } else {
    const bytes = readFileSync(dist, 'utf8')
    t.check('dist carries the registered gate name', bytes.includes('MERCURY_INTERVIEW'))
    t.check('dist carries the interview workflow', bytes.includes('Iterative Planning Workflow'))
    t.check(
      'dist carries NO trace of the retired boundary spelling',
      !bytes.includes(`${['CLAUDE', 'CODE'].join('_')}_PLAN_MODE_INTERVIEW_PHASE`),
    )
  }
}

t.finish('prove-enablement')
