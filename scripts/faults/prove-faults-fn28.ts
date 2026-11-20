#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn28-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_HOME = ''
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as unknown as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES =
  process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

{
  console.log('\nartifactIdentity: corrupt or unreadable manifest keeps packaged-install/source-build')
  const { describeArtifactIdentity } = await import('../../src/utils/artifactIdentity.ts')
  const pkgDir = join(SCRATCH, 'pkg-dist')
  mkdirSync(pkgDir, { recursive: true })
  const pkgEntry = join(pkgDir, 'mercury.mjs')
  const pkgManifest = join(pkgDir, 'manifest.json')
  writeFileSync(pkgEntry, '')
  writeFileSync(pkgManifest, '{broken json')
  const corruptPkg = describeArtifactIdentity('1.0.0', pkgEntry)
  check(
    'artifactIdentity-corrupt-manifest: corrupt manifest beside .mjs reports packaged-install, not source-run',
    corruptPkg.distribution === 'packaged-install',
    JSON.stringify(corruptPkg),
  )

  const srcRoot = join(SCRATCH, 'src-repo')
  const srcDist = join(srcRoot, 'dist')
  mkdirSync(srcDist, { recursive: true })
  writeFileSync(join(srcRoot, 'build.ts'), '')
  const srcEntry = join(srcDist, 'mercury.mjs')
  writeFileSync(srcEntry, '')
  writeFileSync(join(srcDist, 'manifest.json'), '{broken json')
  const corruptSrc = describeArtifactIdentity('1.0.0', srcEntry)
  check(
    'artifactIdentity-corrupt-source-build: corrupt manifest with ../build.ts reports source-build',
    corruptSrc.distribution === 'source-build',
    JSON.stringify(corruptSrc),
  )

  if (!POSIX_MODES) skip('artifactIdentity-unreadable-manifest', 'needs non-root POSIX')
  else {
    writeFileSync(pkgManifest, JSON.stringify({ buildTree: 'abcdef123456' }))
    chmodSync(pkgManifest, 0o200)
    try {
      const unreadPkg = describeArtifactIdentity('1.0.0', pkgEntry)
      check(
        'artifactIdentity-unreadable-manifest: unreadable manifest reports packaged-install, not source-run',
        unreadPkg.distribution === 'packaged-install',
        JSON.stringify(unreadPkg),
      )
    } finally {
      chmodSync(pkgManifest, 0o600)
    }
  }
}

{
  console.log('\nreviewStore: unreadable journal fails mutators, heads source, and journal reader instead of answering absent/empty')
  const { readFileSync } = await import('node:fs')
  const store = await import('../../src/utils/artifacts/reviewStore.ts')
  const created = store.createReviewArtifact({
    kind: 'plan',
    title: 'lock-test',
    producer: { sessionId: 'sess-1' },
    workspace: { roots: [SCRATCH] },
    body: { kind: 'plan', markdown: '# plan\n' },
  })
  check('reviewStore-setup: artifact created', created.ok, created.ok ? '' : created.reason)
  if (created.ok) {
    const id = created.value.id
    const journal = join(store.reviewArtifactsRoot(), id, 'journal.jsonl')
    const beforeBytes = readFileSync(journal, 'utf8')
    if (!POSIX_MODES) skip('reviewStore-unreadable-journal', 'needs non-root POSIX')
    else {
      chmodSync(journal, 0o200)
      try {
        const res = store.setReviewArtifactStatus({ id, version: 1, status: 'ready-for-review' })
        check(
          'reviewStore-mutator-refuses-unreadable: mutator reports write/read failure instead of no review artifact',
          !res.ok && res.reason.startsWith('write failed:'),
          JSON.stringify(res),
        )
        const heads = store.listReviewArtifactHeadsSource()
        check(
          'reviewStore-heads-source-reports-unreadable: listReviewArtifactHeadsSource classifies EACCES instead of omitting',
          heads.state !== 'ready' && heads.state !== 'empty',
          JSON.stringify(heads),
        )
        let journalThrew: NodeJS.ErrnoException | null = null
        try {
          store.readReviewArtifactJournal(id)
        } catch (err) {
          journalThrew = err as NodeJS.ErrnoException
        }
        check(
          'reviewStore-journal-throws-unreadable: readReviewArtifactJournal throws EACCES on unreadable file',
          journalThrew !== null && journalThrew.code === 'EACCES',
          String(journalThrew),
        )
      } finally {
        chmodSync(journal, 0o600)
      }
      check(
        'reviewStore-mutator-keeps-bytes: journal is byte-identical after refused write',
        readFileSync(journal, 'utf8') === beforeBytes,
      )
    }
    check(
      'reviewStore-journal-absent-empty: absent review artifact journal still answers []',
      store.readReviewArtifactJournal('ra-deadbeef').length === 0,
    )
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
