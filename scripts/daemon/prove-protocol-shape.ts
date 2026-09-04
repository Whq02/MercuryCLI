#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

export function extractWireShape(source: string): { ops: string[]; controlActions: string[] } {
  const opsStart = source.indexOf('export type DaemonOp =')
  const opsEnd = source.indexOf('\n\n', opsStart)
  const ops = Array.from(source.slice(opsStart, opsEnd).matchAll(/'([A-Za-z-]+)'/g), m => m[1]!)
  const reqStart = source.indexOf('export type DaemonRequest =')
  const ctlStart = source.indexOf("op: 'sessionControl'", reqStart)
  const actStart = source.indexOf('action:', ctlStart)
  const actEnd = source.indexOf('sessionId: string', actStart)
  const controlActions = Array.from(source.slice(actStart, actEnd).matchAll(/'([A-Za-z-]+)'/g), m => m[1]!)
  return { ops, controlActions }
}

export function wireShapeHash(shape: { ops: string[]; controlActions: string[] }): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(shape)).digest('hex')
}

const protocolPath = join(import.meta.dir, '..', '..', 'src', 'daemon', 'protocol.ts')
const source = readFileSync(protocolPath, 'utf8')
const shape = extractWireShape(source)
const hash = wireShapeHash(shape)
const proto = Number(/export const MERCURY_DAEMON_PROTO = (\d+)/.exec(source)?.[1] ?? NaN)
const registered = /export const DAEMON_PROTO_SHAPE = '([^']+)'/.exec(source)?.[1] ?? ''

if (process.argv.includes('--print')) {
  console.log(JSON.stringify({ proto, shape, hash }, null, 2))
  process.exit(0)
}

console.log('============================================================')
console.log(' Protocol shape — the version fact (a new verb bumps the proto)')
console.log('============================================================')
check('the op union was found and is non-trivial', shape.ops.length >= 20, `${shape.ops.length} ops`)
check('the concourseControl actions were found', shape.controlActions.length >= 15, `${shape.controlActions.length} actions`)
check(
  'the v2+v3+v5+v7 verbs are appended at the end of the union (never reordered)',
  shape.ops.slice(-9).join(',') === 'hello,restart-when-idle,sessionAdmit,sessionDispatch,sessionList,sessionRelease,sessionControl,sessionRewind,signIns',
  shape.ops.slice(-9).join(','),
)
check('every verb is unique', new Set([...shape.ops, ...shape.controlActions]).size === shape.ops.length + shape.controlActions.length)
check('MERCURY_DAEMON_PROTO is an integer ≥ 2 (the handshake wire)', Number.isInteger(proto) && proto >= 2, String(proto))
check(
  'the registered shape hash matches the verb set at this proto',
  registered === hash,
  registered === hash
    ? hash
    : `the wire verbs changed since DAEMON_PROTO_SHAPE was registered — bump MERCURY_DAEMON_PROTO (if a build at proto ${proto} was ever deployed) and set DAEMON_PROTO_SHAPE = '${hash}'`,
)
const socket = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'controlSocket.ts'), 'utf8')
const server = readFileSync(join(import.meta.dir, '..', '..', 'src', 'daemon', 'controlServer.ts'), 'utf8')
check('the RPC client stamps the negotiated proto (never a literal)', /outbound\.proto = protoToStamp\(\)/.test(socket) && !/proto: 1\b/.test(socket))
check('the server answers hello with MERCURY_DAEMON_PROTO and MIN_PROTO', /op: 'hello',\s*proto: MERCURY_DAEMON_PROTO,\s*minProto: MIN_PROTO/.test(server))
check('the server keeps hello outside the readiness and version gates', server.indexOf("if (op === 'hello')") !== -1 && server.indexOf("if (op === 'hello')") < server.indexOf('// --- readiness gate'))
check('every keyed op the client stamps is routed by the server (a case of its own, or the alias table onto one)', (() => {
  const stamped = Array.from(/const AUTH_STAMPED_OPS[^]*?\]\)/.exec(socket)?.[0].matchAll(/'([A-Za-z-]+)'/g) ?? [], m => m[1]!)
  const aliases = new Map(
    Array.from(/const SESSION_OP_ALIASES[^]*?\}/.exec(server)?.[0].matchAll(/([A-Za-z]+):\s*'([A-Za-z-]+)'/g) ?? [], m => [m[1]!, m[2]!]),
  )
  const routed = (op: string): boolean => server.includes(`case '${op}':`) || (aliases.has(op) && server.includes(`case '${aliases.get(op)}':`))
  const missing = stamped.filter(op => !routed(op))
  return stamped.length > 0 && missing.length === 0
})())

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PROTOCOL-SHAPE PROOFS PASS')
else console.log(`❌ ${failures} PROTOCOL-SHAPE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
