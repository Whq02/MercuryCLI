#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { codeOnlyLines } from '../lib/codeText.ts'

const argValue = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const ROOT = argValue('--root') ?? join(import.meta.dir, '..', '..')

const BASENAMES = [
  "'.claude'",
  '".claude"',
  "'.mercury'",
  '".mercury"',
  "'CLAUDE.md'",
  '"CLAUDE.md"',
  "'MERCURY.md'",
  '"MERCURY.md"',
  "'.claude.json'",
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
    cls: 'compat-boundary',
    why: 'instruction discovery: .mercury native · .claude compat input (MERCURY.md law)',
  },
  {
    test: (f, _n, excerpt) => f === 'src/services/concourse/coordinatorTools.ts' && excerpt.includes('MARKS'),
    cls: 'compat-boundary',
    why: 'the ground law’s folder memory: guide files (MERCURY.md native, CLAUDE.md compat input) probed as worked-here-before markers; the home DIR names ride PROJECT_CONFIG_DIR_NAMES',
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
    why: 'the MANAGED estate projection (a compat mirror beside the canonical .mercury home)',
  },
  {
    test: (_f, _n, excerpt) => /homedir\(\)/.test(excerpt),
    cls: 'compat-boundary',
    why: "identity checks against another tool's external ~/.claude home (doctor · keychain scoping) — a deliberate interop identity, never a store join",
  },
  {
    test: (_f, _n, excerpt) => excerpt.includes("'.mercury'") && excerpt.includes("'.claude'"),
    cls: 'compat-boundary',
    why: 'pair-symmetric family handling — native + compat spellings named TOGETHER deliberately (walk-skips, sandbox profiles, worktree resets, scope scans)',
  },
  {
    test: f =>
      f === 'src/utils/accounts/accountIdentity.ts' ||
      f === 'src/utils/accounts/scopeScan.ts' ||
      f === 'src/utils/auth.ts' ||
      f === 'src/daemon/saturnAccount.ts' ||
      f === 'src/components/mercury-ui/parity/AccountView.tsx',
    cls: 'compat-boundary',
    why: "the account estate reads a scope's identity from the scope's own config file and adopts an identity snapshot left in an external .claude.json file once (Saturn's account facts read the same scope identity)",
  },
  {
    test: f => f === 'src/entrypoints/cli.tsx',
    cls: 'owner-internal',
    why: 'the env-less compile-cache fallback mirrors the three-rung home ladder (projectdirs prover pins it)',
  },
  {
    test: (f, n) =>
      (f === 'src/substrate/themis/integrity.ts' || f === 'src/substrate/themis/boot.ts') &&
      n === 'MERCURY.md',
    cls: 'owner-internal',
    why: "the enroll list NAMES Mercury's own committed doc — integrity/drift subject, not a home join",
  },
  {
    test: (f, n) => f === 'src/utils/cockpit/repoSurfaceMap.ts' && (n === 'MERCURY.md' || n === 'AGENTS.md'),
    cls: 'owner-internal',
    why: 'the orientation-doc presence probe NAMES the native and neutral guides beside the compat one — existence only, never a content load',
  },
  {
    test: (f, n) => f === 'src/utils/projectStoreAdoption.ts' && n === '.claude',
    cls: 'compat-boundary',
    why: 'the D11 alias-refusal guard names the external dir it refuses to write through — a boundary check, never a read or write path',
  },
  {
    test: f => f === 'src/utils/ide.ts',
    cls: 'compat-boundary',
    why: 'external-harness IDE lockfile discovery (~/.claude/ide is the compat IDE contract)',
  },
  {
    test: f => f === 'src/utils/permissions/filesystem.ts',
    cls: 'compat-boundary',
    why: 'the permission estate names compat stores DELIBERATELY (skill discovery dirs + .claude.json deny surfaces)',
  },
  {
    test: f => f === 'src/utils/markdownConfigLoader.ts' || f === 'src/skills/loadSkillsDir.ts' || f === 'src/utils/config/derived.ts',
    cls: 'compat-boundary',
    why: 'native-first/compat-second pairing at the markdown/skills/rules discovery surfaces (MERCURY.md law: .mercury native · .claude compat input)',
  },
  {
    test: (f, needle) => needle === 'MERCURY.md' && f.startsWith('src/services/projectIntel/'),
    cls: 'owner-internal',
    why: "the project intel facts name Mercury's own instruction file — existence only, never a content load",
  },
  {
    test: (f, needle) =>
      needle === 'CLAUDE.md' &&
      (f.startsWith('src/services/projectIntel/') ||
        f === 'src/components/memory/MemoryFileSelector.tsx' ||
        f === 'src/utils/cockpit/repoSurfaceMap.ts' ||
        f.startsWith('src/substrate/themis/')),
    cls: 'compat-boundary',
    why: 'CLAUDE.md probed/listed as the compat instruction INPUT at documented discovery/paridade surfaces',
  },
  {
    test: (f, needle) =>
      needle === 'MERCURY.md' && f === 'src/projectOnboardingState.ts',
    cls: 'compat-boundary',
    why: "MERCURY.md probed as the /init completion signal — onboarding tracks the file /init actually creates (the native project guide)",
  },
]

const classified = hits.map(h => {
  for (const r of RULES) {
    if (r.test(h.file, h.needle, h.excerpt)) return { ...h, cls: r.cls, why: r.why }
  }
  if (h.needle === '.claude' && /join\(/.test(h.excerpt)) {
    return { ...h, cls: 'FORBIDDEN', why: "project '.claude' join outside the owners/compat boundary — route through projectConfig" }
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
console.log(
  `basename census: ${classified.length} site(s) across ${new Set(classified.map(c => c.file)).size} file(s); ` +
    Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' '),
)
if ((counts['FORBIDDEN'] ?? 0) > 0 || (counts['UNCLASSIFIED'] ?? 0) > 0) process.exitCode = 1
