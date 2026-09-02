#!/usr/bin/env bun
// gen-flag-table — render the flag registry (src/substrate/flagRegistry.ts) as a
// readable table for LOCAL INSPECTION. The registry source is the truth; the
// rendered table is untracked derived output (generate → read → never commit).
// Usage: bun run scripts/substrate/gen-flag-table.ts [--check]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FLAG_REGISTRY, type FlagSpec } from '../../src/substrate/flagRegistry.ts'

const OUT_DIR = join(import.meta.dir, '.out')
const DOC = join(OUT_DIR, 'FLAG-REGISTRY.md')

function section(title: string, note: string, rows: FlagSpec[]): string {
  if (rows.length === 0) return ''
  const gateSection = rows.some(f => f.tier !== undefined)
  const body = rows
    .map(f =>
      gateSection
        ? `| \`${f.env}\` | ${f.tier ?? '—'} | ${f.summary}${f.evidence ? ` · evidence: \`${f.evidence}\`` : ''} | ${f.off} | \`${f.consumer}\` |`
        : `| \`${f.env}\` | ${f.summary} | ${f.off} | \`${f.consumer}\` |`,
    )
    .join('\n')
  const header = gateSection
    ? `| Flag | Tier | What it gates | OFF / unset means | Primary consumer |\n|---|---|---|---|---|`
    : `| Flag | What it gates | OFF / unset means | Primary consumer |\n|---|---|---|---|`
  return `\n## ${title}\n\n${note}\n\n${header}\n${body}\n`
}

const LADDER_LEGEND = `
## The graduation ladder (tiers on gate flags)

A gate flag's **tier** states the evidence bar a DEFAULT-FLIP must clear — enforced by
\`prove-flag-registry.ts\`, not prose:

| Tier | Meaning | Flip bar |
|---|---|---|
| \`display\` | presentation only (chip, rail, banner) | proof green + render-verify @80/120 |
| \`additive\` | records/preserves MORE; never changes a decision, a model-visible prompt, or what gets refused (worst case = status quo). Includes flags whose behavioral consent lives at the CALL SITE (the flag is only the kill). | proof green + a written failure-mode note (the verbatim-tail precedent) |
| \`behavioral\` | changes model-visible prompts, routing, thresholds, or what gets stored/refused | a NUMBER (held-out A/B, replay benchmark, or an executable proof of the policy) committed and named in \`evidence\` — a default-ON behavioral row without an existing evidence file FAILS the registry proof (the party-flip precedent, generalized) |
| \`security\` | permission/trust posture | never auto-flipped: explicit operator decision + threat-model note |
| \`infra\` | plumbing: capability enables, role markers, engage keys | not a graduation subject |
`

const byKind = (k: FlagSpec['kind']) =>
  FLAG_REGISTRY.filter(f => f.kind === k).slice().sort((a, b) => a.env.localeCompare(b.env))

const doc = `# Flag Registry (GENERATED — do not hand-edit)

> Derived from \`src/substrate/flagRegistry.ts\` by \`scripts/substrate/gen-flag-table.ts\`.
> UNTRACKED inspection output — the registry source is the truth
> (\`prove-flag-registry.ts\` gates the registry against the source's actual env
> reads). ${FLAG_REGISTRY.length} flags. THIS render is complete and machine-honest.
>
> **Namespace:** every flag is spelled \`MERCURY_*\`, and the registry's ONE
> bounded reader (\`flagEnv\`) reads exactly that spelling.
${LADDER_LEGEND}${section(
  'Default-ON (opt out with `=0`)',
  'Default-ON on a stamped build; `=0` disables. OFF ⇒ the documented contract (usually byte-identical).',
  byKind('default-on'),
)}${section(
  'Opt-in (default-OFF, arm with `=1`)',
  'Default-OFF everywhere; `=1` on a stamped build enables.',
  byKind('opt-in'),
)}${section(
  'Value flags (carry a value, not a boolean)',
  'Read at their consumer (model ids, intervals, paths, tuning).',
  byKind('value'),
)}${section(
  'Mixed-polarity (deliberately dual-form at distinct sites)',
  'Read with more than one pattern on purpose — see each consumer.',
  byKind('mixed'),
)}`

mkdirSync(OUT_DIR, { recursive: true })
if (process.argv.includes('--check')) {
  const current = (() => {
    try {
      return readFileSync(DOC, 'utf8')
    } catch {
      return ''
    }
  })()
  if (current !== doc) {
    console.error('the rendered flag table is STALE — regenerate: bun run scripts/substrate/gen-flag-table.ts')
    process.exit(1)
  }
  console.log('rendered flag table in sync')
} else {
  writeFileSync(DOC, doc)
  console.log(`wrote scripts/substrate/.out/FLAG-REGISTRY.md (${FLAG_REGISTRY.length} flags)`)
}
