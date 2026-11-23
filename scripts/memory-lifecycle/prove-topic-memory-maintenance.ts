#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { appendObservation, readBuffer } = await import('../../src/sessions/mneme/mnemeBuffer.ts')
const { listTopicDocs, maybeConsolidate } = await import('../../src/sessions/mneme/mnemeConsolidate.ts')
const { dueForMaintenance, mnemeStatus, readMaintenanceReceipts, runDueMaintenance } = await import(
  '../../src/sessions/mneme/mnemeMaintenance.ts'
)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 age-due fires WITHOUT a new observation (the age-due class)')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-mnt1-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'current.jsonl'),
    JSON.stringify({ ts: new Date(Date.now() - 25 * 3600_000).toISOString(), source: 'old-session', text: 'aged fact', topicHint: 'aging' }) + '\n',
  )
  const due = dueForMaintenance(dir)
  check('due by age, no new observation needed', due.due && /age/.test(due.reason ?? ''), JSON.stringify(due) + ' — dueForMaintenance in src/sessions/mneme/mnemeMaintenance.ts must report an age reason for a buffer row older than a day')
  const out = await runDueMaintenance('boot', { dir })
  check('boot maintenance ran and consolidated', out.ran && out.consolidated === true, JSON.stringify(out) + ' — runDueMaintenance in src/sessions/mneme/mnemeMaintenance.ts must consolidate when the buffer is age-due')
  check('the aged fact is in a topic doc', listTopicDocs(dir).some(d => d.slug === 'aging'), 'maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must write the aged row into topic-aging.md')
  check('a receipt row landed', readMaintenanceReceipts(dir).some(r => r.trigger === 'boot' && r.ran), 'runDueMaintenance in src/sessions/mneme/mnemeMaintenance.ts must record a receipt for each run')
  const idle = await runDueMaintenance('turn-end', { dir })
  check('quiet when nothing is due', idle.ran === false && idle.reason === 'not due', JSON.stringify(idle) + ' — runDueMaintenance in src/sessions/mneme/mnemeMaintenance.ts must return ran false with reason not due when dueForMaintenance is false')
}

section('§2 dead-holder lock reaped fast; LIVE holder respected')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-mnt2-'))
  appendObservation({ text: 'fact behind a dead lock', source: 's', topicHint: 'locks' }, dir)
  const deadPid = await new Promise<number>(res => {
    const c = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    c.on('close', () => res(c.pid!))
  })
  const lock = join(dir, '.consolidate.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'pid'), String(deadPid))
  const old = new Date(Date.now() - 30_000)
  utimesSync(lock, old, old)
  const s1 = mnemeStatus(dir)
  check('status names the dead-lock degradation', s1.degraded.some(d => d.includes('dead process')), JSON.stringify(s1.degraded) + ' — mnemeStatus in src/sessions/mneme/mnemeMaintenance.ts must list a degraded line naming the dead process that holds the lock')
  const out = await runDueMaintenance('turn-end', { dir, force: true })
  check('maintenance reaped the dead lock and consolidated', out.ran && out.consolidated === true, JSON.stringify(out) + ' — runDueMaintenance in src/sessions/mneme/mnemeMaintenance.ts must reap a lock whose pid is dead and then consolidate')
  check('lock gone', !existsSync(lock), 'the .consolidate.lock directory was left behind; check the lock reaping in src/sessions/mneme/mnemeConsolidate.ts')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'pid'), String(process.pid))
  appendObservation({ text: 'fact behind a live lock', source: 's', topicHint: 'locks' }, dir)
  const r = maybeConsolidate({ force: true, dir })
  check('live fresh holder → back off (lock held)', !r.consolidated && /lock held/.test(r.reason), r.reason + ' — maybeConsolidate in src/sessions/mneme/mnemeConsolidate.ts must back off with a lock held reason while the lock holder is alive')
  const { rmSync } = await import('node:fs')
  rmSync(lock, { recursive: true, force: true })
}

