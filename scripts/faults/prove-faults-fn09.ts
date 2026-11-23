#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
const faultHints: Array<[string, string]> = [
  ['changeSetPlan-', 'change planChangeSet in src/tools/engines/change-transaction/changeSetPlan.ts to refuse (code io or destination) on an unreadable path and plan a truly missing destination directory'],
  ['changeSetCommit-', 'change runTextChangeSetCommit or recoverChangeSetJournal in src/tools/engines/change-transaction/changeSetCommit.ts so an unreadable target is never treated as absent'],
  ['concourseSnapshot-', 'change readHarnessGround in src/screen/concourse-model/concourseSnapshot.ts to answer the current folder with a reason, and no throw, when the draft is corrupt or unreadable'],
  ['launchControls-', 'change newSession in src/screen/concourse/route/launchControls.ts to start the session in the answered ground and note the unread repo choice once'],
]
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = cond ? '' : (faultHints.find(([prefix]) => label.startsWith(prefix))?.[1] ?? '')
  const said = [detail, hint].filter(Boolean).join(' | ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && said ? ` — ${said}` : ''}`)
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
    const { planChangeSet } = await import(${JSON.stringify(join(SRC, 'tools/engines/change-transaction/changeSetPlan.ts'))})
    const { mintFileAnchor } = await import(${JSON.stringify(join(SRC, 'tools/engines/change-transaction/snapshotAnchor.ts'))})
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
    const { runTextChangeSetCommit, recoverChangeSetJournal, TEXT_CHANGE_SET_KIND } = await import(${JSON.stringify(join(SRC, 'tools/engines/change-transaction/changeSetCommit.ts'))})
    const { sha256Hex } = await import(${JSON.stringify(join(SRC, 'platform/primitives/hash.ts'))})
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
    const { journalOperationPath } = await import(${JSON.stringify(join(SRC, 'platform/substrate/operationJournal.ts'))})
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

console.log('\nconcourseSnapshot — a repo choice that cannot be read starts the new session in the current folder and says so')
if (!POSIX_MODES) {
  skip('concourseSnapshot-readHarnessGround', 'needs non-root POSIX chmod')
} else {
  const r = runSub(`
    const snapMod = await import(${JSON.stringify(join(SRC, 'screen/concourse-model/concourseSnapshot.ts'))})
    const draftDir = path.join(PROJECT, 'drafts')
    fs.mkdirSync(draftDir, { recursive: true })
    out.cwd = process.cwd()
    out.absent = await snapMod.readHarnessGround(draftDir)
    const draftPath = path.join(draftDir, 'concourse-draft.json')
    fs.writeFileSync(draftPath, '{not valid json', { mode: 0o600 })
    out.corrupt = await snapMod.readHarnessGround(draftDir)
    out.corruptGround = await snapMod.resolveHarnessGround(draftDir)
    fs.writeFileSync(draftPath, JSON.stringify({ _v: 1, draft: '', updatedAtMs: 1, seedOverrides: { projectDir: '/other', projectDirAt: Date.now() } }), { mode: 0o600 })
    fs.chmodSync(draftPath, 0o200)
    try {
      out.unreadable = await snapMod.readHarnessGround(draftDir)
    } finally {
      fs.chmodSync(draftPath, 0o600)
    }
  `)
  const absent = r.absent as { ground?: string; unread?: string } | undefined
  const corrupt = r.corrupt as { ground?: string; unread?: string } | undefined
  const unreadable = r.unreadable as { ground?: string; unread?: string } | undefined
  check(
    'concourseSnapshot-readHarnessGround: an absent draft answers the current folder with nothing to say; a corrupt or unreadable one answers the current folder and why, with no throw',
    typeof absent?.ground === 'string' &&
      absent.unread === undefined &&
      corrupt?.ground === absent.ground &&
      typeof corrupt?.unread === 'string' &&
      corrupt.unread.length > 0 &&
      r.corruptGround === absent.ground &&
      unreadable?.ground === absent.ground &&
      typeof unreadable?.unread === 'string' &&
      unreadable.unread.length > 0,
    JSON.stringify(r),
  )
}

console.log('\nlaunchControls — the new session is born where it can be and its note says the repo choice could not be read')
{
  const r = runSub(`
    const { mock } = await import('bun:test')
    const snapPath = ${JSON.stringify(join(SRC, 'screen/concourse-model/concourseSnapshot.ts'))}
    const realSnap = await import(${JSON.stringify(join(SRC, 'screen/concourse-model/concourseSnapshot.ts'))})
    mock.module(snapPath, () => ({ ...realSnap, readHarnessGround: async () => ({ ground: '/work/elsewhere', unread: 'EACCES: permission denied' }) }))
    mock.module(${JSON.stringify(join(SRC, 'daemon/switchboard/bornSession.ts'))}, () => ({
      bornSession: async ({ workspaceDir }) => {
        out.bornIn = workspaceDir
        return { ok: true, title: 'Session one', sessionId: 's-1' }
      },
    }))
    const { newSession } = await import(${JSON.stringify(join(SRC, 'screen/concourse/route/launchControls.ts'))})
    const notes = []
    newSession({
      noteControl: (control, state) => { notes.push({ control, ...state }) },
      splitFrameStands: () => true,
      birthInFlightRef: { current: false },
      seedWriteChain: { current: Promise.resolve() },
      snapshotRef: { current: null },
    })
    await new Promise(resolve => setTimeout(resolve, 120))
    out.notes = notes
  `)
  const notes = (r.notes as Array<{ control?: string; state?: string; reason?: string }> | undefined) ?? []
  const applied = notes.find(note => note.state === 'applied')
  check(
    'launchControls-newSession-repo-choice-unread: the session is born, not refused, and the note carries the sentence once',
    r.bornIn === '/work/elsewhere' &&
      notes.filter(note => note.state === 'applied').length === 1 &&
      !notes.some(note => note.state === 'failed' || note.state === 'refused') &&
      applied?.reason === 'Session one — in the chat pane — the repo choice could not be read (EACCES: permission denied), so it starts in elsewhere',
    JSON.stringify(r),
  )
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
