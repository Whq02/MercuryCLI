#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '../../src')
const BUN = process.env.BUN ?? (process.execPath.includes('bun') ? process.execPath : 'bun')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runSub(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn09-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const fs = await import('node:fs')
    const path = await import('node:path')
    const SRC = ${JSON.stringify(SRC)}
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', NODE_ENV: '' },
    })
    if (res.status !== 0) throw new Error(`sub failed (rc=${res.status}): ${res.stderr.slice(-1200)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    try {
      chmodSync(home, 0o700)
    } catch {}
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nchangeSetPlan — unreadable source and move destination refuse instead of failing open or claiming missing')
if (!POSIX_MODES) {
  skip('changeSetPlan-unreadable-paths', 'needs non-root POSIX chmod')
} else {
  const r = runSub(`
    const { planChangeSet } = await import(path.join(SRC, 'services/changeTransaction/changeSetPlan.ts'))
    const { mintFileAnchor } = await import(path.join(SRC, 'services/changeTransaction/snapshotAnchor.ts'))
    const srcFile = path.join(PROJECT, 'src.txt')
    fs.writeFileSync(srcFile, 'hello\\n')
    const anchor = mintFileAnchor('hello\\n')
    const ctx = {
      ownerKey: 'test-owner',
      exactEdit: () => ({ ok: false, message: 'unused' }),
    }

    const lockedSrcDir = path.join(PROJECT, 'locked-src')
    fs.mkdirSync(lockedSrcDir)
    const lockedSrc = path.join(lockedSrcDir, 'a.txt')
    fs.writeFileSync(lockedSrc, 'hello\\n')
    fs.chmodSync(lockedSrcDir, 0o000)
    try {
      out.lockedSource = planChangeSet([{ file_path: lockedSrc, expected_anchor: anchor, hunks: [{ lines: '1', replace: 'hi' }] }], ctx)
    } finally {
      fs.chmodSync(lockedSrcDir, 0o700)
    }

    const loopA = path.join(PROJECT, 'loopA')
    const loopB = path.join(PROJECT, 'loopB')
    fs.symlinkSync(loopB, loopA)
    fs.symlinkSync(loopA, loopB)
    out.loopDest = planChangeSet([{ file_path: srcFile, expected_anchor: anchor, op: 'move', new_path: path.join(loopA, 'dest.txt') }], ctx)

    const noExecDestDir = path.join(PROJECT, 'no-exec-dest')
    fs.mkdirSync(noExecDestDir)
    const existingDest = path.join(noExecDestDir, 'exists.txt')
    fs.writeFileSync(existingDest, 'precious\\n')
    fs.chmodSync(noExecDestDir, 0o400)
    try {
      out.unstatDest = planChangeSet([{ file_path: srcFile, expected_anchor: anchor, op: 'move', new_path: existingDest }], ctx)
    } finally {
      fs.chmodSync(noExecDestDir, 0o700)
    }

    out.missingDestDir = planChangeSet([{ file_path: srcFile, expected_anchor: anchor, op: 'move', new_path: path.join(PROJECT, 'new-subdir', 'moved.txt') }], ctx)
  `)
  const lockedSource = r.lockedSource as { ok: boolean; code?: string }
  const loopDest = r.loopDest as { ok: boolean; code?: string }
  const unstatDest = r.unstatDest as { ok: boolean; code?: string }
  const missingDestDir = r.missingDestDir as { ok: boolean }
  check('changeSetPlan-canonicalize-eacces: unreadable source directory refuses with io instead of missing', lockedSource.ok === false && lockedSource.code === 'io', JSON.stringify(lockedSource))
  check('changeSetPlan-dest-realpath-eloop: symlink-loop move destination refuses instead of leaving unresolved path', loopDest.ok === false && loopDest.code === 'destination', JSON.stringify(loopDest))
  check('changeSetPlan-dest-lstat-eacces: unreadable destination directory refuses instead of treating destination free', unstatDest.ok === false && unstatDest.code === 'destination', JSON.stringify(unstatDest))
  check('changeSetPlan-dest-enoent-control: missing move destination directory still plans ok', missingDestDir.ok === true, JSON.stringify(missingDestDir))
}

console.log('\nchangeSetCommit — unreadable target is never treated as absent during commit or recovery')
if (!POSIX_MODES) {
  skip('changeSetCommit-unreadable-target', 'needs non-root POSIX chmod')
} else {
  const r = runSub(`
    const { runTextChangeSetCommit, recoverChangeSetJournal, TEXT_CHANGE_SET_KIND } = await import(path.join(SRC, 'services/changeTransaction/changeSetCommit.ts'))
    const { sha256Hex } = await import(path.join(SRC, 'services/changeTransaction/changeSetPlan.ts'))
    const journalDir = path.join(PROJECT, 'journal')
    const bundleRoot = path.join(PROJECT, 'bundles')

    const existing = path.join(PROJECT, 'existing-secret.txt')
    const origBytes = Buffer.from('original-precious\\n')
    const plannedBytes = Buffer.from('overwritten\\n')
    fs.writeFileSync(existing, origBytes, { mode: 0o600 })
    fs.chmodSync(existing, 0o200)
    try {
      out.createOverUnreadable = await runTextChangeSetCommit({
        ownerKey: 'test-owner',
        source: 'proof',
        planDigest: sha256Hex('create-over-unreadable'),
        journalDir,
        bundleRoot,
        targets: [{
          canonicalPath: existing,
          originalDigest: sha256Hex(Buffer.alloc(0)),
          plannedDigest: sha256Hex(plannedBytes),
          originalBytes: Buffer.alloc(0),
          plannedBytes,
          mode: 0o644,
          kind: 'create',
        }],
      })
    } finally {
      fs.chmodSync(existing, 0o600)
    }
    out.existingAfter = fs.readFileSync(existing, 'utf8')

    const toDelete = path.join(PROJECT, 'keep-me.txt')
    fs.writeFileSync(toDelete, origBytes, { mode: 0o600 })
    const delJournalDir = path.join(PROJECT, 'del-journal')
    const delBundleRoot = path.join(PROJECT, 'del-bundles')
    fs.mkdirSync(delJournalDir, { recursive: true })
    fs.mkdirSync(delBundleRoot, { recursive: true })
    const { journalOperationPath } = await import(path.join(SRC, 'substrate/operationJournal.ts'))
    const opId = 'delete-unreadable'
    fs.writeFileSync(journalOperationPath(delJournalDir, opId), JSON.stringify({
      schema: 1,
      operationId: opId,
      kind: TEXT_CHANGE_SET_KIND,
      ownerKey: 'test-owner',
      idempotencyKey: 'test-owner#del-unreadable',
      state: 'applying',
      writerPid: 99999999,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      steps: [{ id: 'commit-0', target: toDelete, state: 'pending' }],
      payload: {
        v: 2,
        source: 'proof',
        planDigest: sha256Hex('del-unreadable'),
        bundleDir: delBundleRoot,
        targets: [{
          path: toDelete,
          originalDigest: sha256Hex(origBytes),
          plannedDigest: sha256Hex(Buffer.alloc(0)),
          tmp: '',
          mode: 0o600,
          bundleFile: 't0.bin',
          kind: 'delete',
        }],
      },
    }))
    fs.chmodSync(toDelete, 0o200)
    try {
      out.recovery = await recoverChangeSetJournal({ journalDir: delJournalDir, bundleRoot: delBundleRoot })
    } finally {
      fs.chmodSync(toDelete, 0o600)
    }
  `)
  const createOutcome = r.createOverUnreadable as { kind: string }
  const recovery = r.recovery as { rolledForward: string[]; unrecoverable: string[] }
  check('changeSetCommit-readOrNull-create-eacces: create refuses to overwrite an existing unreadable file', createOutcome.kind === 'indeterminate' && r.existingAfter === 'original-precious\n', JSON.stringify({ createOutcome, existingAfter: r.existingAfter }))
  check('changeSetCommit-readOrNull-delete-recovery: journal recovery marks unreadable delete target unrecoverable instead of rolling forward', recovery.rolledForward.length === 0 && recovery.unrecoverable.includes('delete-unreadable'), JSON.stringify(recovery))
}

console.log('\nconcourseSnapshot — resolveHarnessGround rejects when the draft store cannot be read or parsed')
if (!POSIX_MODES) {
  skip('concourseSnapshot-resolveHarnessGround', 'needs non-root POSIX chmod')
} else {
  const r = runSub(`
    const snapMod = await import(path.join(SRC, 'services/concourse/concourseSnapshot.ts'))
    const draftDir = path.join(PROJECT, 'drafts')
    fs.mkdirSync(draftDir, { recursive: true })
    out.absentGround = await snapMod.resolveHarnessGround(draftDir)
    const draftPath = path.join(draftDir, 'concourse-draft.json')
    fs.writeFileSync(draftPath, '{not valid json', { mode: 0o600 })
    try {
      await snapMod.resolveHarnessGround(draftDir)
      out.corruptGround = null
    } catch (e) {
      out.corruptGround = String(e?.message ?? e)
    }
    fs.writeFileSync(draftPath, JSON.stringify({ _v: 1, draft: '', updatedAtMs: 1, seedOverrides: { projectDir: '/other', projectDirAt: Date.now() } }), { mode: 0o600 })
    fs.chmodSync(draftPath, 0o200)
    try {
      await snapMod.resolveHarnessGround(draftDir)
      out.unreadableGround = null
    } catch (e) {
      out.unreadableGround = String(e?.message ?? e)
    } finally {
      fs.chmodSync(draftPath, 0o600)
    }
  `)
  check('concourseSnapshot-resolveHarnessGround-corrupt-unreadable: absent returns cwd while corrupt or unreadable rejects', typeof r.absentGround === 'string' && r.corruptGround !== null && r.unreadableGround !== null, JSON.stringify(r))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
