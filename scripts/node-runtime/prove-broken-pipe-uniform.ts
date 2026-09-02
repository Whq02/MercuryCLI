#!/usr/bin/env bun
// ============================================================================
//  scripts/node-runtime/prove-broken-pipe-uniform.ts — ONE broken-pipe
//  outcome across the -p output formats (FC-077). A consumer that stopped
//  reading used to give the run two opposite answers: text/json ended exit 1
//  with the raw libuv `EPIPE: broken pipe, write` and no product context,
//  while stream-json's fire-and-forget writes swallowed the same failure —
//  exit 0, output silently lost. Now the StructuredIO writer latches the
//  broken pipe (named stderr line once, exit code 1, later writes no-op),
//  the final-output flushWrite folds into the same latch, and the settle
//  honors it over a clean turn.
//
//  §1 the vocabulary; §2 the latch, driven with a patched stdout writer;
//  §3 the print road rides it (call-shaped).
//
//  Run: ~/.bun/bin/bun run scripts/node-runtime/prove-broken-pipe-uniform.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const io = await import('../../src/cli/structuredIO.js')

console.log('§1 the vocabulary')
{
  const isBroken = (io as { isBrokenPipeError?: (e: unknown) => boolean }).isBrokenPipeError
  check('isBrokenPipeError is exported', typeof isBroken === 'function')
  if (isBroken) {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    const destroyed = Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' })
    const ended = Object.assign(new Error('after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' })
    const other = Object.assign(new Error('enoent'), { code: 'ENOENT' })
    check('EPIPE + both destroyed-stream spellings read broken; ENOENT does not',
      isBroken(epipe) && isBroken(destroyed) && isBroken(ended) && !isBroken(other))
  }
  check('the ONE shared sentence is exported (BROKEN_STDOUT_LINE)',
    typeof (io as { BROKEN_STDOUT_LINE?: string }).BROKEN_STDOUT_LINE === 'string' &&
      ((io as { BROKEN_STDOUT_LINE?: string }).BROKEN_STDOUT_LINE ?? '').includes('broken pipe'))
}

console.log('§2 the latch, driven')
{
  const { StructuredIO } = io as { StructuredIO: new (input: AsyncIterable<string>) => {
    write: (m: unknown) => Promise<void>
    stdoutPipeBroken?: boolean
  } }
  const empty: AsyncIterable<string> = { async *[Symbol.asyncIterator]() { /* nothing */ } }
  const instance = new StructuredIO(empty)

  const realStdoutWrite = process.stdout.write.bind(process.stdout)
  const realStderrWrite = process.stderr.write.bind(process.stderr)
  const realExitCode = process.exitCode
  let stdoutCalls = 0
  const stderrLines: string[] = []
  // The patched writers: stdout always EPIPEs; stderr records.
  ;(process.stdout as unknown as { write: unknown }).write = (
    _chunk: unknown,
    cb?: (error?: Error | null) => void,
  ): boolean => {
    stdoutCalls++
    cb?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    return false
  }
  ;(process.stderr as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    stderrLines.push(String(chunk))
    return true
  }
  let resolvedNotRejected = false
  try {
    await instance.write({ type: 'system' })
    resolvedNotRejected = true
  } catch {
    resolvedNotRejected = false
  }
  const callsAfterFirst = stdoutCalls
  let secondResolved = false
  try {
    await instance.write({ type: 'system' })
    secondResolved = true
  } catch {
    secondResolved = false
  }
  const exitCodeAfter = process.exitCode
  // restore before asserting (assertion output needs the real streams)
  ;(process.stdout as unknown as { write: unknown }).write = realStdoutWrite
  ;(process.stderr as unknown as { write: unknown }).write = realStderrWrite
  process.exitCode = realExitCode

  check('an EPIPE write RESOLVES (never a raw crash)', resolvedNotRejected)
  check('… latches the broken-pipe fact', instance.stdoutPipeBroken === true)
  check('… sets exit code 1', exitCodeAfter === 1)
  check('… says the named line on stderr exactly once',
    stderrLines.filter(l => l.includes('broken pipe')).length === 1,
    JSON.stringify(stderrLines))
  check('a later write no-ops without touching the dead stream',
    secondResolved && stdoutCalls === callsAfterFirst, `calls=${stdoutCalls}`)
}

console.log('§3 the print road rides it (call-shaped)')
{
  const printSrc = readFileSync(join(ROOT, 'src', 'cli', 'print.ts'), 'utf8')
  check('flushWrite folds broken pipes into the latch',
    /isBrokenPipeError\(error\)/.test(printSrc) && /markStdoutPipeBroken\(\)/.test(printSrc))
  check('the settle honors the latch over a clean turn',
    /failed \|\| io\.stdoutPipeBroken \? 1 : 0/.test(printSrc))
  const ioSrc = readFileSync(join(ROOT, 'src', 'cli', 'structuredIO.ts'), 'utf8')
  check('the stream-json writer is no longer fire-and-forget on failure (the latch lives in write)',
    /markStdoutPipeBroken\(\)/.test(ioSrc) && /isBrokenPipeError\(error\)/.test(ioSrc))
}

console.log(failures === 0 ? '\nprove-broken-pipe-uniform: all green' : `\nprove-broken-pipe-uniform: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
