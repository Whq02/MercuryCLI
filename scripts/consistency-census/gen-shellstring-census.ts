#!/usr/bin/env bun
// ============================================================================
//  scripts/consistency-census/gen-shellstring-census.ts — W6-D (UN-44/49): the
//  generated fixed-tool execution census.
//
//  Sweeps script-land + src for command-STRING execution (execSync/exec with
//  interpolated strings, spawn of a shell with -c) and for hardcoded
//  interpreter/temp-root sites (/usr/bin/python3, literal /tmp, bare
//  python3), then classifies every site:
//
//    fixed-tool-argv        already executable+argv — the L16 shape (listed
//                           for coverage, no action)
//    intentional-shell      shell grammar IS the feature; the owner names the
//                           shell explicitly (bash scripts, run-suite, PTY
//                           drivers) — classified, stays
//    test-fixture           the subject under test is shell parsing — never
//                           rewritten (the brief's explicit carve-out)
//    platform-owner         a deliberately platform-specific script whose
//                           supported profile is named (POSIX pool runner,
//                           vshot POSIX engine, winreg ConPTY engine)
//    UNCLASSIFIED           new/unknown — the UN-44 ratchet fails on these
//
//  Output: scripts/consistency-census/shellstring-census.json (tracked; regenerate here).
// ============================================================================
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

interface Hit {
  file: string
  line: number
  mechanism: 'execSync-string' | 'exec-string' | 'shell-dash-c' | 'hardcoded-interpreter' | 'hardcoded-tmp'
  excerpt: string
}
const hits: Hit[] = []

