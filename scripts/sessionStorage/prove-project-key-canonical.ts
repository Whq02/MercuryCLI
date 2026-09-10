#!/usr/bin/env bun

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

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

  const real2 = join(scratch, 'legacy-project')
  mkdirSync(real2)
  const link2 = join(scratch, 'legacy-link')
  symlinkSync(real2, link2)
  const rawKeyed = getProjectDir(link2 + '-prime-raw')
  void rawKeyed
  const { sanitizePath } = await import(join(ROOT, 'src/utils/sessionStoragePortable.ts'))
  const { getMercuryHome } = await import(join(ROOT, 'src/utils/envUtils.ts'))
  const projectsDir = join(getMercuryHome(), 'projects')
  const legacyDir = join(projectsDir, sanitizePath(link2))
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, '00000000-0000-0000-0000-000000000000.jsonl'), '')
  try {
    check('existing RAW-keyed session dir is honored in place', getProjectDir(link2) === legacyDir, getProjectDir(link2))
  } finally {
    rmSync(legacyDir, { recursive: true, force: true })
  }

  const nfd = join(scratch, 'cafe\u0301-missing')
  const nfc = join(scratch, 'caf\u00e9-missing')
  check('decomposed Unicode spelling keys like the precomposed form', nfd !== nfc && getProjectDir(nfd) === getProjectDir(nfc))

  {
    const { projectSlug, shortProjectHash } = await import(join(ROOT, 'src/utils/sessionStoragePortable.ts'))
    const a = join(scratch, 'mercury-site')
    const b = join(scratch, 'mercury_site')
    check(
      'H-15: sanitize-collapsed siblings mint DISTINCT slugs (the short content hash separates THIS collision pair; 8 hex chars is not global injectivity)',
      sanitizePath(a) === sanitizePath(b) && projectSlug(a) !== projectSlug(b),
      `sanitized=${sanitizePath(a)} slugs=${projectSlug(a)} vs ${projectSlug(b)}`,
    )
    check(
      'H-15: the slug is the sanitized spelling, a hyphen, then the 8-hex hash of the SAME canonical string',
      projectSlug(a) === `${sanitizePath(a)}-${shortProjectHash(a)}` && /^[0-9a-f]{8}$/.test(shortProjectHash(a)),
      projectSlug(a),
    )
    check(
      'H-15: the hash is a known sha256 prefix (reference value computed outside this runtime): sha256("/w/mercury-site")[0..8] = ff341ac9',
      shortProjectHash('/w/mercury-site') === 'ff341ac9' && shortProjectHash('/w/mercury_site') !== 'ff341ac9',
      `${shortProjectHash('/w/mercury-site')} / ${shortProjectHash('/w/mercury_site')}`,
    )
    check(
      'H-15: the hash is deterministic across calls and sensitive to one byte',
      shortProjectHash(a) === shortProjectHash(a) && shortProjectHash(a) !== shortProjectHash(`${a}x`),
    )
    const fresh = join(scratch, 'h15-fresh-project')
    check(
      'H-15: a fresh project keys to the HASHED slug (creation default)',
      getProjectDir(fresh).endsWith(projectSlug(fresh)),
      getProjectDir(fresh),
    )
    const legacyProj = join(scratch, 'h15-legacy-project')
    const legacyStore = join(projectsDir, sanitizePath(legacyProj))
    mkdirSync(legacyStore, { recursive: true })
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
