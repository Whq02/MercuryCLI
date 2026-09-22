#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { findTranscripts, makeTally, readRecords, requireDist, runTurn, scratchWorld, seedScratchHome, startScriptedFixture, textScript } from '../lib/scratchSeat.ts'

requireDist()
const tally = makeTally('prove-persisted-body-shape')

type Rec = Record<string, unknown>
type Variant = { name: string; line: string; payload: (base: Rec) => Rec; expectRefused: boolean; env?: Record<string, string> }

const variants: Variant[] = [
  { name: 'A task_reminder attachment whose content is not a list', line: '97', expectRefused: false, env: { MERCURY_TASKS: '1' }, payload: () => ({ kind: 'attachment', attachmentType: 'task_reminder', fields: { content: 5 } }) },
  { name: 'B diagnostics attachment without its file list', line: '19', expectRefused: false, payload: () => ({ kind: 'attachment', attachmentType: 'diagnostics', fields: {} }) },
  { name: 'C stop-hook summary notice without its hook list', line: '84', expectRefused: false, payload: () => ({ kind: 'notice', noticeKind: 'stop_hook_summary', fields: { hookCount: 'many' } }) },
  { name: 'D output record whose content is a plain string', line: '63', expectRefused: true, payload: (b: Rec) => ({ ...(b.payload as Rec), content: 'a plain string where blocks belong' }) },
  { name: 'E output record with a text block that has no text', line: '99', expectRefused: true, payload: (b: Rec) => ({ ...(b.payload as Rec), content: [{ kind: 'text' }] }) },
  { name: 'F record with no payload at all', line: '98', expectRefused: true, payload: () => ({}) as Rec },
]

const only = process.argv.includes('--variant') ? process.argv[process.argv.indexOf('--variant') + 1] : undefined
for (const variant of variants) {
  if (only !== undefined && !variant.name.startsWith(`${only} `)) continue
  tally.section(`${variant.name} (vendor line ${variant.line})`)
  const { runHome, cwd } = scratchWorld('persisted-body-shape')
  seedScratchHome(runHome, cwd)
  const fixture = await startScriptedFixture(textScript('shape probe answered'))
  const first = await runTurn({ runHome, cwd, base: fixture.base, ask: 'shape probe first', extraEnv: variant.env })
  const sid = String(first.result?.session_id ?? '')
  const path = findTranscripts(runHome)[0]
  if (first.result?.subtype !== 'success' || !path) {
    tally.check('turn 1 settled and wrote a transcript', false, JSON.stringify(first.result).slice(0, 120))
    await fixture.close()
    continue
  }
  const records = readRecords(path)
  const outputs = records.filter(r => (r.payload as Rec)?.kind === 'output')
  const leaf = outputs[outputs.length - 1]!
  const maxOrdinal = Math.max(...records.map(r => Number(r.creationOrdinal ?? 0)), ...records.map(r => Number(r.updateOrdinal ?? 0)))
  const ordinal = String(maxOrdinal + 1)
  const injected: Rec = {
    schemaVersion: leaf.schemaVersion,
    recordId: randomUUID(),
    sessionId: leaf.sessionId,
    threadId: leaf.threadId,
    creationOrdinal: ordinal,
    updateOrdinal: ordinal,
    occurredAt: new Date().toISOString(),
    actor: (variant.payload(leaf) as Rec).kind === 'output' ? leaf.actor : { role: 'system' },
    source: { channel: 'sdk' },
    payload: variant.payload(leaf),
    parentId: leaf.recordId,
    annotations: { parentUuid: leaf.recordId, timestamp: new Date().toISOString() },
  }
  if (Object.keys(injected.payload as Rec).length === 0) delete injected.payload
  appendFileSync(path, `${JSON.stringify(injected)}\n`)
  const second = await runTurn({ runHome, cwd, base: fixture.base, ask: 'shape probe second', extraArgv: ['--resume', sid], extraEnv: variant.env })
  const ok = second.result?.subtype === 'success' && second.result?.session_id === sid
  const errorLine = second.stderr.split('\n').find(l => /TypeError|is not a function|Cannot read|undefined/.test(l)) ?? ''
  console.log(`  resume exit ${second.exitCode} · result ${JSON.stringify(second.result).slice(0, 140)}`)
  if (errorLine) console.log(`  stderr: ${errorLine.slice(0, 200)}`)
  tally.check(
    variant.expectRefused
      ? 'the record validator refuses the malformed record and the session resumes'
      : 'the malformed persisted body is thinned or ignored and the session resumes',
    ok,
    ok ? 'resumed' : `no success result (exit ${second.exitCode})`,
  )
  await fixture.close()
}
tally.finish()
