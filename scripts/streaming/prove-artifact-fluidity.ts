#!/usr/bin/env bun

import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DIST, firstPtyVisibility, observedEmissionWindow, runArtifactArena } from './artifactArena.ts'

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
    sends: ['4500:hello', '5300:\\r', '7300:Ξ', '13500:Ψ'],
    seconds: 15,
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
  const emission = observedEmissionWindow(run.fixture.pacedEmits)
  check('A4 fixture: the paced emission was OBSERVED as an interval (first and last delta wall times)', emission !== null && emission.end - emission.start >= 2000, emission ? `${emission.end - emission.start}ms across ${run.fixture.pacedEmits.length} deltas` : 'no emits')
  check('A4 the glyph was sent INSIDE the observed emission interval (not merely at its planned tick)', glyphSend !== undefined && emission !== null && glyphSend.sent >= emission.start && glyphSend.sent <= emission.end, glyphSend && emission ? `sent ${glyphSend.sent - emission.start}ms after the first delta, ${emission.end - glyphSend.sent}ms before the last` : '-')
  check('A4 live composer during stream (echo ≤150ms)', glyphSend !== undefined && echoHit !== undefined && echoHit.ts - glyphSend.sent <= 150, `${echoHit && glyphSend ? echoHit.ts - glyphSend.sent : '-'}ms`)
  check('A4 …and the echo itself landed while deltas were still being emitted', echoHit !== undefined && emission !== null && echoHit.ts <= emission.end, echoHit && emission ? `echo ${emission.end - echoHit.ts}ms before the last delta` : '-')
  const ptyEcho = glyphSend ? firstPtyVisibility(run.ptyReads, 'Ξ', glyphSend.sent) : undefined
  check('A4 the driver READ the echo from the pty (physical visibility, not the enqueue-side tee)', ptyEcho !== undefined && ptyEcho.ts - (glyphSend?.sent ?? 0) <= 400, ptyEcho && glyphSend ? `${ptyEcho.ts - glyphSend.sent}ms` : 'never read back')
  const lateSend = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString() === 'Ψ')
  const lateEcho = lateSend ? vis.find(t => t.ts >= lateSend.sent && t.v.includes('Ψ')) : undefined
  check('A4 control: a glyph sent AFTER the stream finished echoes too, but its send sits outside the emission interval (the during-stream row cannot be satisfied by it)', lateSend !== undefined && lateEcho !== undefined && emission !== null && lateSend.sent > emission.end, lateSend && emission ? `sent ${lateSend.sent - emission.end}ms after the last delta` : '-')
  check('A4 control: a send stamped before the first delta would be refused by the same interval test', emission !== null && !((emission.start - 1000) >= emission.start))

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
    sends: ['4500:hello', '5300:\\r', 'after:partial thought:800:\\x1b', 'after:nterrupted:700:Ω'],
    seconds: 15,
    keep: true,
  })
  const res = spawnSync('/usr/bin/python3', [join(HERE, 'screengrab.py'), run.paths.drive, '120', '40', '-1'], { encoding: 'utf8', timeout: 60_000 })
  const flat = (JSON.parse(res.stdout) as { screens: { rows: string[] }[] }).screens[0]!.rows.join('\n')
  check('B1 cancel ack + honest settle', /[Ii]nterrupted/.test(flat) && flat.includes('partial thought'))
  check('B2 usable composer after cancel', /type a prompt|↵ sends|\? for shortcuts/.test(flat))
  const escSend = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString() === '\x1b')
  const postSend = run.sendLog.find(s => Buffer.from(s.b64, 'base64').toString() === 'Ω')
  const postVis = run.teeLines.map(t => ({ ts: t.ts, v: (t.content ?? '').replace(/\x1b\[[0-9;?<=>]*[A-Za-z@`~]/g, '') }))
  const postEcho = postSend ? postVis.find(t => t.ts >= postSend.sent && t.v.includes('Ω')) : undefined
  const postPty = postSend ? firstPtyVisibility(run.ptyReads, 'Ω', postSend.sent) : undefined
  check('B2 a distinct glyph typed AFTER the cancel was sent after the Esc, once the interrupt marker had painted', escSend !== undefined && postSend !== undefined && postSend.sent > escSend.sent, escSend && postSend ? `${postSend.sent - escSend.sent}ms after Esc` : '-')
  check('B2 …and it ECHOED (the composer accepts input, not merely shows help text)', postEcho !== undefined && postSend !== undefined && postEcho.ts - postSend.sent <= 400, postEcho && postSend ? `${postEcho.ts - postSend.sent}ms` : 'never echoed')
  check('B2 …read back from the pty by the driver', postPty !== undefined, postPty ? `${postPty.ts - (postSend?.sent ?? 0)}ms` : 'never read back')
  check('B2 …and the settled screen carries the typed glyph in the composer', flat.includes('Ω'))
  run.cleanup()
}

rmSync(stage, { recursive: true, force: true })

console.log(failures === 0 ? '✅ FLUX artifact-fluidity GREEN' : `❌ FLUX artifact-fluidity RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
