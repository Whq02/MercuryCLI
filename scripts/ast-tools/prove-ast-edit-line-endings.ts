#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, REPO } from './lib/harness.ts'

armEnvironment()

const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-edit-line-endings-'))
await enterRoot(root)
const tools = [AstSearchTool, AstEditTool]

interface Outcome {
  dry: string
  applied: boolean
  note: string
  bytes: string
}

async function rewrite(dir: string, file: string, source: string, pattern: string, replacement: string): Promise<Outcome> {
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, dir, file), source)
  const prover = await makeContext(tools, { allow: ['AstEdit'] })
  const dry = await drive(AstEditTool, { pattern, rewrite: replacement, path: dir }, prover)
  const token = /plan: (ae-[0-9a-f]{12})/.exec(dry.text)?.[1] ?? ''
  if (dry.isError || token === '') {
    return { dry: dry.text, applied: false, note: dry.text.slice(0, 240), bytes: readFileSync(join(root, dir, file), 'utf8') }
  }
  const applied = await drive(AstEditTool, { pattern, rewrite: replacement, path: dir, apply: true, plan: token }, prover)
  return {
    dry: dry.text,
    applied: !applied.isError && applied.data?.state === 'applied',
    note: applied.text.slice(0, 240),
    bytes: readFileSync(join(root, dir, file), 'utf8'),
  }
}

const show = (text: string): string => JSON.stringify(text)

const INI = '[section]\nkey = value\nother = 2\n'
const C = '#include <stdio.h>\n#define MAX 10\nint main(void) { return MAX; }\n'

section('§1 — a node that carries its own line ending keeps it when the rewrite is another shape')
{
  const ini = await rewrite('ini-lf', 'a.ini', INI, 'key = $V', 'key = changed')
  check('ini: the setting is rewritten and the next line stays its own line', ini.applied && ini.bytes === '[section]\nkey = changed\nother = 2\n', `${show(ini.bytes)} ${ini.note}`)
  check('ini: the dry run shows one line changed, the next untouched', ini.dry.includes('-key = value') && ini.dry.includes('+key = changed') && !ini.dry.includes('changedother'), ini.dry.slice(0, 400))

  const crlf = await rewrite('ini-crlf', 'a.ini', INI.replace(/\n/g, '\r\n'), 'key = $V', 'key = changed')
  check('ini with CRLF: the carriage return and the line feed both stay', crlf.applied && crlf.bytes === '[section]\r\nkey = changed\r\nother = 2\r\n', `${show(crlf.bytes)} ${crlf.note}`)

  const define = await rewrite('c-define', 'a.c', C, '#define MAX $V', '#define LIMIT ($V)')
  check('c: a #define rewritten to another shape does not swallow the next line', define.applied && define.bytes === '#include <stdio.h>\n#define LIMIT (10)\nint main(void) { return MAX; }\n', `${show(define.bytes)} ${define.note}`)

  const include = await rewrite('c-include', 'a.c', C, '#include <stdio.h>', '#include "local.h"')
  check('c: an #include rewritten to another shape applies, where it was refused as unparsable', include.applied && include.bytes === '#include "local.h"\n#define MAX 10\nint main(void) { return MAX; }\n', `${show(include.bytes)} ${include.note}`)

  const indented = await rewrite('ini-delete-indented-next', 'a.ini', '[section]\nkey = value\n  other = 2\n', 'key = $V', '')
  check('a deletion takes its own line and leaves the indentation of the line after it', indented.applied && indented.bytes === '[section]\n  other = 2\n', `${show(indented.bytes)} ${indented.note}`)
}

section('§2 — what was right stays byte for byte')
{
  const same = await rewrite('c-same-shape', 'a.c', C, '#define MAX $V', '#define LIMIT $V')
  check('a rewrite of the same shape as its pattern (the layout-keeping lane)', same.applied && same.bytes === '#include <stdio.h>\n#define LIMIT 10\nint main(void) { return MAX; }\n', `${show(same.bytes)} ${same.note}`)

  const gone = await rewrite('ini-delete', 'a.ini', INI, 'other = $V', '')
  check('a deletion takes the whole line', gone.applied && gone.bytes === '[section]\nkey = value\n', `${show(gone.bytes)} ${gone.note}`)

  const goneDefine = await rewrite('c-delete', 'a.c', C, '#define MAX $V', '')
  check('a deletion of a node that carries its line ending takes exactly that line', goneDefine.applied && goneDefine.bytes === '#include <stdio.h>\nint main(void) { return MAX; }\n', `${show(goneDefine.bytes)} ${goneDefine.note}`)

  const ended = await rewrite('ini-template-newline', 'a.ini', INI, 'key = $V', 'key = changed\n')
  check('a rewrite that ends in a line ending of its own leaves one line ending, not two', ended.applied && ended.bytes === '[section]\nkey = changed\nother = 2\n', `${show(ended.bytes)} ${ended.note}`)

  const midLine = await rewrite('ts-mid-line', 'a.ts', 'export const n = greet(1) + greet(2)\n', 'greet($X)', 'hello($X, 0)')
  check('a node that ends in the middle of a line', midLine.applied && midLine.bytes === 'export const n = hello(1, 0) + hello(2, 0)\n', `${show(midLine.bytes)} ${midLine.note}`)

  const crlf = await rewrite('js-crlf', 'a.js', 'function f(a) {\r\n  console.log(a)\r\n  return a\r\n}\r\n', 'console.log($X)', 'logger.info($X, 1)')
  check('a file with CRLF line endings whose nodes end before the line ending', crlf.applied && crlf.bytes === 'function f(a) {\r\n  logger.info(a, 1)\r\n  return a\r\n}\r\n', `${show(crlf.bytes)} ${crlf.note}`)
}

finish('AST EDIT LINE ENDINGS')
