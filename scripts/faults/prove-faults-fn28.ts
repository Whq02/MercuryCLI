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

const FN28_FIX_HINTS: Array<[string, string]> = [
  ['artifactIdentity-', 'fix describeArtifactIdentity in src/platform/product/artifactIdentity.ts so a manifest that is corrupt or unreadable keeps the distribution the entry location implies'],
  ['reviewStore-', 'fix the journal read path in src/sessions/artifact-reviews/reviewStore.ts (setReviewArtifactStatus, listReviewArtifactHeadsSource, readReviewArtifactJournal) so an unreadable journal is reported, never answered as absent or empty'],
  ['artifacts-', 'fix listArtifacts and getArtifact in src/sessions/artifacts/store.ts so only ENOENT means absent and every other read or parse error rejects'],
  ['astSearch-', 'fix searchAstPattern in src/tools/engines/structure/ast-patterns/search.ts so an unreadable file is recorded in parseFailures with the word unreadable'],
  ['fileAttachments-', 'fix generateFileAttachment in src/engine/attachments/fileAttachments.ts so a stat failure other than ENOENT returns the refused dropped_image_file row, and a missing file returns null'],
  ['mentionResolvers-', 'fix processAtMentionedFiles and processMcpResourceAttachments in src/engine/attachments/mentionResolvers.ts so an unreadable directory is reported and a lookup bug is thrown'],
  ['bootCardFacts-', 'fix workspaceRecognizedByGround, parkedSessionsOf and projectChatCount in src/screen/boot-face/bootCardFacts.ts so an unreadable store fails closed or throws, and an absent store stays empty'],
  ['boxLock-', 'fix readBoxLockState and boxReading in src/platform/storage/boxLock.ts so an unreadable lock dir, holder or queue throws and is reported as not readable, and an absent dir answers null'],
]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const fix = cond ? undefined : FN28_FIX_HINTS.find(([prefix]) => label.startsWith(prefix))?.[1]
  const shown = !cond && (detail || fix) ? ` — ${[detail, fix].filter(Boolean).join(' | ')}` : ''
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

