#!/usr/bin/env bun
// ============================================================================
//  scripts/blender-bridge/prove-blender-bridge-contract.ts
//  PROOF: the BLENDER-BRIDGE wire contract module is total and self-consistent —
//  the verb table whole, the class census exact, the code unions carrying the
//  contract's named arms, the python_run danger sentences pinned as contract,
//  the frame helpers total over hostile input. Pure cpu; no sockets, no
//  Blender, no network.
// ============================================================================

import {
  BLENDER_BRIDGE_PROTOCOL_VERSION,
  BLENDER_BRIDGE_DEFAULT_PORT,
  BLENDER_BRIDGE_MAX_LINE_BYTES,
  BLENDER_BRIDGE_OBJECTS_NODE_CAP,
  BLENDER_BRIDGE_REPORT_RING_CAP,
  BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES,
  BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES,
  BLENDER_PYTHON_RUN_NO_SANDBOX_SENTENCE,
  BLENDER_PYTHON_RUN_NO_PREEMPTION_SENTENCE,
  BLENDER_BRIDGE_SERVER_ERROR_CODES,
  BLENDER_BRIDGE_CLIENT_ERROR_CODES,
  BLENDER_BRIDGE_VERBS,
  BLENDER_BRIDGE_EVENTS,
  blenderBridgeVerb,
  blenderBridgeVerbNames,
  buildBlenderBridgeHelloFrame,
  buildBlenderBridgeRequestFrame,
  parseBlenderBridgeFrame,
} from '../../src/services/blender/bridgeProtocol.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('1. constants — the contract’s fixed points')
check('protocol version is 1', BLENDER_BRIDGE_PROTOCOL_VERSION === 1)
check(
  'default port 6012, outside the sibling family {6005, 6006, 6010, 6011}',
  BLENDER_BRIDGE_DEFAULT_PORT === 6012 &&
    ![6005, 6006, 6010, 6011].includes(BLENDER_BRIDGE_DEFAULT_PORT),
)
check('frame cap 8MiB (the vulcan bound)', BLENDER_BRIDGE_MAX_LINE_BYTES === 8 * 1024 * 1024)
check('objects cap bounded and sane', BLENDER_BRIDGE_OBJECTS_NODE_CAP === 2_000)
check('report ring cap bounded and sane', BLENDER_BRIDGE_REPORT_RING_CAP === 1_000)
check('python source cap 64KiB', BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES === 64 * 1024)
check('python output cap 32KiB', BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES === 32 * 1024)

section('2. the verb table — totality + class census')
{
  const names = blenderBridgeVerbNames()
  const expected = [
    'scene_info',
    'objects_list',
    'blend_open',
    'render_state',
    'render_still',
    'report_tail',
    'python_run',
  ]
  check(
    'exactly the seven verbs, in table order',
    JSON.stringify(names) === JSON.stringify(expected),
    names.join(','),
  )
  for (const name of names) {
    const spec = BLENDER_BRIDGE_VERBS[name]
    check(
      `${name}: lawful class + non-empty summary + string arg notes`,
      ['read', 'mutate', 'exec'].includes(spec.cls) &&
        spec.summary.length > 0 &&
        Object.values(spec.args).every(n => typeof n === 'string' && n.length > 0),
    )
  }
  const byClass = (cls: string) => names.filter(n => BLENDER_BRIDGE_VERBS[n].cls === cls).sort()
  check(
    'read class census',
    JSON.stringify(byClass('read')) ===
      JSON.stringify(['objects_list', 'render_state', 'report_tail', 'scene_info']),
    byClass('read').join(','),
  )
  check('mutate class census', JSON.stringify(byClass('mutate')) === JSON.stringify(['blend_open']))
  check(
    'exec class census (permission ask-always set)',
    JSON.stringify(byClass('exec')) === JSON.stringify(['python_run', 'render_still']),
    byClass('exec').join(','),
  )
  check(
    'unknown verb answers undefined (the tool teaches, never guesses)',
    blenderBridgeVerb('tests_run') === undefined,
  )
  check('lookup answers the table row', blenderBridgeVerb('python_run')?.cls === 'exec')
}

section('3. error-code unions — the contract’s named arms')
{
  const server = BLENDER_BRIDGE_SERVER_ERROR_CODES as readonly string[]
  const client = BLENDER_BRIDGE_CLIENT_ERROR_CODES as readonly string[]
  for (const code of [
    'AUTH_FAILED',
    'VERSION_SKEW',
    'UNKNOWN_OP',
    'BAD_ARGS',
    'RENDER_ACTIVE',
    'BLEND_NOT_FOUND',
    'BLEND_DIRTY',
    'PYTHON_EXCEPTION',
    'INTERNAL',
  ]) {
    check(`server union carries ${code}`, server.includes(code))
  }
  for (const code of [
    'AUTH_FAILED',
    'HANDSHAKE_CLOSED',
    'CONNECTION_LOST',
    'EDITOR_UNREACHABLE',
    'REQUEST_TIMEOUT',
    'CLIENT_CLOSED',
    'BAD_FRAME',
    'BRIDGE_VERSION_SKEW',
  ]) {
    check(`client union carries ${code}`, client.includes(code))
  }
  check('no duplicate server codes', new Set(server).size === server.length)
  check('no duplicate client codes', new Set(client).size === client.length)
  check(
    'no Unity-only codes leaked in (the no-reload law: no PLAY_MODE_ACTIVE, no RUN_IN_FLIGHT)',
    !server.includes('PLAY_MODE_ACTIVE') && !server.includes('RUN_IN_FLIGHT'),
  )
}