const SCAN_DIRS = ['src', 'scripts']
const walk = (dir: string): void => {
  for (const name of [...readdirSync(dir)].sort()) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'receipts' || name === 'dist') continue
      walk(full)
      continue
    }
    if (!/\.(ts|tsx|mjs)$/.test(name)) continue
    const rel = relative(ROOT, full)
    if (rel.startsWith('scripts/consistency-census/gen-')) continue // the census tooling itself
    const lines = readFileSync(full, 'utf8').split('\n')
    lines.forEach((text, i) => {
      const push = (mechanism: Hit['mechanism']): void => {
        hits.push({ file: rel, line: i + 1, mechanism, excerpt: text.trim().slice(0, 140) })
      }
      // child_process string execution ONLY: standalone execSync/exec (never
      // method calls like db.exec — SQLite is not process execution).
      if (/(?<![.\w])execSync\(/.test(text)) push('execSync-string')
      else if (/(?<![.\w])exec\((`|')/.test(text)) push('exec-string')
      if (/spawnSync?\((['"`])(bash|sh|zsh|cmd|powershell)\1\s*,\s*\[\s*(['"`])-c\3/.test(text)) push('shell-dash-c')
      // Interpreter/temp-root DECISIONS: a spawn/write/root-const carrying the
      // literal — not fixture DATA paths inside test payloads.
      if (/\/usr\/bin\/python3/.test(text) && /spawn|SYS_PY|PYTHON|python3'|python3"|= '\/usr/.test(text)) {
        push('hardcoded-interpreter')
      }
      if (
        /(['"`])\/tmp\1|(['"`])\/tmp\//.test(text) &&
        /mkdtemp|mkdir|writeFile|TMP|tmpRoot|outDir|startsWith\((['"`])\/tmp/.test(text)
      ) {
        push('hardcoded-tmp')
      }
    })
  }
}
for (const d of SCAN_DIRS) walk(join(ROOT, d))

/** Classification by path rule — most specific first. Every rule names WHY. */
const RULES: Array<{ test: (f: string, mechanism: string) => boolean; cls: string; why: string }> = [
  {
    test: f => f.startsWith('scripts/verify/fast.ts') || f.startsWith('scripts/verify/prove-baseline-source.ts'),
    cls: 'fixed-tool-argv',
    why: 'converted to scripts/lib/git.ts typed argv in unison W6-A (the F1 owners)',
  },
  {
    test: f => f.startsWith('scripts/lib/git.ts'),
    cls: 'fixed-tool-argv',
    why: 'the typed executor itself',
  },
  {
    test: (f, m) => f.startsWith('scripts/ui/') && (m === 'hardcoded-interpreter' || m === 'hardcoded-tmp'),
    cls: 'platform-owner',
    why: 'POSIX capture engine surfaces — interpreter/temp owned by the capture-driver resolver (W6-C); the /tmp default is a pinned byte-identity prover expectation on POSIX',
  },
  {
    test: f => f.startsWith('scripts/winreg/'),
    cls: 'platform-owner',
    why: 'the Windows ConPTY engine — deliberately windows-only',
  },
  {
    test: f => /scripts\/.*\/(prove|repro)-[^/]*shell/i.test(f),
    cls: 'test-fixture',
    why: 'shell parsing is the subject under test',
  },
  {
    test: f => f === 'scripts/tools/prove-parity2-tier1w.ts',
    cls: 'test-fixture',
    why: 'drives Shell.exec through the REAL bash path deliberately — stdin-EOF settlement is the subject under test',
  },
  {
    test: f => f.startsWith('scripts/ide/'),
    cls: 'platform-owner',
    why: 'IDE-lane provers pin the macOS system interpreter DELIBERATELY (the pyexpat healthy-fallback class); POSIX maintainer host is their declared profile',
  },
  {
    test: f => f === 'src/services/dap/debugpyResolver.ts',
    cls: 'platform-owner',
    why: 'the documented darwin system-python fallback candidate (the pyexpat class) — a candidate list entry, not a temp/exec decision',
  },
  {
    test: f => f === 'src/memdir/promoteRungate.ts',
    cls: 'intentional-shell',
    why: 'the promote rungate runs the OPERATOR-CONFIGURED gate command line — shell grammar is the feature, the shell is named at the call',
  },
  {
    test: (f, m) => m === 'hardcoded-interpreter' && f.startsWith('scripts/'),
    cls: 'platform-owner',
    why: 'POSIX maintainer-pool prover driving the POSIX capture engine (vshot/screengrab) — the pool is a declared POSIX profile; Windows maintainers take the hosted lane (the W6-B refusal names it). The product-adjacent entrypoints (render-tui, generate-visual-baseline, doctor) route through the capture-driver resolver instead.',
  },
  {
    test: (f, m) => m === 'hardcoded-tmp' && f.startsWith('scripts/'),
    cls: 'platform-owner',
    why: 'POSIX pool prover scratch/coordination root — declared POSIX profile; render-tui\'s /tmp default is additionally a pinned byte-identity prover expectation',
  },
  {
    test: (f, m) => m === 'shell-dash-c' && f.startsWith('scripts/'),
    cls: 'intentional-shell',
    why: 'script-land shell program — the shell is named explicitly at the call',
  },
  {
    test: (f, m) => m === 'execSync-string' && f.startsWith('scripts/'),
    cls: 'intentional-shell',
    why: 'maintainer script running a named shell command line (audited: no interpolated revisions/paths reach cmd.exe — the fixed-tool sites were converted in W6-A)',
  },
  {
    test: (f, m) => m === 'execSync-string' && f.startsWith('src/'),
    cls: 'intentional-shell',
    why: 'product-side shell execution behind an explicit shell owner (BashTool/shells) — the shell IS the feature',
  },
  {
    test: (f, m) => f.startsWith('src/') && (m === 'hardcoded-tmp'),
    cls: 'platform-owner',
    why: 'POSIX-scoped runtime path behind a platform gate (audited per site in the census review)',
  },
]

const census = hits.map(h => {
  const rule = RULES.find(r => r.test(h.file, h.mechanism))
  return { ...h, cls: rule?.cls ?? 'UNCLASSIFIED', why: rule?.why ?? 'no rule — the UN-44 ratchet fails on this' }
})

const outPath = join(ROOT, 'scripts', 'consistency-census', 'shellstring-census.json')
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedBy: 'scripts/consistency-census/gen-shellstring-census.ts',
      note: 'GENERATED — regenerate, never hand-edit. UN-44/49 ratchet input.',
      sites: census,
    },
    null,
    2,
  ) + '\n',
)
const un = census.filter(c => c.cls === 'UNCLASSIFIED')
console.log(`shell-string census: ${census.length} site(s); ${un.length} unclassified`)
for (const u of un.slice(0, 40)) console.log(`  UNCLASSIFIED ${u.file}:${u.line} (${u.mechanism}) ${u.excerpt}`)
