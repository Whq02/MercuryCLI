#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { registerGeneratedAsset, registerOnlyRequested } from '../lib/generated-assets-map.mjs'
import { codeOnlyLines } from '../lib/codeText.ts'

const argValue = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const ROOT = argValue('--root') ?? join(import.meta.dir, '..', '..')
const ROW = {
  assets: 'scripts/consistency-census/basename-census.json',
  generator: 'bun scripts/consistency-census/gen-basename-census.ts',
  check: 'bun scripts/consistency-census/prove-basename-census.ts',
  sources: 'src/**/*.{ts,tsx,mjs} scripts/consistency-census/gen-basename-census.ts scripts/lib/codeText.ts',
}
if (registerOnlyRequested(ROW)) process.exit(0)
const REGISTERS = argValue('--root') === undefined && argValue('--out') === undefined

const OTHER_HOME = ['.cla', 'ude'].join('')
const OTHER_GUIDE = ['CLA', 'UDE.md'].join('')
const BASENAMES = [
  `'${OTHER_HOME}'`,
  `"${OTHER_HOME}"`,
  "'.mercury'",
  '".mercury"',
  `'${OTHER_GUIDE}'`,
  `"${OTHER_GUIDE}"`,
  "'MERCURY.md'",
  '"MERCURY.md"',
  "'AGENTS.md'",
  '"AGENTS.md"',
  `'${OTHER_HOME}.json'`,
  "'.mercury.json'",
] as const

interface Hit {
  file: string
  needle: string
  excerpt: string
}
const hits: Hit[] = []

