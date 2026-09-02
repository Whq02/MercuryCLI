#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-project-key-canonical.ts
//  PROOF: (WP-4) — the project KEY canonicalizes at the ONE
//  shared derivation (getProjectDir), so the write side (raw cwd) and the
//  read side (canonicalized cwd) can never fragment a project's sessions:
//    - a symlinked spelling (macOS /tmp → /private/tmp class) keys
//      identically to the real path;
//    - NFC normalization applies (decomposed Unicode spellings unify);
//    - sessions already stored under a RAW-spelling key are honored in
//      place (old-path honor — no orphaned histories).
//  LIVE: sessionStoragePortable is pure Node (the portability contract).
// ============================================================================

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// Proof hygiene (.claude/rules/proof-hygiene.md): pin the config home to a
// scratch root BEFORE the imports — the old-path-honor leg creates a legacy
// project dir, and that write must never land in the operator's real home
// (getMercuryHome memoizes at first call).
const CONFIG_SCRATCH = mkdtempSync(join(tmpdir(), 'wp4-home-'))
process.env.MERCURY_CONFIG_DIR = CONFIG_SCRATCH

const ROOT = join(import.meta.dir, '..', '..')
const { getProjectDir } = await import(join(ROOT, 'src/utils/sessionStoragePortable.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' project-key canonicalization — proof')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'wp4-'))
try {
  const real = join(scratch, 'real-project')
  mkdirSync(real)
  const link = join(scratch, 'link-project')
  symlinkSync(real, link)

  const keyReal = getProjectDir(real)
  const keyLink = getProjectDir(link)
  check('symlinked spelling keys to the SAME project dir as the real path', keyReal === keyLink, `real=${basename(keyReal)} link=${basename(keyLink)}`)

  // Old-path honor: a raw-keyed dir that already exists wins over a fresh
  // canonical key — pre-existing session histories stay reachable.
  const real2 = join(scratch, 'legacy-project')
  mkdirSync(real2)
  const link2 = join(scratch, 'legacy-link')
  symlinkSync(real2, link2)
  const rawKeyed = getProjectDir(link2 + '-prime-raw') // just to import sanitize shape
  void rawKeyed
  const { sanitizePath } = await import(join(ROOT, 'src/utils/sessionStoragePortable.ts'))
  const { getMercuryHome } = await import(join(ROOT, 'src/utils/envUtils.ts'))
  const projectsDir = join(getMercuryHome(), 'projects')
  const legacyDir = join(projectsDir, sanitizePath(link2))
  mkdirSync(legacyDir, { recursive: true })
  // A legacy dir adopts only when it IS a store (holds a transcript) — bare
  // directories are memdir estates, not stores (FC-007).
  writeFileSync(join(legacyDir, '00000000-0000-0000-0000-000000000000.jsonl'), '')
  try {
    check('existing RAW-keyed session dir is honored in place', getProjectDir(link2) === legacyDir, getProjectDir(link2))
  } finally {
    rmSync(legacyDir, { recursive: true, force: true })
  }

  // NFC: decomposed and precomposed spellings unify (non-existent path —
  // the fallback arm normalizes without realpath).
  const nfd = join(scratch, 'cafe\u0301-missing')
  const nfc = join(scratch, 'caf\u00e9-missing')
  check('decomposed Unicode spelling keys like the precomposed form', nfd !== nfc && getProjectDir(nfd) === getProjectDir(nfc))

  // ── 5.2 (H-15): the injective slug + the adoption ladder ──────────────────
  {
    const { projectSlug, shortProjectHash } = await import(join(ROOT, 'src/utils/sessionStoragePortable.ts'))
    // The field collision class: distinct raw paths whose SANITIZED spellings
    // collide ('mercury-site' vs 'mercury_site') get DISTINCT slugs now.
    const a = join(scratch, 'mercury-site')
    const b = join(scratch, 'mercury_site')
    check(
      'H-15: sanitize-collapsed siblings mint DISTINCT slugs (short content hash — injective by construction)',
      sanitizePath(a) === sanitizePath(b) && projectSlug(a) !== projectSlug(b),
      `sanitized=${sanitizePath(a)} slugs=${projectSlug(a)} vs ${projectSlug(b)}`,
    )
    check(
      'H-15: the hash is cross-runtime stable (node:crypto sha256, 8 hex chars — never Bun.hash)',
      /^[0-9a-f]{8}$/.test(shortProjectHash(a)),
    )
    // Adoption: a NEW project (no dir anywhere) creates under the hashed
    // slug; an EXISTING legacy hashless store is honored in place forever.
    const fresh = join(scratch, 'h15-fresh-project')
    check(
      'H-15: a fresh project keys to the HASHED slug (creation default)',
      getProjectDir(fresh).endsWith(projectSlug(fresh)),
      getProjectDir(fresh),
    )
    const legacyProj = join(scratch, 'h15-legacy-project')
    const legacyStore = join(projectsDir, sanitizePath(legacyProj))
    mkdirSync(legacyStore, { recursive: true })
    // Same store-fact seed as above (FC-007): adoption needs a transcript.
    writeFileSync(join(legacyStore, '00000000-0000-0000-0000-000000000001.jsonl'), '')
    try {
      check(
        'H-15: an existing legacy hashless store is ADOPTED in place (no migration, no fragmentation)',
        getProjectDir(legacyProj) === legacyStore,
        getProjectDir(legacyProj),
      )
    } finally {
      rmSync(legacyStore, { recursive: true, force: true })
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(CONFIG_SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL PROJECT-KEY PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
