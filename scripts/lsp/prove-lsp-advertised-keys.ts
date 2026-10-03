#!/usr/bin/env bun
import * as path from 'node:path'
import { armScratch, check, cleanup, finish, openToolDoor, section, TS_PROBE_FILES, TS_SIDECAR_ENTRY, writeProject } from './lspProofDoor.ts'

console.log('prove-lsp-advertised-keys — every key the LSP tool advertises is accepted by every operation')
console.log('  the model is handed one flat object schema; an operation that does not read a documented key drops it')
console.log('  (red on the base: the per-operation validators refused the documented keys as unrecognized)')

const scratch = armScratch('lsp-advertised-keys')
process.env.MERCURY_LSP_SIDECAR_ENTRY = TS_SIDECAR_ENTRY
const project = writeProject(scratch, 'project', TS_PROBE_FILES)
const door = await openToolDoor(project)
const { tool } = door
const here = path.join(project, 'lib.ts')

const samples: Record<string, unknown> = {
  filePath: here,
  line: 1,
  character: 1,
  query: 'budget',
  limit: 50,
  newName: 'spend',
  newPath: path.join(project, 'moved.ts'),
  apply: false,
  actionId: 'quickfix:0',
  actionIndex: 0,
  endLine: 1,
  endCharacter: 2,
  paths: [here],
  plan: 'lsp-0000',
  kind: 'quickfix',
  targetPath: path.join(project, 'target.ts'),
  method: 'textDocument/hover',
  params: '{}',
}
const required: Record<string, string[]> = {
  goToDefinition: ['filePath', 'line', 'character'],
  findReferences: ['filePath', 'line', 'character'],
  hover: ['filePath', 'line', 'character'],
  documentSymbol: ['filePath'],
  workspaceSymbol: ['query'],
  goToImplementation: ['filePath', 'line', 'character'],
  prepareCallHierarchy: ['filePath', 'line', 'character'],
  incomingCalls: ['filePath', 'line', 'character'],
  outgoingCalls: ['filePath', 'line', 'character'],
  diagnostics: ['filePath'],
  rename: ['filePath', 'line', 'character', 'newName'],
  codeActions: ['filePath', 'line', 'character'],
  switchSourceHeader: ['filePath'],
  typeDefinition: ['filePath', 'line', 'character'],
  serverStatus: [],
  workspaceDiagnostics: ['paths'],
  pathRename: ['filePath', 'newPath'],
  fixDiagnostic: ['filePath', 'line', 'character'],
  formatDocument: ['filePath'],
  formatRange: ['filePath', 'line', 'character', 'endLine', 'endCharacter'],
  organizeImports: ['filePath'],
  capabilities: ['filePath'],
  rawRequest: ['filePath', 'method'],
  moveSymbol: ['filePath', 'line', 'character', 'targetPath'],
}

section('§1 the model’s view: the advertised keys, read off the flat schema the model is handed')
const { zodToJsonSchema } = await import(path.join(import.meta.dir, '../../src/utils/zodToJsonSchema.ts'))
const advertised = zodToJsonSchema(tool.inputSchema as never) as { type?: string; properties?: Record<string, unknown>; additionalProperties?: unknown }
const advertisedKeys = Object.keys(advertised.properties ?? {}).filter(k => k !== 'operation')
check('the wire schema is one object (a union would not be accepted by the providers)', advertised.type === 'object', JSON.stringify(advertised.type))
check(`the schema advertises ${advertisedKeys.length} optional keys beside operation`, advertisedKeys.length >= 8, advertisedKeys.join(','))
check('every advertised key has a sample in this proof', advertisedKeys.every(k => k in samples), advertisedKeys.filter(k => !(k in samples)).join(','))
const operations = ((advertised.properties?.operation as { enum?: string[] } | undefined)?.enum ?? [])
check('the operation enum lists all 24 operations', operations.length === 24, `${operations.length}: ${operations.join(',')}`)

section('§2 every operation accepts every advertised key (the keys it does not read are dropped)')
for (const operation of operations) {
  const own = required[operation]
  if (own === undefined) {
    check(`${operation}: known to this proof`, false, 'add its required keys')
    continue
  }
  const everything: Record<string, unknown> = { operation }
  for (const key of advertisedKeys) everything[key] = samples[key]
  const verdict = await tool.validateInput!(everything as never, {} as never)
  check(`${operation} + every advertised key → accepted`, verdict.result === true, verdict.message ?? '')
}

