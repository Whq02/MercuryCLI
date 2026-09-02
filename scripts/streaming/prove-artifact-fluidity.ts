#!/usr/bin/env bun

import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DIST, runArtifactArena } from './artifactArena.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── FLUX S11 built-artifact fluidity circuit (staged out-of-repo copy) ──')

const stage = mkdtempSync(join(tmpdir(), 'flux-circuit-dist-'))
cpSync(dirname(DIST), stage, { recursive: true })
const stagedDist = join(stage, 'mercury.mjs')

{
  const SENTS = ['aurora', 'basalt', 'cinder', 'dunes', 'ember']
  const deltas: string[] = []
  for (let i = 0; i < 100; i++) {
    if (i % 20 === 10) deltas.push(`${SENTS[Math.floor(i / 20)]} `)
    else deltas.push(i % 5 === 4 ? `w${i}.\n` : `w${i} `)
  }
  const run = await runArtifactArena({
    distPath: stagedDist,
    turns: [{ kind: 'paced', deltas, gapMs: 40, whenModel: 'opus' }],
    sends: ['4500:hello', '5300:\\r', '7300:Ξ'],
    seconds: 13,
    keep: true,
    rows: 44,
  })
  const submitTs = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString() === '\r')?.sent ?? 0
  const ackWrite = run.teeLines.find(t => t.ts > submitTs)
  check('A1 immediate start ack (paint ≤500ms after submit)', ackWrite !== undefined && ackWrite.ts - submitTs <= 500, `${ackWrite ? ackWrite.ts - submitTs : '-'}ms`)

  const firstEmit = run.fixture.pacedEmits[0]
  const vis = run.teeLines.map(t => ({ ts: t.ts, v: (t.content ?? '').replace(/\x1b\[[0-9;?<=>]*[A-Za-z@`~]/g, '') }))
  const firstHit = firstEmit ? vis.find(t => t.ts >= firstEmit.at && t.v.includes('w0')) : undefined
  check('A2 first-output flush (≤400ms after provider emit)', firstEmit !== undefined && firstHit !== undefined && firstHit.ts - firstEmit.at <= 400, `${firstHit && firstEmit ? firstHit.ts - firstEmit.at : '-'}ms`)

  const glyphSend = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString() === 'Ξ')
  const echoHit = glyphSend ? vis.find(t => t.ts >= glyphSend.sent && t.v.includes('Ξ')) : undefined
  check('A4 live composer during stream (echo ≤150ms)', glyphSend !== undefined && echoHit !== undefined && echoHit.ts - glyphSend.sent <= 150, `${echoHit && glyphSend ? echoHit.ts - glyphSend.sent : '-'}ms`)

  const res = spawnSync('/usr/bin/python3', [join(HERE, 'screengrab.py'), run.paths.drive, '120', '44', '-1'], { encoding: 'utf8', timeout: 60_000 })
  const flat = (JSON.parse(res.stdout) as { screens: { rows: string[] }[] }).screens[0]!.rows.join('\n')
  const idxs = SENTS.map(w => flat.indexOf(w))
  check('A3 ordered coalesced text at settle (5 sentinels, in order)', idxs.every(i => i >= 0) && idxs.every((v, i) => i === 0 || v > idxs[i - 1]!), `idx=[${idxs}]`)
  run.cleanup()
}

{
  const run = await runArtifactArena({
    distPath: stagedDist,
    turns: [{ kind: 'hang', deltas: ['partial thought '], whenModel: 'opus' }],
    sends: ['4500:hello', '5300:\\r', 'after:partial thought:800:\\x1b'],
    seconds: 15,
    keep: true,
  })
  const res = spawnSync('/usr/bin/python3', [join(HERE, 'screengrab.py'), run.paths.drive, '120', '40', '-1'], { encoding: 'utf8', timeout: 60_000 })
  const flat = (JSON.parse(res.stdout) as { screens: { rows: string[] }[] }).screens[0]!.rows.join('\n')
  check('B1 cancel ack + honest settle', /[Ii]nterrupted/.test(flat) && flat.includes('partial thought'))
  check('B2 usable composer after cancel', /type a prompt|↵ sends|\? for shortcuts/.test(flat))
  run.cleanup()
}

rmSync(stage, { recursive: true, force: true })

console.log(failures === 0 ? '✅ FLUX artifact-fluidity GREEN' : `❌ FLUX artifact-fluidity RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
