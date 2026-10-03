#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(realpathSync(tmpdir()), 'grep-foreign-flags-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { formatZodValidationError, parameterStandIn } = await import('../../src/utils/toolErrors.ts')
import type { z } from 'zod/v4'

const refusal = (tool: { name: string; inputSchema: { safeParse(input: unknown): { success: boolean; error?: unknown } }; inputJSONSchema?: unknown }, input: Record<string, unknown>): string => {
  const parsed = tool.inputSchema.safeParse(input)
  if (parsed.success) return 'ACCEPTED'
  return formatZodValidationError(tool.name, parsed.error as z.ZodError, tool.inputJSONSchema)
}

console.log("a grep flag the model reaches for is refused with the Mercury parameter that does the same thing, in the same line")
{
  const o = refusal(GrepTool, { pattern: 'main', '-o': true })
  check('`-o` is refused as not expected', o.includes('The parameter `-o` was not expected'), o)
  check('…and the same line names output_mode "content"', /^The parameter `-o` was not expected — output_mode "content" prints the matching lines$/m.test(o), o)
  const l = refusal(GrepTool, { pattern: 'main', '-l': true })
  check('`-l` names output_mode "files_with_matches"', l.includes('`-l` was not expected — output_mode "files_with_matches" lists the files that match'), l)
  const c = refusal(GrepTool, { pattern: 'main', '-c': true })
  check('`-c` names output_mode "count"', c.includes('`-c` was not expected — output_mode "count" counts the matches'), c)
  const include = refusal(GrepTool, { pattern: 'main', '--include': '*.ts' })
  check('`--include` names glob', include.includes('`--include` was not expected — glob narrows the files'), include)
  const two = refusal(GrepTool, { pattern: 'main', '-o': true, '-l': true })
  check('two foreign flags: one line each, each with its own stand-in', two.includes('`-o` was not expected — output_mode "content"') && two.includes('`-l` was not expected — output_mode "files_with_matches"'), two)
}

console.log('a name with no counterpart keeps the plain sentence; another tool gets no grep words')
{
  const bogus = refusal(GrepTool, { pattern: 'main', bogus: 1 })
  check('`bogus` is refused with the plain sentence and no stand-in', /^The parameter `bogus` was not expected$/m.test(bogus), bogus)
  const read = refusal(FileReadTool, { file_path: '/tmp/x', '-o': true })
  check('`-o` on Read carries no grep stand-in', /^The parameter `-o` was not expected$/m.test(read) && !read.includes('output_mode'), read)
  check('the stand-in table answers by tool and key', parameterStandIn('Grep', '-o') !== undefined && parameterStandIn('Read', '-o') === undefined && parameterStandIn('Grep', 'bogus') === undefined)
  check('the Grep tool still accepts its own parameters', refusal(GrepTool, { pattern: 'main', output_mode: 'content', '-n': true, '-i': true, glob: '*.ts' }) === 'ACCEPTED')
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-grep-foreign-flags: ${failures} FAILED`)
  process.exit(1)
}
console.log('\nprove-grep-foreign-flags: all green')
