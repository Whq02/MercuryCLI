#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'stream-json-bom-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = HOME

const { StructuredIO } = await import('../../src/cli/structuredIO.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function classify(chunks: string[]): Promise<{ types: string[]; exitCode: number | null }> {
  async function* input(): AsyncIterable<string> {
    for (const chunk of chunks) yield chunk
  }
  const realExit = process.exit
  let exitCode: number | null = null
  ;(process as { exit: (code?: number) => never }).exit = ((code?: number) => {
    exitCode = code ?? 0
    throw new Error('process.exit intercepted')
  }) as never
  const types: string[] = []
  try {
    const io = new StructuredIO(input(), false)
    for await (const message of io.structuredInput) types.push(String((message as { type?: string }).type))
  } catch {
  } finally {
    process.exit = realExit
  }
  return { types, exitCode }
}

const line = (text: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })

console.log('============================================================')
console.log(' stream-json input that starts with a UTF-8 byte order mark')
console.log('============================================================')

const crlf = await classify([`${line('a')}\r\n${line('b')}\r\n`])
check('CRLF-terminated lines classify as before', crlf.exitCode === null && crlf.types.join(',') === 'user,user', JSON.stringify(crlf))

const bom = await classify([`\uFEFF${line('bom first')}\r\n`])
check('a byte order mark on the first line is dropped and the line classifies', bom.exitCode === null && bom.types.join(',') === 'user', JSON.stringify(bom))

const split = await classify(['\uFEFF', `${line('bom split from its line')}\n`])
check('a byte order mark that arrives as its own first chunk is dropped too', split.exitCode === null && split.types.join(',') === 'user', JSON.stringify(split))

const second = await classify([`${line('one')}\r\n\uFEFF${line('two')}\r\n`])
check('a byte order mark in front of a later record is dropped', second.exitCode === null && second.types.join(',') === 'user,user', JSON.stringify(second))

const secondChunk = await classify([`${line('one')}\n`, `\uFEFF${line('two')}\n`])
check('a byte order mark that opens a later chunk is dropped', secondChunk.exitCode === null && secondChunk.types.join(',') === 'user,user', JSON.stringify(secondChunk))

const unterminated = await classify([`${line('one')}\n\uFEFF${line('two')}`])
check('a byte order mark on an unterminated last record is dropped', unterminated.exitCode === null && unterminated.types.join(',') === 'user,user', JSON.stringify(unterminated))

try {
  rmSync(HOME, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(failures === 0 ? '\nALL STREAM-JSON BOM CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
