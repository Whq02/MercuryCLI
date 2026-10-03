#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'rows-input-bom-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = HOME

const { StructuredIO } = await import('../../src/cli/structuredIO.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Run = { types: string[]; refused: string[]; exitCode: number | null }

async function classify(chunks: string[]): Promise<Run> {
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
  const refused: string[] = []
  try {
    const io = new StructuredIO(input(), text => refused.push(text))
    for await (const row of io.structuredInput) types.push(row.type)
  } catch {
  } finally {
    process.exit = realExit
  }
  return { types, refused, exitCode }
}

const line = (text: string): string => JSON.stringify({ type: 'prompt', content: text })
const clean = (run: Run, types: string): boolean => run.exitCode === null && run.refused.length === 0 && run.types.join(',') === types

console.log('============================================================')
console.log(' row input that starts with a UTF-8 byte order mark')
console.log('============================================================')

const crlf = await classify([`${line('a')}\r\n${line('b')}\r\n`])
check('CRLF-terminated lines classify as prompt rows', clean(crlf, 'prompt,prompt'), JSON.stringify(crlf))

const bom = await classify([`\uFEFF${line('bom first')}\r\n`])
check('a byte order mark on the first line is dropped and the line classifies', clean(bom, 'prompt'), JSON.stringify(bom))

const split = await classify(['\uFEFF', `${line('bom split from its line')}\n`])
check('a byte order mark that arrives as its own first chunk is dropped too', clean(split, 'prompt'), JSON.stringify(split))

const second = await classify([`${line('one')}\r\n\uFEFF${line('two')}\r\n`])
check('a byte order mark in front of a later row is dropped', clean(second, 'prompt,prompt'), JSON.stringify(second))

const secondChunk = await classify([`${line('one')}\n`, `\uFEFF${line('two')}\n`])
check('a byte order mark that opens a later chunk is dropped', clean(secondChunk, 'prompt,prompt'), JSON.stringify(secondChunk))

const unterminated = await classify([`${line('one')}\n\uFEFF${line('two')}`])
check('a byte order mark on an unterminated last row is dropped', clean(unterminated, 'prompt,prompt'), JSON.stringify(unterminated))

try {
  rmSync(HOME, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(failures === 0 ? '\nALL ROW INPUT BOM CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
