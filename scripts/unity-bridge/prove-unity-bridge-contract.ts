#!/usr/bin/env bun
// ============================================================================
//  scripts/unity-bridge/prove-unity-bridge-contract.ts
//  PROOF: the UNITY-BRIDGE wire contract module is total and self-consistent —
//  the verb table whole, the class census exact, the code unions carrying the
//  contract's named arms, the frame helpers total over hostile input. Pure
//  cpu; no sockets, no editor, no network.
// ============================================================================

import {
  UNITY_BRIDGE_PROTOCOL_VERSION,
  UNITY_BRIDGE_DEFAULT_PORT,
  UNITY_BRIDGE_MAX_LINE_BYTES,
  UNITY_BRIDGE_HIERARCHY_NODE_CAP,
  UNITY_BRIDGE_CONSOLE_RING_CAP,
  UNITY_BRIDGE_SERVER_ERROR_CODES,
  UNITY_BRIDGE_CLIENT_ERROR_CODES,
  UNITY_BRIDGE_VERBS,
  UNITY_BRIDGE_EVENTS,
  unityBridgeVerb,
  unityBridgeVerbNames,
  buildUnityBridgeHelloFrame,
  buildUnityBridgeRequestFrame,
  parseUnityBridgeFrame,
} from '../../src/services/unity/bridgeProtocol.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('1. constants — the contract’s fixed points')
check('protocol version is 1', UNITY_BRIDGE_PROTOCOL_VERSION === 1)
check(
  'default port 6011, outside the sibling family {6005, 6006, 6010}',
  UNITY_BRIDGE_DEFAULT_PORT === 6011 && ![6005, 6006, 6010].includes(UNITY_BRIDGE_DEFAULT_PORT),
)
check('frame cap 8MiB (the vulcan bound)', UNITY_BRIDGE_MAX_LINE_BYTES === 8 * 1024 * 1024)
check('hierarchy cap bounded and sane', UNITY_BRIDGE_HIERARCHY_NODE_CAP === 2_000)
check('console ring cap bounded and sane', UNITY_BRIDGE_CONSOLE_RING_CAP === 1_000)

section('2. the verb table — totality + class census')
{
  const names = unityBridgeVerbNames()
  const expected = [
    'play_state',
    'play_enter',
    'play_exit',
    'play_pause',
    'scene_list',
    'scene_open',
    'hierarchy_read',
    'console_tail',
    'tests_run',
  ]
  check('exactly the nine verbs, in table order', JSON.stringify(names) === JSON.stringify(expected), names.join(','))
  for (const name of names) {
    const spec = UNITY_BRIDGE_VERBS[name]
    check(
      `${name}: lawful class + non-empty summary + string arg notes`,
      ['read', 'mutate', 'exec'].includes(spec.cls) &&
        spec.summary.length > 0 &&
        Object.values(spec.args).every(n => typeof n === 'string' && n.length > 0),
    )
  }
  const byClass = (cls: string) => names.filter(n => UNITY_BRIDGE_VERBS[n].cls === cls).sort()
  check(
    'read class census',
    JSON.stringify(byClass('read')) ===
      JSON.stringify(['console_tail', 'hierarchy_read', 'play_state', 'scene_list']),
    byClass('read').join(','),
  )
  check('mutate class census', JSON.stringify(byClass('mutate')) === JSON.stringify(['scene_open']))
  check(
    'exec class census (permission ask-always set)',
    JSON.stringify(byClass('exec')) ===
      JSON.stringify(['play_enter', 'play_exit', 'play_pause', 'tests_run']),
    byClass('exec').join(','),
  )
  check('unknown verb answers undefined (the tool teaches, never guesses)', unityBridgeVerb('scene_play') === undefined)
  check('lookup answers the table row', unityBridgeVerb('tests_run')?.cls === 'exec')
}

section('3. error-code unions — the contract’s named arms')
{
  const server = UNITY_BRIDGE_SERVER_ERROR_CODES as readonly string[]
  const client = UNITY_BRIDGE_CLIENT_ERROR_CODES as readonly string[]
  for (const code of [
    'AUTH_FAILED',
    'VERSION_SKEW',
    'UNKNOWN_OP',
    'BAD_ARGS',
    'PLAY_MODE_ACTIVE',
    'SCENE_NOT_FOUND',
    'SCENE_DIRTY',
    'RUN_IN_FLIGHT',
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
}

section('4. events — the bounded census')
check(
  'exactly play_state_changed + test_run_finished',
  JSON.stringify([...UNITY_BRIDGE_EVENTS].sort()) ===
    JSON.stringify(['play_state_changed', 'test_run_finished']),
)

section('5. frame builders — wire-legal NDJSON')
{
  const hello = buildUnityBridgeHelloFrame('tok-abc')
  check('hello is one newline-terminated line', hello.endsWith('\n') && !hello.slice(0, -1).includes('\n'))
  const h = JSON.parse(hello) as Record<string, unknown>
  check(
    'hello carries op/token/role/version exactly',
    h.op === 'hello' && h.token === 'tok-abc' && h.role === 'client' && h.version === 1,
  )
  const req = JSON.parse(buildUnityBridgeRequestFrame(7, 'scene_open', { path: 'Assets/Main.unity' })) as Record<string, unknown>
  check('request carries id/op/args', req.id === 7 && req.op === 'scene_open' && (req.args as Record<string, unknown>).path === 'Assets/Main.unity')
  const bare = JSON.parse(buildUnityBridgeRequestFrame(8, 'play_state')) as Record<string, unknown>
  check('empty args are omitted from the frame', bare.args === undefined)
  const emptied = JSON.parse(buildUnityBridgeRequestFrame(9, 'play_state', {})) as Record<string, unknown>
  check('an empty args object is omitted too', emptied.args === undefined)
}

section('6. parseUnityBridgeFrame — total over hostile input, never throws')
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
    ['{"event":"play_state_changed","data":{}}', 'event', 'an event frame'],
  ]
  for (const [raw, kind, label] of cases) {
    let parsed: ReturnType<typeof parseUnityBridgeFrame> | null = null
    let threw = false
    try {
      parsed = parseUnityBridgeFrame(raw)
    } catch {
      threw = true
    }
    check(`${label} ⇒ ${kind}`, !threw && parsed?.kind === kind, threw ? 'THREW' : parsed?.kind)
  }
  const err = parseUnityBridgeFrame('{"id":3,"ok":false,"error":{"code":"SCENE_DIRTY","message":"m","hint":"save first"}}')
  check(
    'error body rides through intact',
    err.kind === 'response' && err.error?.code === 'SCENE_DIRTY' && err.error.hint === 'save first',
  )
  const evt = parseUnityBridgeFrame('{"event":"test_run_finished","data":{"passed":3}}')
  check('event data rides through intact', evt.kind === 'event' && (evt.data as { passed: number }).passed === 3)
  // An id-less ok-frame after the handshake would be shapeless on the wire;
  // it parses as hello-reply and the CLIENT decides by state — the contract
  // only promises the discrimination is stable.
  check('a non-numeric-id ok frame is not a response', parseUnityBridgeFrame('{"ok":true,"id":null}').kind === 'hello-reply')
}

console.log('\n' + (failures === 0 ? '✅ unity-bridge contract proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