section('§3 the Air’s exact call: workspaceDiagnostics + paths + the eight advertised keys, through the real tool door')
const air = { operation: 'workspaceDiagnostics', paths: [path.join(project, 'lib.ts'), path.join(project, 'main.ts')], filePath: project, line: 1, character: 1, limit: 50, apply: false, actionIndex: 0, endLine: 1, endCharacter: 1 }
const verdict = await tool.validateInput!(air as never, {} as never)
check('validateInput accepts the call', verdict.result === true, verdict.message ?? '')
const answer = await door.drive(air)
check('the call is not an error', answer.isError === false, answer.text.slice(0, 300))
check('…and answers with the TypeScript diagnostic (TS2322) from the real sidecar', /2322/.test(answer.text), answer.text.slice(0, 300))
check('the operation received only its own keys (no stray filePath echoed)', (answer.data as { filePath?: string } | null)?.filePath === '', JSON.stringify(answer.data?.filePath))
const again = await door.drive(air)
check('the same call answers the same way a second time (nothing to retry)', again.isError === false && /2322/.test(again.text), again.text.slice(0, 200))

section('§4 a genuinely unknown key is still refused, in detail, before the tool runs')
const frob = tool.inputSchema.safeParse({ ...air, frobnicate: true })
check('the flat schema refuses frobnicate', frob.success === false)
check('…naming the key', JSON.stringify(frob.error?.issues ?? []).includes('frobnicate'), JSON.stringify(frob.error?.issues ?? []).slice(0, 200))
const frobbed = await door.drive({ operation: 'workspaceDiagnostics', paths: [here], frobnicate: true })
check('through the door it is an error', frobbed.isError === true)
check('…whose text names frobnicate', /frobnicate/.test(frobbed.text), frobbed.text.slice(0, 200))

section('§6 the Air report’s regression: each payload against the advertised AND the runtime schema, and they agree')
const skin = path.join(project, 'lib.ts')
const airExact = { operation: 'workspaceDiagnostics', filePath: skin, line: 1, character: 1, limit: 30, apply: false, actionIndex: 0, endLine: 1, endCharacter: 1, paths: [skin] }
const airRetry = { operation: 'workspaceDiagnostics', line: 1, character: 1, limit: 30, apply: false, actionIndex: 0, endLine: 1, endCharacter: 1, paths: [skin] }
const payloads: Array<[string, Record<string, unknown>]> = [
  ['workspaceDiagnostics with paths', { operation: 'workspaceDiagnostics', paths: [skin] }],
  ['workspaceDiagnostics with paths and an irrelevant known field (line)', { operation: 'workspaceDiagnostics', paths: [skin], line: 1 }],
  ['serverStatus with only operation', { operation: 'serverStatus' }],
  ['the Air’s exact first call (eight keys, filePath included)', airExact],
  ['the Air’s retries (seven keys, no filePath)', airRetry],
]
for (const [label, payload] of payloads) {
  const advertisedOk = tool.inputSchema.safeParse(payload).success
  const runtime = await tool.validateInput!(payload as never, {} as never)
  check(`${label}: advertised ${advertisedOk ? 'accepts' : 'refuses'}, runtime ${runtime.result ? 'accepts' : 'refuses'} — they agree`, advertisedOk === true && runtime.result === true, runtime.message ?? '')
}
const exact = await door.drive(airExact)
check('the Air’s exact first call now answers with diagnostics', exact.isError === false && /1 file\(s\) checked/.test(exact.text), exact.text.slice(0, 200))
const retry = await door.drive(airRetry)
check('…and so does its retry shape', retry.isError === false && /1 file\(s\) checked/.test(retry.text), retry.text.slice(0, 200))
const status = await door.drive({ operation: 'serverStatus' })
check('serverStatus with only operation answers (no error)', status.isError === false && /mercury-ts/.test(status.text), status.text.slice(0, 200))

section('§5 a missing required key is still refused in detail')
const missing = await tool.validateInput!({ operation: 'workspaceDiagnostics', filePath: project, line: 1, character: 1 } as never, {} as never)
check('workspaceDiagnostics without paths is refused', missing.result === false)
check('…and the refusal names paths', /paths/.test(missing.message ?? ''), missing.message ?? '')
const noName = await tool.validateInput!({ operation: 'rename', filePath: here, line: 1, character: 14 } as never, {} as never)
check('rename without newName is refused', noName.result === false && /newName/.test(noName.message ?? ''), noName.message ?? '')

await door.close()
cleanup(scratch)
finish('prove-lsp-advertised-keys')