{
  console.log('\nartifactIdentity: corrupt or unreadable manifest keeps packaged-install/source-build')
  const { describeArtifactIdentity } = await import('../../src/platform/product/artifactIdentity.ts')
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
  const store = await import('../../src/sessions/artifact-reviews/reviewStore.ts')
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

{
  console.log('\nartifacts/store: listArtifacts and getArtifact reject on non-ENOENT or corrupt meta')
  const artifacts = await import('../../src/sessions/artifacts/store.ts')
  const stored = await artifacts.storeArtifact({ scope: 'fault-scope', name: 'sample', content: 'hello' })
  check('artifacts-setup: stored artifact', stored.id !== null && stored.path !== null, JSON.stringify(stored))
  if (stored.id !== null) {
    const scopeDir = join(artifacts.getArtifactsRootDir(), 'fault-scope')
    const metaPath = join(scopeDir, `${stored.id}.meta.json`)
    if (!POSIX_MODES) skip('artifacts-unreadable', 'needs non-root POSIX')
    else {
      chmodSync(scopeDir, 0o000)
      let listDirErr: NodeJS.ErrnoException | null = null
      try {
        await artifacts.listArtifacts('fault-scope')
      } catch (err) {
        listDirErr = err as NodeJS.ErrnoException
      } finally {
        chmodSync(scopeDir, 0o700)
      }
      check(
        'artifacts-list-unreadable-dir: listArtifacts rejects with EACCES on unreadable scope dir',
        listDirErr !== null && listDirErr.code === 'EACCES',
        String(listDirErr),
      )

      chmodSync(metaPath, 0o200)
      let getMetaErr: NodeJS.ErrnoException | null = null
      try {
        await artifacts.getArtifact('fault-scope', stored.id)
      } catch (err) {
        getMetaErr = err as NodeJS.ErrnoException
      } finally {
        chmodSync(metaPath, 0o600)
      }
      check(
        'artifacts-get-unreadable-meta: getArtifact rejects with EACCES on unreadable meta file',
        getMetaErr !== null && getMetaErr.code === 'EACCES',
        String(getMetaErr),
      )
    }

    writeFileSync(join(scopeDir, 'corrupt-id.meta.json'), '{not-json')
    let listCorruptErr: unknown = null
    try {
      await artifacts.listArtifacts('fault-scope')
    } catch (err) {
      listCorruptErr = err
    }
    check(
      'artifacts-list-corrupt-meta: listArtifacts rejects on corrupt meta JSON instead of dropping it',
      listCorruptErr instanceof SyntaxError,
      String(listCorruptErr),
    )

    let getCorruptErr: unknown = null
    try {
      await artifacts.getArtifact('fault-scope', 'corrupt-id')
    } catch (err) {
      getCorruptErr = err
    }
    check(
      'artifacts-get-corrupt-meta: getArtifact rejects on corrupt meta JSON instead of returning null',
      getCorruptErr instanceof SyntaxError,
      String(getCorruptErr),
    )
    rmSync(join(scopeDir, 'corrupt-id.meta.json'), { force: true })

    check(
      'artifacts-list-absent-empty: absent scope still returns []',
      (await artifacts.listArtifacts('no-such-scope')).length === 0,
    )
    check(
      'artifacts-get-absent-null: absent artifact still returns null',
      (await artifacts.getArtifact('fault-scope', 'no-such-id')) === null,
    )
  }
}

{
  console.log('\nastPatterns/search: unreadable files are recorded in parseFailures instead of skipped silently')
  const { searchAstPattern } = await import('../../src/tools/engines/structure/ast-patterns/search.ts')
  const { resolveAstScope, isAstRefusal } = await import('../../src/tools/engines/structure/ast-patterns/scope.ts')
  const astDir = join(SCRATCH, 'ast-proj')
  mkdirSync(astDir, { recursive: true })
  const secretFile = join(astDir, 'secret.ts')
  writeFileSync(secretFile, 'export const needle = 1\n')
  const scope = resolveAstScope({ cwd: astDir, path: '.' })
  check('astSearch-setup: scope resolved', !isAstRefusal(scope) && scope.files.length === 1)
  if (!isAstRefusal(scope)) {
    if (!POSIX_MODES) skip('astSearch-unreadable', 'needs non-root POSIX')
    else {
      chmodSync(secretFile, 0o200)
      try {
        const res = await searchAstPattern(scope, { pattern: 'needle' })
        check(
          'astSearch-unreadable-recorded: unreadable file lands in parseFailures (main read path)',
          !isAstRefusal(res) && res.parseFailures.some(f => f.rel === 'secret.ts' && f.message.includes('unreadable')),
          JSON.stringify(isAstRefusal(res) ? res : res.parseFailures),
        )
        const patternOnlyScope = {
          ...scope,
          files: scope.files.map(f => ({ ...f, lang: { ...f.lang, patternOnly: true } })),
        }
        const resPO = await searchAstPattern(patternOnlyScope, { pattern: 'needle' })
        check(
          'astSearch-patternOnly-unreadable-recorded: unreadable file lands in parseFailures (patternOnly pre-read path)',
          !isAstRefusal(resPO) && resPO.parseFailures.some(f => f.rel === 'secret.ts' && f.message.includes('unreadable')),
          JSON.stringify(isAstRefusal(resPO) ? resPO : resPO.parseFailures),
        )
      } finally {
        chmodSync(secretFile, 0o600)
      }
    }
  }
}

{
  console.log('\nfileAttachments: unreadMention reports non-ENOENT stat failure instead of dropping at-mention')
  const { generateFileAttachment } = await import('../../src/engine/attachments/fileAttachments.ts')
  const sealedDir = join(SCRATCH, 'sealed-dir')
  mkdirSync(sealedDir, { recursive: true })
  const sealedFile = join(sealedDir, 'secret.txt')
  writeFileSync(sealedFile, 'top secret\n')
  const ctx = {
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        additionalWorkingDirectories: new Map(),
      },
    }),
    options: {},
    abortController: new AbortController(),
    readFileState: new Map(),
  }
  if (!POSIX_MODES) skip('fileAttachments-unread-eacces', 'needs non-root POSIX')
  else {
    chmodSync(sealedDir, 0o000)
    try {
      const row = await generateFileAttachment(sealedFile, ctx as never, 'at-mention')
      check(
        'fileAttachments-unread-eacces: at-mention in unreadable dir returns dropped_image_file instead of null',
        row !== null && row.type === 'dropped_image_file' && row.unread === 'refused' && row.reason.startsWith('Reading it failed:'),
        JSON.stringify(row),
      )
    } finally {
      chmodSync(sealedDir, 0o700)
    }
  }
  const missingRow = await generateFileAttachment(join(SCRATCH, 'does-not-exist.txt'), ctx as never, 'at-mention')
  check(
    'fileAttachments-absent-null: nonexistent at-mention still returns null',
    missingRow === null,
    JSON.stringify(missingRow),
  )
}

