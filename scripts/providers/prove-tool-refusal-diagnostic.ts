#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tool-refusal-diagnostic-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' a refused tool call keeps its raw arguments for diagnosis')
console.log('============================================================')

const gate = await import('../../src/services/providers/toolCallGate.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const tools = [FileWriteTool] as never

const RAW = '{"file_path":"/Users/someone/Desktop/rpg-game.html"}'
const NOTE = "[local] the provider emitted a malformed tool call (Write): the arguments do not match the tool's input schema (The required parameter `content` is missing) — it was not executed."

section('R1 · a Write call missing its required content: the refusal note is unchanged, the record carries the raw arguments and their length')
{
  const [verdict] = gate.gateToolCalls(tools, [{ id: 'call_zdtu034j', name: 'Write', argumentsRaw: RAW, malformed: false }])
  check('the gate refuses on the schema', verdict !== undefined && !verdict.ok && verdict.refusal.code === 'schema', JSON.stringify(verdict))
  const refusal = verdict && !verdict.ok ? verdict.refusal : null
  check('the note the model reads is unchanged to the byte', refusal !== null && gate.toolCallRefusalNote('local', refusal) === NOTE, refusal ? gate.toolCallRefusalNote('local', refusal) : 'no refusal')
  check('the record carries the raw arguments', refusal?.argumentsRaw === RAW, JSON.stringify(refusal))
  check('the record carries their length', (refusal as { argumentsLength?: number } | null)?.argumentsLength === RAW.length, JSON.stringify(refusal))
  const diagnostic = typeof gate.toolCallRefusalDiagnostic === 'function' ? gate.toolCallRefusalDiagnostic(refusal!) : undefined
  check('the diagnostic line names the call, the code, the issue, the raw arguments and their length', diagnostic === `refused tool call Write (schema, call call_zdtu034j): The required parameter \`content\` is missing — raw arguments (${RAW.length} chars): ${RAW}`, diagnostic)
  check('the note never carries the raw arguments', !NOTE.includes('file_path') && !NOTE.includes('raw arguments'))
}

section('R2 · the raw arguments are bounded: the first 2,000 characters and the total length')
{
  const long = `{"file_path":"/tmp/x.html","content":"${'x'.repeat(6_000)}"}`
  const [verdict] = gate.gateToolCalls(tools, [{ id: 'call_long', name: 'Write', argumentsRaw: long.slice(0, -1), malformed: false }])
  const refusal = verdict && !verdict.ok ? verdict.refusal : null
  check('an unterminated 6k-character argument string is refused as invalid JSON', refusal?.code === 'invalid-json', JSON.stringify(refusal?.code))
  const diagnostic = typeof gate.toolCallRefusalDiagnostic === 'function' && refusal ? gate.toolCallRefusalDiagnostic(refusal) : ''
  check('the diagnostic carries the total length and the first 2,000 characters, no more', diagnostic.includes(`raw arguments (${long.length - 1} chars, the first 2000 shown): `) && diagnostic.endsWith(long.slice(0, 2_000)) && gate.REFUSAL_RAW_DIAGNOSTIC_CHARS === 2_000, diagnostic.slice(0, 160))
  check('the record itself keeps the whole raw bytes (the transcript record is the operator\'s, bounded by the wire) and their length', refusal?.argumentsRaw === long.slice(0, -1) && (refusal as { argumentsLength?: number } | null)?.argumentsLength === long.length - 1)
}

section('R3 · the wiring: the compat runtime logs the diagnostic at the refusal and the transcript record carries the refusal')
{
  const runtime = readFileSync(join(process.cwd(), 'src/services/providers/openaicompat/compatChatCallModel.ts'), 'utf8')
  check('the note minting logs the bounded diagnostic to the debug log, never into the note', /const note = toolCallRefusalNote\(profile\.lane, refusal\)\s*\n\s*logForDebugging\(`\[compat:\$\{profile\.lane\}\] \$\{toolCallRefusalDiagnostic\(refusal\)\}`/.test(runtime))
  check('the settled note message still carries the refusal record for the transcript', /message\.refusedToolCalls = \[refusal\]/.test(runtime))
  const message = readFileSync(join(process.cwd(), 'src/types/message.ts'), 'utf8')
  check('the refusal record type declares the length beside the raw bytes', /argumentsRaw: string\s*\n\s*argumentsLength\?: number/.test(message))
}

console.log(failures === 0 ? '\nprove-tool-refusal-diagnostic: all green' : `\nprove-tool-refusal-diagnostic: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
