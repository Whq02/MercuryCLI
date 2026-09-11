#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const t = checker()

t.section('§1 — the counter law on the real streaming surface')
{
  const out = join(mkdtempSync(join(tmpdir(), 'rv-b3-')), 'flux.json')
  const r = spawnSync(
    process.env.BUN ?? `${homedir()}/.bun/bin/bun`,
    ['run', 'scripts/streaming/bench-stream-fluidity.ts', 'mixed-tools'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 240_000,
      env: { ...process.env, MEASURE_JSON: out },
    },
  )
  t.check('the flux harness ran (real Ink render, production fan-out)', r.status === 0, `exit=${r.status}`)
  let scene: { rootCommits?: number; tailCommits?: number; deltas?: number } | undefined
  try {
    const results = JSON.parse(readFileSync(out, 'utf8')) as Array<{
      scene: string
      rootCommits: number
      tailCommits: number
      deltas: number
    }>
    scene = results.find(s => s.scene === 'mixed-tools')
  } catch {
  }
  t.check('the mixed-tools counters landed', scene !== undefined)
  t.check(
    'ROOT re-renders stay a small constant (≤ 8) — no whole-transcript invalidation',
    (scene?.rootCommits ?? 99) <= 8,
    `rootCommits=${scene?.rootCommits}`,
  )
  t.check(
    'tail deltas DOMINATE (≥ 5× root) — streaming replaces the one changed card',
    (scene?.tailCommits ?? 0) >= 5 * (scene?.rootCommits ?? 99),
    `tail=${scene?.tailCommits} root=${scene?.rootCommits}`,
  )
}

t.section('§2 — identity + the state grammar')
{
  const glyphs = readFileSync('src/components/mercury-ui/toolGlyphs.ts', 'utf8')
  const { getAllBaseTools } = await import('../../src/tools.ts')
  const { TOOL_FAMILY_BY_NAME } = await import('../../src/components/mercury-ui/toolGlyphs.ts')
  const live = getAllBaseTools().map(tool => tool.name).filter(name => name !== 'TestingPermission')
  const unclassified = live.filter(name => TOOL_FAMILY_BY_NAME[name] === undefined)
  t.check(
    'families bind to the REAL tool registry (no filename conventions, no quiet defaults)',
    glyphs.includes('export const TOOL_FAMILY_BY_NAME: Record<string, ToolFamily>') && live.length > 40 && unclassified.length === 0,
    unclassified.join(', ') || `${live.length} registered, every one authored`,
  )
  const grammar = readFileSync('src/components/mercury-ui/toolCardGrammar.ts', 'utf8')
  for (const state of ['queued', 'running', 'waiting', 'succeeded']) {
    t.check(`the ONE state grammar carries '${state}'`, grammar.includes(`${state}:`))
  }
}

t.section('§3 — the honest fallback + the parity floor')
{
  const glyphs = readFileSync('src/components/mercury-ui/toolGlyphs.ts', 'utf8')
  t.check(
    "unknown/integration families wear the polished 'external' identity",
    /external: \{ glyph: '▷', fallback: 'ex'/.test(glyphs),
  )
  t.check(
    'every family carries an ASCII fallback column (the PS 5.1 / monochrome floor)',
    (glyphs.match(/fallback: '/g) ?? []).length >= 8,
  )
}

t.finish('prove-b3-cards')