{
  console.log('\nmentionResolvers: unreadable directory mention reports failure and readMentionedResource lets bugs throw')
  const { processAtMentionedFiles, processMcpResourceAttachments } = await import('../../src/engine/attachments/mentionResolvers.ts')
  const unreadDir = join(SCRATCH, 'unreadable-mention-dir')
  mkdirSync(unreadDir, { recursive: true })
  const ctx = {
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        additionalWorkingDirectories: new Map(),
      },
    }),
    options: {},
    abortController: new AbortController(),
    readFileState: new Map(),
  }
  if (!POSIX_MODES) skip('mentionResolvers-unreadable-dir', 'needs non-root POSIX')
  else {
    chmodSync(unreadDir, 0o000)
    try {
      const rows = await processAtMentionedFiles(`@${unreadDir}`, ctx as never)
      const first = rows[0]
      check(
        'mentionResolvers-unreadable-dir: unreadable directory mention returns dropped_image_file instead of []',
        rows.length === 1 &&
          first?.type === 'dropped_image_file' &&
          first.unread === 'refused' &&
          first.reason.startsWith('Reading it failed:'),
        JSON.stringify(rows),
      )
    } finally {
      chmodSync(unreadDir, 0o700)
    }
  }

  let bugThrew: unknown = null
  try {
    await processMcpResourceAttachments('@srv:res', {
      options: {
        mcpClients: {
          find() {
            throw new TypeError('bug in mcpClients lookup')
          },
        },
      },
    } as never)
  } catch (err) {
    bugThrew = err
  }
  check(
    'mentionResolvers-mcp-bug-throws: readMentionedResource propagates lookup bug instead of returning []',
    bugThrew instanceof TypeError && bugThrew.message === 'bug in mcpClients lookup',
    String(bugThrew),
  )
}

{
  console.log('\nbootCardFacts: unreadable project store fails closed in workspaceRecognizedByGround and throws in parkedSessionsOf/projectChatCount')
  const boot = await import('../../src/screen/boot-face/bootCardFacts.ts')
  const { getProjectDir } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
  boot._resetProjectCatalogForTesting()
  const ground = join(SCRATCH, 'ground-proj')
  const nested = join(ground, 'nested-ws')
  mkdirSync(nested, { recursive: true })
  const nestedStore = getProjectDir(nested)
  mkdirSync(nestedStore, { recursive: true })

  if (!POSIX_MODES) skip('bootCardFacts-unreadable-store', 'needs non-root POSIX')
  else {
    chmodSync(nestedStore, 0o000)
    try {
      check(
        'bootCardFacts-ground: a nested workspace whose store is unreadable counts as inside the project, as before',
        boot.workspaceRecognizedByGround(ground, nested) === true,
      )
      let parkedErr: NodeJS.ErrnoException | null = null
      try {
        boot.parkedSessionsOf(nested)
      } catch (err) {
        parkedErr = err as NodeJS.ErrnoException
      }
      check(
        'bootCardFacts-parked-throws-eacces: parkedSessionsOf throws EACCES on unreadable store dir',
        parkedErr !== null && parkedErr.code === 'EACCES',
        String(parkedErr),
      )
      let countErr: NodeJS.ErrnoException | null = null
      try {
        boot.projectChatCount(nested)
      } catch (err) {
        countErr = err as NodeJS.ErrnoException
      }
      check(
        'bootCardFacts-chatcount-throws-eacces: projectChatCount throws EACCES on unreadable store dir',
        countErr !== null && countErr.code === 'EACCES',
        String(countErr),
      )
    } finally {
      chmodSync(nestedStore, 0o700)
    }
    check(
      'bootCardFacts-ground-recovers-uncached: unreadable store was not cached so readable empty nested store now belongs to ground',
      boot.workspaceRecognizedByGround(ground, nested) === true,
    )
  }

  const absentWs = join(SCRATCH, 'absent-ws')
  check(
    'bootCardFacts-parked-absent-empty: absent store dir still returns [] in parkedSessionsOf',
    boot.parkedSessionsOf(absentWs).length === 0,
  )
  check(
    'bootCardFacts-chatcount-absent-zero: absent store dir still returns 0 in projectChatCount',
    boot.projectChatCount(absentWs) === 0,
  )
}