section('4. the python_run danger sentences — contract, pinned')
{
  check(
    'the no-sandbox sentence stands verbatim',
    BLENDER_PYTHON_RUN_NO_SANDBOX_SENTENCE ===
      'python_run claims NO sandbox: the code runs inside Blender with full bpy authority — it can modify or delete scene data and write files as you; the permission ask is the fence.',
  )
  check(
    'the no-preemption sentence stands verbatim',
    BLENDER_PYTHON_RUN_NO_PREEMPTION_SENTENCE ===
      'python_run has NO preemption: bpy cannot abort a running script — a runaway script blocks Blender until it finishes (the client times out; the server cannot cancel).',
  )
  check(
    'the verb summary names both dangers (no sandbox, no preemption)',
    BLENDER_BRIDGE_VERBS.python_run.summary.includes('NO sandbox') &&
      BLENDER_BRIDGE_VERBS.python_run.summary.includes('NO preemption'),
  )
  check(
    'the source-arg note carries both caps',
    BLENDER_BRIDGE_VERBS.python_run.args.source.includes(String(BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES)) &&
      BLENDER_BRIDGE_VERBS.python_run.args.source.includes(String(BLENDER_BRIDGE_PYTHON_OUTPUT_CAP_BYTES)),
  )
}

section('5. events — the bounded census')
check(
  'exactly render_finished + blend_changed',
  JSON.stringify([...BLENDER_BRIDGE_EVENTS].sort()) ===
    JSON.stringify(['blend_changed', 'render_finished']),
)

section('6. frame builders — wire-legal NDJSON')
{
  const hello = buildBlenderBridgeHelloFrame('tok-abc')
  check(
    'hello is one newline-terminated line',
    hello.endsWith('\n') && !hello.slice(0, -1).includes('\n'),
  )
  const h = JSON.parse(hello) as Record<string, unknown>
  check(
    'hello carries op/token/role/version exactly',
    h.op === 'hello' && h.token === 'tok-abc' && h.role === 'client' && h.version === 1,
  )
  const req = JSON.parse(
    buildBlenderBridgeRequestFrame(7, 'blend_open', { path: '/work/scene.blend' }),
  ) as Record<string, unknown>
  check(
    'request carries id/op/args',
    req.id === 7 &&
      req.op === 'blend_open' &&
      (req.args as Record<string, unknown>).path === '/work/scene.blend',
  )
  const bare = JSON.parse(buildBlenderBridgeRequestFrame(8, 'scene_info')) as Record<string, unknown>
  check('empty args are omitted from the frame', bare.args === undefined)
  const emptied = JSON.parse(buildBlenderBridgeRequestFrame(9, 'scene_info', {})) as Record<
    string,
    unknown
  >
  check('an empty args object is omitted too', emptied.args === undefined)
}

section('7. parseBlenderBridgeFrame — total over hostile input, never throws')
{
  const cases: Array<[string, string, string]> = [
    ['NOT JSON AT ALL', 'unknown', 'garbage'],
    ['42', 'unknown', 'a bare number'],
    ['[1,2,3]', 'unknown', 'an array'],
    ['null', 'unknown', 'null'],
    ['{}', 'unknown', 'an empty object'],
    ['{"id":"seven","ok":true}', 'hello-reply', 'a string id is not a response (state decides)'],
    ['{"id":3,"ok":true,"result":{"echo":1}}', 'response', 'a lawful response'],
    ['{"id":3,"ok":false,"error":{"code":"UNKNOWN_OP","message":"m"}}', 'response', 'a lawful error response'],
    ['{"ok":true,"result":{"version":1}}', 'hello-reply', 'the hello answer'],
    ['{"ok":false,"error":{"code":"AUTH_FAILED","message":"bad token"}}', 'hello-reply', 'the hello refusal'],
    ['{"event":"blend_changed","data":{}}', 'event', 'an event frame'],
  ]
  for (const [raw, kind, label] of cases) {
    let parsed: ReturnType<typeof parseBlenderBridgeFrame> | null = null
    let threw = false
    try {
      parsed = parseBlenderBridgeFrame(raw)
    } catch {
      threw = true
    }
    check(`${label} ⇒ ${kind}`, !threw && parsed?.kind === kind, threw ? 'THREW' : parsed?.kind)
  }
  const err = parseBlenderBridgeFrame(
    '{"id":3,"ok":false,"error":{"code":"BLEND_DIRTY","message":"m","hint":"save first"}}',
  )
  check(
    'error body rides through intact',
    err.kind === 'response' && err.error?.code === 'BLEND_DIRTY' && err.error.hint === 'save first',
  )
  const evt = parseBlenderBridgeFrame('{"event":"render_finished","data":{"ok":true}}')
  check('event data rides through intact', evt.kind === 'event' && (evt.data as { ok: boolean }).ok === true)
  // An id-less ok-frame after the handshake would be shapeless on the wire;
  // it parses as hello-reply and the CLIENT decides by state — the contract
  // only promises the discrimination is stable.
  check(
    'a non-numeric-id ok frame is not a response',
    parseBlenderBridgeFrame('{"ok":true,"id":null}').kind === 'hello-reply',
  )
}

console.log('\n' + (failures === 0 ? '✅ blender-bridge contract proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
