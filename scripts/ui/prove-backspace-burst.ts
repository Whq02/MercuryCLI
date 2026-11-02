#!/usr/bin/env bun
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { grabScreens, runArtifactArena } from '../streaming/artifactArena.ts'
import { posixPtyDriverOrSkip } from '../lib/captureDriver.ts'

posixPtyDriverOrSkip('backspace-burst')
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
const distPath = resolve(arg('--dist') ?? join(import.meta.dir, '../../dist/mercury.mjs'))
const evidence = arg('--evidence')
const only = arg('--case')
const command = `! for i in $(seq 1 35); do printf 'WHEEL_C_%02d\\n' "$i"; done`
type Case = { name: string; key: string; count: number; state: 'recall' | 'empty' | 'typed' | 'multiline'; paced?: boolean }
const cases: Case[] = [
  { name: 'del-recall', key: '\x7f', count: 90, state: 'recall' },
  { name: 'bs-recall', key: '\x08', count: 90, state: 'recall' },
  { name: 'csi-recall', key: '\x1b[127;1u', count: 90, state: 'recall' },
  { name: 'del-paced', key: '\x7f', count: 70, state: 'recall', paced: true },
  { name: 'del-empty', key: '\x7f', count: 90, state: 'empty' },
  { name: 'del-typed', key: '\x7f', count: 512, state: 'typed' },
  { name: 'del-multiline', key: '\x7f', count: 2048, state: 'multiline' },
]
const chosen = cases.filter(c => only === undefined || c.name === only)
if (chosen.length === 0) throw new Error(`unknown case ${only}`)
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
function errorReports(dir: string): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  return entries.flatMap(name => {
    const path = join(dir, String(name))
    if (String(name).endsWith('.jsonl') && dir.endsWith('errors')) return [readFileSync(path, 'utf8')]
    try { return errorReports(path) } catch { return [] }
  })
}
for (const c of chosen) {
  const marker = `U24_${c.name.replaceAll('-', '_').toUpperCase()}`
  const typed = `TYPED_${'abcdefghij'.repeat(30)}`
  const multiline = `FIRST_${'abcdefghij'.repeat(12)}\nSECOND_${'abcdefghij'.repeat(12)}`
  const seed = c.state === 'recall' ? '\x1b[A' : c.state === 'typed' ? typed : c.state === 'multiline' ? `\x1b[200~${multiline}\x1b[201~` : ''
  const sends: Parameters<typeof runArtifactArena>[0]['sends'] = [
    { awaitText: 'Type a prompt', text: command },
    { awaitText: '; done', text: '\r', afterPrevMs: 500 },
    { awaitText: ['WHEEL_C_35', 'Type a prompt'], text: seed, afterPrevMs: 500 },
  ]
  const beforeDelete = sends.length
  if (c.paced) {
    for (let i = 0; i < c.count; i++) sends.push({ awaitText: 'WHEEL_C_35', text: c.key, afterPrevMs: i === 0 ? 800 : 60, settleMs: 0 })
  } else sends.push({ awaitText: 'WHEEL_C_35', text: c.key.repeat(c.count), afterPrevMs: 800 })
  const markerStep = sends.length
  sends.push({ awaitText: 'WHEEL_C_35', text: marker, afterPrevMs: 3000, settleMs: 0 })
  sends.push({ awaitText: 'WHEEL_C_35', text: '\x7fZ', afterPrevMs: 1500, settleMs: 0 })
  sends.push({ awaitText: 'WHEEL_C_35', text: '', afterPrevMs: 1500, settleMs: 0 })
  const run = await runArtifactArena({ turns: [], sends, seconds: c.paced ? 27 : 23, cols: 120, rows: 30, keep: true, distPath })
  try {
    const final = grabScreens(run, 120, 30, [-1])[0]!
    const before = run.sendLog.find(s => s.step === beforeDelete)?.screen?.slice(-10).join('\n') ?? ''
    const deleted = run.sendLog.find(s => s.step === markerStep)?.screen?.slice(-10).join('\n') ?? ''
    const finalComposer = final.rows.slice(-10).join('\n')
    const expected = `${marker.slice(0, -1)}Z`
    const errors = errorReports(run.paths.home)
    check(`${c.name}: complete PTY capture, every send fired`, run.outcome.complete && run.outcome.report?.unfired.length === 0, JSON.stringify(run.outcome))
    const seedSeen = c.state === 'recall' ? before.includes('; done') : c.state === 'typed' ? before.includes('TYPED_') : c.state === 'multiline' ? before.includes('FIRST_') && before.includes('SECOND_') : before.includes('Type a prompt')
    check(`${c.name}: requested composer state painted before deleting`, seedSeen, before)
    check(`${c.name}: every Backspace sent in the requested write shape`, c.paced
      ? run.sendLog.filter(s => Buffer.from(s.b64, 'base64').toString() === c.key).length === c.count
      : run.sendLog.some(s => Buffer.from(s.b64, 'base64').toString() === c.key.repeat(c.count)))
    check(`${c.name}: burst deleted the whole draft`, deleted.includes('Type a prompt'), deleted)
    check(`${c.name}: later marker, Backspace and text all consumed`, finalComposer.includes(`❯ ${expected}`) && !finalComposer.includes(marker), finalComposer)
    check(`${c.name}: no caught React update-depth exception`, !errors.some(text => /React error #185|Maximum update depth/i.test(text)))
    if (evidence) {
      const dir = join(resolve(evidence), c.name)
      mkdirSync(dir, { recursive: true })
      cpSync(run.paths.drive, join(dir, 'drive.jsonl'))
      cpSync(run.paths.tee, join(dir, 'tee.jsonl'))
      writeFileSync(join(dir, 'result.json'), JSON.stringify({ case: c, outcome: run.outcome, sends: run.sendLog, final, errors }, null, 2))
      writeFileSync(join(dir, 'frame.txt'), final.rows.join('\n') + '\n')
    }
  } finally { run.cleanup() }
}
console.log(`backspace-burst: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exitCode = failures === 0 ? 0 : 1
