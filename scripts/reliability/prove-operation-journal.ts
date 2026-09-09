import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  compactJournalDir,
  listJournalOperations,
  recoverJournalDir,
  runJournaledOperation,
  type DurableOperation,
} from '../../src/substrate/operationJournal.ts'

let failures = 0
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`)
  if (!cond) failures++
}
const tmp = mkdtempSync(join(tmpdir(), 'mercury-journal-'))
const BUN = process.execPath
const CHILD = join(import.meta.dir, 'helpers', 'journalKillChild.ts')

const markerSteps = (work: string, runs: { s1: number; s2: number }) => [
  {
    id: 's1',
    target: join(work, 'marker-1'),
    run: async () => {
      runs.s1++
      writeFileSync(join(work, 'marker-1'), 'one')
    },
  },
  {
    id: 's2',
    target: join(work, 'marker-2'),
    run: async () => {
      runs.s2++
      writeFileSync(join(work, 'marker-2'), 'two')
    },
  },
]
const wipeMarkers = (work: string) => {
  rmSync(join(work, 'marker-1'), { force: true })
  rmSync(join(work, 'marker-2'), { force: true })
}

{
  const dir = join(tmp, 'j1')
  const work = join(tmp, 'w1')
  mkdirSync(work, { recursive: true })
  const runs = { s1: 0, s2: 0 }
  const first = await runJournaledOperation({
    journalDir: dir,
    ownerKey: 'owner-a',
    kind: 'relia-two-step',
    idempotencyKey: 'create-x',
    steps: markerSteps(work, runs),
    result: () => ({ made: 2 }),
  })
  ok(
    first.outcome === 'committed' && (first.result as { made: number }).made === 2,
    '§1 operation commits with its result',
  )
  const ops = await listJournalOperations(dir)
  ok(
    ops.length === 1 &&
      ops[0]!.state === 'committed' &&
      ops[0]!.steps.every(s => s.state === 'applied'),
    '§1 the journal record is committed with every step applied',
  )
  const again = await runJournaledOperation({
    journalDir: dir,
    ownerKey: 'owner-a',
    kind: 'relia-two-step',
    idempotencyKey: 'create-x',
    steps: markerSteps(work, runs),
    result: () => ({ made: -1 }),
  })
  ok(
    again.outcome === 'replayed' && (again.result as { made: number }).made === 2,
    '§2 the same idempotency key replays the PRIOR committed result',
  )
  ok(runs.s1 === 1 && runs.s2 === 1, '§2 no step re-executed on replay')
}

{
  const dir = join(tmp, 'j3')
  const work = join(tmp, 'w3')
  mkdirSync(work, { recursive: true })
  let threw = false
  try {
    await runJournaledOperation({
      journalDir: dir,
      ownerKey: 'owner-a',
      kind: 'relia-two-step',
      idempotencyKey: 'fails-once',
      steps: [
        {
          id: 's1',
          target: join(work, 'marker-1'),
          run: async () => {
            writeFileSync(join(work, 'marker-1'), 'one')
          },
        },
        {
          id: 's2',
          target: join(work, 'marker-2'),
          run: async () => {
            throw new Error('step 2 exploded')
          },
        },
      ],
      compensate: async () => wipeMarkers(work),
    })
  } catch {
    threw = true
  }
  const ops = await listJournalOperations(dir)
  ok(
    threw && ops.length === 1 && ops[0]!.state === 'aborted' && !existsSync(join(work, 'marker-1')),
    '§3 a thrown step compensates (partial marker removed) and aborts durably',
  )
  const runs = { s1: 0, s2: 0 }
  const retry = await runJournaledOperation({
    journalDir: dir,
    ownerKey: 'owner-a',
    kind: 'relia-two-step',
    idempotencyKey: 'fails-once',
    steps: markerSteps(work, runs),
    result: () => ({ made: 2 }),
  })
  ok(retry.outcome === 'committed', '§3 an aborted key is re-runnable (fresh operation commits)')
}

{
  const handlers = (work: string) => ({
    'relia-two-step': {
      rollForward: async () => {
        writeFileSync(join(work, 'marker-1'), 'one')
        writeFileSync(join(work, 'marker-2'), 'two')
      },
      compensate: async () => wipeMarkers(work),
    },
  })
  const boundaries: Array<{
    fault: string
    expect: 'compensated' | 'rolledForward'
  }> = [
    { fault: 'journal-after-prepare:kill', expect: 'compensated' },
    { fault: 'journal-before-step@#s2:kill', expect: 'compensated' },
    { fault: 'journal-before-commit:kill', expect: 'rolledForward' },
  ]
  for (const b of boundaries) {
    const dir = join(tmp, `j4-${b.expect}-${b.fault.replace(/[^a-z0-9]/gi, '')}`)
    const work = `${dir}-work`
    mkdirSync(work, { recursive: true })
    const res = spawnSync(BUN, ['run', CHILD], {
      env: {
        ...process.env,
        RELIA_JOURNAL_DIR: dir,
        RELIA_WORK_DIR: work,
        RELIA_KEY: 'killed-op',
        MERCURY_FAULT_INJECT: b.fault,
      },
      encoding: 'utf8',
      timeout: 20_000,
    })
    ok(res.signal === 'SIGKILL', `§4 [${b.fault}] child died at the boundary`)
    const summary = await recoverJournalDir(dir, handlers(work))
    const ops = await listJournalOperations(dir)
    if (b.expect === 'compensated') {
      ok(
        summary.compensated.length === 1 &&
          ops[0]!.state === 'aborted' &&
          !existsSync(join(work, 'marker-1')) &&
          !existsSync(join(work, 'marker-2')),
        `§4 [${b.fault}] recovery COMPENSATED — no partial materialization survives`,
      )
    } else {
      ok(
        summary.rolledForward.length === 1 &&
          ops[0]!.state === 'committed' &&
          readFileSync(join(work, 'marker-2'), 'utf8') === 'two',
        `§4 [${b.fault}] recovery ROLLED FORWARD — the fully-applied op completed`,
      )
    }
    const second = await recoverJournalDir(dir, handlers(work))
    ok(
      second.compensated.length === 0 && second.rolledForward.length === 0,
      `§4 [${b.fault}] a second recovery pass is a no-op`,
    )
  }
}

{
  const dir = join(tmp, 'j5')
  const work = join(tmp, 'w5')
  mkdirSync(work, { recursive: true })
  spawnSync(BUN, ['run', CHILD], {
    env: {
      ...process.env,
      RELIA_JOURNAL_DIR: dir,
      RELIA_WORK_DIR: work,
      RELIA_KEY: 'resume-me',
      MERCURY_FAULT_INJECT: 'journal-before-step@#s2:kill',
    },
    encoding: 'utf8',
    timeout: 20_000,
  })
  const RECOVER_CHILD = join(import.meta.dir, 'helpers', 'journalRecoverChild.ts')
  const killed = spawnSync(BUN, ['run', RECOVER_CHILD], {
    env: {
      ...process.env,
      RELIA_JOURNAL_DIR: dir,
      RELIA_WORK_DIR: work,
      MERCURY_FAULT_INJECT: 'journal-recover-op:kill',
    },
    encoding: 'utf8',
    timeout: 20_000,
  })
  ok(killed.signal === 'SIGKILL', '§5 recovery child died mid-recovery')
  const summary = await recoverJournalDir(dir, {
    'relia-two-step': { compensate: async () => wipeMarkers(work) },
  })
  const ops = await listJournalOperations(dir)
  ok(
    summary.compensated.length === 1 && ops[0]!.state === 'aborted',
    '§5 a re-run recovery converges (compensated → aborted)',
  )
}

{
  const dir = join(tmp, 'j6')
  mkdirSync(dir, { recursive: true })
  const child = Bun.spawn([BUN, '-e', 'setTimeout(() => {}, 30_000)'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    const crafted: DurableOperation = {
      schema: 1,
      operationId: 'live-op-1',
      ownerKey: 'owner-a',
      kind: 'relia-two-step',
      idempotencyKey: 'busy-key',
      state: 'applying',
      steps: [{ id: 's1', target: 'x', state: 'pending' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      writerPid: child.pid,
    }
    writeFileSync(join(dir, 'op-live-op-1.json'), JSON.stringify(crafted))
    const res = await runJournaledOperation({
      journalDir: dir,
      ownerKey: 'owner-a',
      kind: 'relia-two-step',
      idempotencyKey: 'busy-key',
      steps: [],
      result: () => null,
    })
    ok(res.outcome === 'in-flight', '§6 a live writer’s incomplete op yields in-flight (never raced)')
  } finally {
    child.kill()
  }
  const dirB = join(tmp, 'j6b')
  mkdirSync(dirB, { recursive: true })
  const ghost: DurableOperation = {
    schema: 1,
    operationId: 'ghost-op-1',
    ownerKey: 'owner-a',
    kind: 'relia-two-step',
    idempotencyKey: 'ghost-key',
    state: 'applying',
    steps: [{ id: 's1', target: 'x', state: 'pending' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    writerPid: process.pid,
  }
  writeFileSync(join(dirB, 'op-ghost-op-1.json'), JSON.stringify(ghost))
  const resB = await runJournaledOperation({
    journalDir: dirB,
    ownerKey: 'owner-a',
    kind: 'relia-two-step',
    idempotencyKey: 'ghost-key',
    steps: [],
    result: () => null,
  })
  const ghostAfter = (await listJournalOperations(dirB)).find(o => o.operationId === 'ghost-op-1')
  ok(
    resB.outcome === 'committed' && ghostAfter?.state === 'aborted',
    '§6b a pid-reuse leftover (same pid, unregistered) is recovered and the new run proceeds',
  )
}

{
  const dir = join(tmp, 'j7')
  const work = join(tmp, 'w7')
  mkdirSync(work, { recursive: true })
  for (let i = 0; i < 8; i++) {
    const runs = { s1: 0, s2: 0 }
    await runJournaledOperation({
      journalDir: dir,
      ownerKey: 'owner-a',
      kind: 'relia-two-step',
      idempotencyKey: `op-${i}`,
      steps: markerSteps(work, runs),
    })
  }
  const crafted: DurableOperation = {
    schema: 1,
    operationId: 'incomplete-1',
    ownerKey: 'owner-a',
    kind: 'relia-two-step',
    idempotencyKey: 'incomplete-key',
    state: 'applying',
    steps: [{ id: 's1', target: 'x', state: 'pending' }],
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    writerPid: 999999,
  }
  writeFileSync(join(dir, 'op-incomplete-1.json'), JSON.stringify(crafted))
  const removed = await compactJournalDir(dir, { keepTerminal: 3 })
  const after = await listJournalOperations(dir)
  ok(
    removed === 5 &&
      after.filter(o => o.state === 'committed').length === 3 &&
      after.some(o => o.operationId === 'incomplete-1'),
    `§7 compaction removed ${removed}/5 oldest terminal ops and kept the incomplete one`,
  )
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS prove-operation-journal' : `\nFAIL prove-operation-journal (${failures})`)
process.exit(failures === 0 ? 0 : 1)
