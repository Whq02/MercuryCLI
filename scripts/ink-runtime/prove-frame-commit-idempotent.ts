#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'frame-commit-home-'))
process.env.MERCURY_FLUX_PROBE = '1'
for (const pin of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) {
  process.env[pin] = '0'
}
const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const React = (await import('react')).default
const { render, Text } = await import(join(ROOT, 'src/ink.ts'))
const instances = (await import(join(ROOT, 'src/ink/instances.ts'))).default
const { FrameLedger } = await import(join(ROOT, 'src/ink/root/frame-ledger.ts'))
const { fluxSummary } = await import(join(ROOT, 'src/utils/flux/fluxProbe.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()

let bytes = ''
const stdout = Object.assign(
  new Writable({
    write(chunk: Buffer, _enc, cb) {
      bytes += chunk.toString()
      cb()
    },
  }),
  { columns: 80, rows: 24, isTTY: true },
) as unknown as NodeJS.WriteStream
const stdin = Object.assign(new Readable({ read() {} }), {
  isTTY: true,
  isRaw: false,
  setRawMode() {
    return this
  },
  ref() {},
  unref() {},
}) as unknown as NodeJS.ReadStream
const settle = (ms = 250): Promise<void> => new Promise(r => setTimeout(r, ms))
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const recommits = (): number => fluxSummary().counters['frame-recommit'] ?? 0

section('§1 the real renderer: the same cells again open no generation')
{
  const instance = await render(h(Text as never, null, 'the same words on the same row'), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  await settle()
  const inst = instances.get(stdout) as unknown as { ledger: InstanceType<typeof FrameLedger> } | undefined
  const glyphs = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, '')
  check('the instance mounted on the terminal-shaped stream', inst !== undefined && glyphs(bytes).includes('thesamewords'), JSON.stringify(bytes.slice(0, 80)))
  const ledger = inst!.ledger
  const seq = ledger.frontSeq()
  const framesBefore = fluxSummary().frames.total
  const recommitsBefore = recommits()
  instance.rerender(h(Text as never, null, 'the same words on the same row'))
  await settle()
  check('a re-render that composes the same cells still composed a frame', fluxSummary().frames.total > framesBefore, `${fluxSummary().frames.total} vs ${framesBefore}`)
  check('…but opened no generation (the commit is idempotent per frame)', ledger.frontSeq() === seq, `${ledger.frontSeq()} vs ${seq}`)
  check('…and was counted as a re-commit on the probe ring', recommits() > recommitsBefore, `${recommits()} vs ${recommitsBefore}`)
  check('the generations stay in step (no stale-base risk from a re-commit)', ledger.frontSeq() === ledger.deliveredGeneration() && !ledger.isContaminated())
  const bytesBefore = bytes.length
  instance.rerender(h(Text as never, null, 'different words on the row'))
  await settle()
  check('a changed frame advances exactly one generation and writes', ledger.frontSeq() === seq + 1 && bytes.length > bytesBefore, `${ledger.frontSeq()} vs ${seq + 1}`)
  instance.unmount()
  await settle()
}

section('§2 the ledger\'s own law')
{
  const led = new FrameLedger()
  led.commitFrame()
  led.settle(true, null)
  const front = led.frontSeq()
  led.commitFrame(false)
  led.settle(true, null)
  check('an unchanged commit keeps front and delivered in step', led.frontSeq() === front && led.deliveredGeneration() === front && !led.isContaminated())
  led.commitFrame(true)
  check('a changed commit advances', led.frontSeq() === front + 1)
}

console.log(failures === 0 ? '\nprove-frame-commit-idempotent: ALL LAWS HOLD' : `\nprove-frame-commit-idempotent: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