{
  console.log('\nboxLock: unreadable lock dir, holder, or queue throws in readBoxLockState and reports not readable in boxReading')
  const box = await import('../../src/platform/storage/boxLock.ts')
  const lockDir = join(SCRATCH, 'box-lock')
  mkdirSync(join(lockDir, 'box.lock'), { recursive: true })
  const holderFile = join(lockDir, 'box.lock', 'holder')
  writeFileSync(holderFile, `${process.pid} test-slot 08:00:00\n`)
  mkdirSync(join(lockDir, 'box.queue'), { recursive: true })
  const ticketFile = join(lockDir, 'box.queue', '1700000000000000000-waiter.ticket')
  writeFileSync(ticketFile, 'waiter-1\n')
  const absentDir = join(SCRATCH, 'box-lock-absent')

  check('boxLock-absent-null: absent lock dir answers null', box.readBoxLockState(absentDir) === null)
  box.rememberBoxLockDir(absentDir)
  check(
    'boxLock-reading-absent: boxReading on absent dir says is not there',
    box.boxReading().lockNote === `the box lock directory ${absentDir} is not there`,
  )

  if (!POSIX_MODES) skip('boxLock-unreadable', 'needs non-root POSIX')
  else {
    box.rememberBoxLockDir(lockDir)
    chmodSync(lockDir, 0o000)
    let dirErr: NodeJS.ErrnoException | null = null
    let readingOnDirErr: ReturnType<typeof box.boxReading>
    try {
      try {
        box.readBoxLockState(lockDir)
      } catch (err) {
        dirErr = err as NodeJS.ErrnoException
      }
      readingOnDirErr = box.boxReading()
    } finally {
      chmodSync(lockDir, 0o700)
    }
    check(
      'boxLock-dir-throws-eacces: readBoxLockState throws EACCES on unreadable lock dir',
      dirErr !== null && dirErr.code === 'EACCES',
      String(dirErr),
    )
    check(
      'boxLock-reading-dir-unreadable: boxReading().lockNote says the box lock state is not readable',
      readingOnDirErr.lock === null && readingOnDirErr.lockNote === 'the box lock state is not readable',
      JSON.stringify(readingOnDirErr),
    )

    chmodSync(holderFile, 0o200)
    let holderErr: NodeJS.ErrnoException | null = null
    let readingOnHolderErr: ReturnType<typeof box.boxReading>
    try {
      try {
        box.readBoxLockState(lockDir)
      } catch (err) {
        holderErr = err as NodeJS.ErrnoException
      }
      readingOnHolderErr = box.boxReading()
    } finally {
      chmodSync(holderFile, 0o600)
    }
    check(
      'boxLock-holder-throws-eacces: readBoxLockState throws EACCES on unreadable holder file',
      holderErr !== null && holderErr.code === 'EACCES',
      String(holderErr),
    )
    check(
      'boxLock-reading-holder-unreadable: boxReading().lockNote says the box lock state is not readable on unreadable holder',
      readingOnHolderErr.lock === null && readingOnHolderErr.lockNote === 'the box lock state is not readable',
      JSON.stringify(readingOnHolderErr),
    )

    chmodSync(ticketFile, 0o200)
    let ticketErr: NodeJS.ErrnoException | null = null
    try {
      box.readBoxLockState(lockDir)
    } catch (err) {
      ticketErr = err as NodeJS.ErrnoException
    } finally {
      chmodSync(ticketFile, 0o600)
    }
    check(
      'boxLock-ticket-throws-eacces: readBoxLockState throws EACCES on unreadable queue ticket',
      ticketErr !== null && ticketErr.code === 'EACCES',
      String(ticketErr),
    )

    chmodSync(join(lockDir, 'box.queue'), 0o000)
    let queueErr: NodeJS.ErrnoException | null = null
    try {
      box.readBoxLockState(lockDir)
    } catch (err) {
      queueErr = err as NodeJS.ErrnoException
    } finally {
      chmodSync(join(lockDir, 'box.queue'), 0o700)
    }
    check(
      'boxLock-queue-throws-eacces: readBoxLockState throws EACCES on unreadable box.queue dir',
      queueErr !== null && queueErr.code === 'EACCES',
      String(queueErr),
    )
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
