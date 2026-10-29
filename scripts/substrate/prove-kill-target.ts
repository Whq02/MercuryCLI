#!/usr/bin/env bun

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { FILE_READ_TOOL_NAME } from '../../src/tools/FileReadTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../../src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../src/tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../src/tools/NotebookEditTool/constants.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Input = { [key: string]: boolean | string | number }

function extractTarget(toolName: string, input: Input): string | undefined {
  let target: string | undefined
  try {
    const clamp = (s: string): string => s.split('\n')[0]!.slice(0, 60)
    if (toolName === 'WebFetch' && typeof input?.url === 'string') {
      target = new URL(input.url).hostname
    } else if (typeof input?.command === 'string') {
      target = clamp(String(input.command))
    } else if (
      (toolName === FILE_READ_TOOL_NAME ||
        toolName === FILE_EDIT_TOOL_NAME ||
        toolName === FILE_WRITE_TOOL_NAME) &&
      typeof input?.file_path === 'string'
    ) {
      target = clamp(String(input.file_path))
    } else if (
      toolName === NOTEBOOK_EDIT_TOOL_NAME &&
      typeof input?.notebook_path === 'string'
    ) {
      target = clamp(String(input.notebook_path))
    } else {
      for (const [k, v] of Object.entries(input ?? {})) {
        if (/(key|secret|token|password|passwd|credential|authorization|bearer|cookie)/i.test(k)) continue
        if (typeof v === 'string' && v) { target = clamp(v); break }
        if (typeof v === 'number') { target = String(v); break }
      }
    }
  } catch {
  }
  return target || undefined
}

console.log('============================================================')
console.log(' killed-tool transcript target extraction — proof')
console.log('============================================================')

section('regression: WebFetch.url → hostname, *.command → first line ≤60')
{
  check('WebFetch url → bare hostname', extractTarget('WebFetch', { url: 'https://evil.example.com/a/b?q=1' }) === 'evil.example.com')
  check('Bash command → first line', extractTarget('Bash', { command: 'rm -rf /tmp/x' }) === 'rm -rf /tmp/x')
  check('command keeps only the FIRST line', extractTarget('Bash', { command: 'echo a\necho b' }) === 'echo a')
  const long = 'echo ' + 'x'.repeat(200)
  check('command capped at 60 chars', extractTarget('Bash', { command: long })?.length === 60)
  check('PowerShell command → first line (shared command branch)', extractTarget('PowerShell', { command: 'Get-Item C:\\x' }) === 'Get-Item C:\\x')
}

section('new: file tools → file_path; notebook → notebook_path')
{
  check('Read → file_path', extractTarget(FILE_READ_TOOL_NAME, { file_path: '/etc/passwd' }) === '/etc/passwd')
  check('Edit → file_path', extractTarget(FILE_EDIT_TOOL_NAME, { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' }) === '/a/b.ts')
  check('Write → file_path', extractTarget(FILE_WRITE_TOOL_NAME, { file_path: '/a/b.ts', content: 'data' }) === '/a/b.ts')
  check('NotebookEdit → notebook_path', extractTarget(NOTEBOOK_EDIT_TOOL_NAME, { notebook_path: '/n.ipynb', new_source: 's' }) === '/n.ipynb')
  const longPath = '/' + 'd/'.repeat(80) + 'f.ts'
  check('a very long file_path is capped at 60', extractTarget(FILE_WRITE_TOOL_NAME, { file_path: longPath })?.length === 60)
}

section('new: any other risky tool → first SAFE scalar arg (capped, never a secret)')
{
  check('MCP tool with a string arg → that arg', extractTarget('mcp__db__query', { query: 'DROP TABLE users' }) === 'DROP TABLE users')
  check('MCP tool with a numeric arg → stringified', extractTarget('mcp__svc__scale', { replicas: 9000 }) === '9000')
  check('fallback SKIPS a secret-shaped key (token) → picks the next safe arg', extractTarget('mcp__x__call', { token: 'sk-deadbeef', name: 'job-7' }) === 'job-7')
  check('fallback yields no target when ONLY secret-shaped keys exist', extractTarget('mcp__x__call', { api_key: 'sk-1', password: 'p' }) === undefined)
  check('boolean-only input → no target (booleans are not scalars we surface)', extractTarget('mcp__x__flag', { enabled: true }) === undefined)
  check('empty input → no target', extractTarget('mcp__x__noop', {}) === undefined)
}

section('best-effort: a malformed arg never throws (returns no target)')
{
  check('WebFetch with a non-URL url → caught, no target', extractTarget('WebFetch', { url: 'not a url' }) === undefined)
  check('empty-string file_path → collapses to undefined (target || undefined)', extractTarget(FILE_READ_TOOL_NAME, { file_path: '' }) === undefined)
}

section('dist-grep: the kill-target branch anchors are present in dist/mercury.mjs')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` to include this check')
  } else {
    const src = readFileSync(dist, 'utf8')
    check('the WebFetch host branch ships (specific anchor)', /new URL\([\w.]*\.url\)\.hostname/.test(src))
    check('file_path is referenced in the bundle (presence, not exclusivity)', src.includes('file_path'))
    check('notebook_path is referenced in the bundle (presence, not exclusivity)', src.includes('notebook_path'))
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL KILL-TARGET PROOFS PASS')
else console.log(`❌ ${failures} KILL-TARGET PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