const walk = (dir: string): void => {
  for (const name of [...readdirSync(dir)].sort()) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue
      walk(full)
      continue
    }
    if (!/\.(ts|tsx)$/.test(name)) continue
    const rel = relative(ROOT, full)
    const lines = codeOnlyLines(rel, readFileSync(full, 'utf8'))
    for (const text of lines) {
      const trimmed = text.trim()
      for (const needle of BASENAMES) {
        if (text.includes(needle)) {
          hits.push({ file: rel, needle: needle.replace(/['"]/g, ''), excerpt: trimmed.slice(0, 140) })
        }
      }
    }
  }
}
walk(join(ROOT, 'src'))

const RULES: Array<{ test: (f: string, needle: string, excerpt: string) => boolean; cls: string; why: string }> = [
  {
    test: (_f, needle) => needle === OTHER_GUIDE,
    cls: 'FORBIDDEN',
    why: "another tool's guide file is an ordinary file — nothing in src probes, lists or composes it",
  },
  {
    test: f => f === 'src/utils/env.ts' || f === 'src/utils/envUtils.ts',
    cls: 'owner-internal',
    why: 'the config-home monolith family — the home resolver owns the home basenames',
  },
  {
    test: f => f === 'src/utils/projectConfig.ts',
    cls: 'owner-internal',
    why: 'the project-dirs owner — the ONE place project basenames join paths',
  },
  {
    test: f => f.startsWith('src/services/instructions/'),
    cls: 'guide-probe',
    why: 'the instruction engine: the native convention names MERCURY.md, the shared convention AGENTS.md (composed when no MERCURY.md stands), the capture writer and the effective-size measure name the entry files',
  },
  {
    test: (f, _n, excerpt) => f === 'src/services/concourse/coordinatorTools.ts' && excerpt.includes('MARKS'),
    cls: 'guide-probe',
    why: "the ground law's folder memory: MERCURY.md probed as a worked-here-before mark; the home DIR names ride PROJECT_CONFIG_DIR_NAMES",
  },
  {
    test: (_f, _n, excerpt) => /getMercuryHome|configHome|homeDir/.test(excerpt),
    cls: 'owner-internal',
    why: 'reads THROUGH the home owner (the basename appears beside the owner call, not as an independent join)',
  },
  {
    test: f => /test|fixture|probe/i.test(f),
    cls: 'test-fixture',
    why: 'src-embedded fixture/probe — the basename is the subject',
  },
  {
    test: (_f, _n, excerpt) => /getManagedFilePath\(\)/.test(excerpt),
    cls: 'baked-mirror',
    why: 'the MANAGED estate projection (the managed root mirrors the canonical .mercury layout)',
  },
  {
    test: (_f, _n, excerpt) => /homedir\(\)/.test(excerpt),
    cls: 'peer-boundary',
    why: "identity checks against another tool's home directory (doctor · keychain scoping) — a deliberate recognition, never a store join",
  },
  {
    test: (_f, _n, excerpt) => excerpt.includes("'.mercury'") && excerpt.includes(`'${OTHER_HOME}'`),
    cls: 'peer-boundary',
    why: "Mercury's home and another tool's named TOGETHER as protections (walk-skips, sandbox deny-writes, the tree digest's exclusions)",
  },
  {
    test: f =>
      f === 'src/utils/accounts/accountIdentity.ts' ||
      f === 'src/utils/accounts/scopeScan.ts' ||
      f === 'src/utils/auth.ts' ||
      f === 'src/daemon/saturnAccount.ts' ||
      f === 'src/components/mercury-ui/parity/AccountView.tsx',
    cls: 'peer-boundary',
    why: "the account estate's peer table: another tool's home resolved as Mercury's config home is recognised and never signed in, billed or written",
  },
  {
    test: f => f === 'src/entrypoints/cli.tsx',
    cls: 'owner-internal',
    why: 'the env-less compile-cache fallback mirrors the three-rung home ladder (projectdirs prover pins it)',
  },
  {
    test: (f, n) => f === 'src/utils/cockpit/repoSurfaceMap.ts' && (n === 'MERCURY.md' || n === 'AGENTS.md'),
    cls: 'guide-probe',
    why: 'the surface map lists the guides present at the root by name — existence only, never a content load',
  },
  {
    test: (f, n) => f === 'src/utils/projectStoreAdoption.ts' && n === OTHER_HOME,
    cls: 'peer-boundary',
    why: "the alias-refusal guard names the other tool's dir it refuses to write through — a boundary check, never a read or write path",
  },
  {
    test: f => f === 'src/utils/permissions/filesystem.ts',
    cls: 'peer-boundary',
    why: "the permission estate names other tools' executable config as protected paths (edits ask first) beside Mercury's own",
  },
  {
    test: f => f === 'src/utils/markdownConfigLoader.ts' || f === 'src/skills/loadSkillsDir.ts' || f === 'src/utils/config/derived.ts',
    cls: 'guide-probe',
    why: 'the markdown/skills/rules discovery surfaces name the .mercury home and the user guide file beside the owner calls',
  },
  {
    test: (f, needle) => (needle === 'MERCURY.md' || needle === 'AGENTS.md') && f.startsWith('src/services/projectIntel/'),
    cls: 'guide-probe',
    why: 'the project intel facts name the guides Mercury loads — existence only, never a content load',
  },
  {
    test: (f, needle) => (needle === 'MERCURY.md' || needle === 'AGENTS.md') && f === 'src/projectOnboardingState.ts',
    cls: 'guide-probe',
    why: 'the /init step completes on the guide the profile composes (MERCURY.md, or AGENTS.md)',
  },
]

const classified = hits.map(h => {
  for (const r of RULES) {
    if (r.test(h.file, h.needle, h.excerpt)) return { ...h, cls: r.cls, why: r.why }
  }
  if (h.needle === OTHER_HOME && /join\(/.test(h.excerpt)) {
    return { ...h, cls: 'FORBIDDEN', why: "a project join of another tool's home outside the owners and the boundary — route through projectConfig" }
  }
  return { ...h, cls: 'UNCLASSIFIED', why: 'new/unknown site — classify or fix' }
})

const counts: Record<string, number> = {}
for (const c of classified) counts[c.cls] = (counts[c.cls] ?? 0) + 1

const out = {
  generatedBy: 'scripts/consistency-census/gen-basename-census.ts',
  needles: BASENAMES.map(n => n.replace(/['"]/g, '')).filter((v, i, a) => a.indexOf(v) === i),
  counts,
  sites: classified.sort((a, b) => a.file.localeCompare(b.file)),
}
const outPath = argValue('--out') ?? join(ROOT, 'scripts/consistency-census/basename-census.json')
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
if (REGISTERS) registerGeneratedAsset(ROW)
console.log(
  `basename census: ${classified.length} site(s) across ${new Set(classified.map(c => c.file)).size} file(s); ` +
    Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' '),
)
if ((counts['FORBIDDEN'] ?? 0) > 0 || (counts['UNCLASSIFIED'] ?? 0) > 0) process.exitCode = 1