section('§3 crash recovery is EXACTLY-ONCE (manifest dedup; §F dup → 0)')
{
  const ROUNDS = 12
  const N = 60
  let killedMid = 0
  let lost = 0
  let dup = 0
  let collisions = 0
  for (let round = 0; round < ROUNDS; round++) {
    const dir = mkdtempSync(join(tmpdir(), 'mneme-mnt3-'))
    for (let i = 0; i < N; i++) appendObservation({ text: `crashfact r${round} n${i}`, source: 'bench', topicHint: `t${i % 6}` }, dir)
    const killAfter = round % 5
    const finished = await new Promise<boolean>(res => {
      const c = spawn(process.execPath, ['run', join(import.meta.dir, 'bench', 'child-consolidate.ts'), dir], { stdio: ['ignore', 'pipe', 'pipe'] })
      let armed = false
      c.stdout.on('data', (d: Buffer) => {
        if (!armed && String(d).includes('START')) {
          armed = true
          setTimeout(() => c.kill('SIGKILL'), killAfter)
        }
      })
      const hardStop = setTimeout(() => c.kill('SIGKILL'), 10_000)
      c.on('close', (code, signal) => {
        clearTimeout(hardStop)
        res(signal === null && code === 0)
      })
    })
    if (!finished) killedMid++
    const lock = join(dir, '.consolidate.lock')
    if (existsSync(lock)) {
      const old = new Date(Date.now() - 30_000)
      utimesSync(lock, old, old)
    }
    await runDueMaintenance('boot', { dir, force: true })
    const texts = new Map<string, number>()
    for (const d of listTopicDocs(dir)) {
      const raw = readFileSync(join(dir, `topic-${d.slug}.md`), 'utf8')
      for (const m of raw.matchAll(/(crashfact r\d+ n\d+)/g)) texts.set(m[1]!, (texts.get(m[1]!) ?? 0) + 1)
    }
    for (const r of readBuffer(dir)) {
      const m = r.text.match(/^(crashfact r\d+ n\d+)/)
      if (m) texts.set(m[1]!, (texts.get(m[1]!) ?? 0) + 1)
    }
    for (const f of readdirSync(dir).filter(n => /^consuming-.*\.jsonl$/.test(n))) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        const m = line.match(/"text":"(crashfact r\d+ n\d+)/)
        if (m) texts.set(m[1]!, (texts.get(m[1]!) ?? 0) + 1)
      }
    }
    const seqs: number[] = []
    for (const d of listTopicDocs(dir)) {
      const raw = readFileSync(join(dir, `topic-${d.slug}.md`), 'utf8')
      for (const m of raw.matchAll(/<seq=(\d+)/g)) seqs.push(Number(m[1]))
    }
    collisions += seqs.length - new Set(seqs).size
    for (let i = 0; i < N; i++) {
      const n = texts.get(`crashfact r${round} n${i}`) ?? 0
      if (n === 0) lost++
      if (n > 1) dup += n - 1
    }
  }
  check(`kills landed mid-run (${killedMid}/${ROUNDS} ≥ 8)`, killedMid >= 8, String(killedMid) + ' — too few child runs were killed mid-consolidation; check scripts/memory-lifecycle/bench/child-consolidate.ts and the kill delay in this proof')
  check('ZERO lost across all rounds', lost === 0, String(lost) + ' — observations vanished after a killed consolidation; check crash recovery of the consuming-*.jsonl files in src/sessions/mneme/mnemeConsolidate.ts')
  check('ZERO duplicated across all rounds (exactly-once — was 150 before)', dup === 0, String(dup) + ' — observations were written twice after a killed consolidation; check the manifest dedup in src/sessions/mneme/mnemeConsolidate.ts')
  check('ZERO seq collisions', collisions === 0, String(collisions) + ' — two topic entries share a seq; check how seq numbers are assigned in src/sessions/mneme/mnemeConsolidate.ts')
}

section('§4 status shape + receipts ring bound + OFF contract')
{
  const dir = mkdtempSync(join(tmpdir(), 'mneme-mnt4-'))
  appendObservation({ text: 'status fact', source: 's', topicHint: 'status' }, dir)
  const s = mnemeStatus(dir)
  check('status: enabled, buffered=1, 0 topics, not running', s.enabled && s.buffered === 1 && s.topicCount === 0 && !s.running, JSON.stringify(s) + ' — mnemeStatus in src/sessions/mneme/mnemeMaintenance.ts must report enabled, one buffered row, no topics and not running for a fresh library')
  for (let i = 0; i < 60; i++) await runDueMaintenance('operator', { dir, force: true })
  check('receipts ring bounded ≤50', readMaintenanceReceipts(dir, 500).length <= 50, 'the receipt ring (RECEIPT_RING in src/sessions/mneme/mnemeMaintenance.ts) must keep at most 50 rows')
  process.env.MERCURY_BARE = '1'
  const off = mnemeStatus(dir)
  check('OFF: status inert', off.enabled === false && off.buffered === 0, JSON.stringify(off) + ' — mnemeStatus in src/sessions/mneme/mnemeMaintenance.ts must report memory off with MERCURY_BARE=1')
  const offRun = await runDueMaintenance('boot', { dir })
  check('OFF: runner refuses', offRun.ran === false && offRun.reason === 'memory off', JSON.stringify(offRun) + ' — runDueMaintenance in src/sessions/mneme/mnemeMaintenance.ts must refuse with reason memory off when memory is off')
  check('OFF: due-check inert', dueForMaintenance(dir).due === false, 'dueForMaintenance in src/sessions/mneme/mnemeMaintenance.ts must return due false when memory is off')
  delete process.env.MERCURY_BARE
  }

if (failures) {
  console.log(`\n❌ ${failures} maintenance check(s) failed`)
  process.exit(1)
}
console.log('\n✅ ALL MEMORY MAINTENANCE PROOFS PASS')
