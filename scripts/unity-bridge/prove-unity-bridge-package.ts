#!/usr/bin/env bun
// ============================================================================
//  scripts/unity-bridge/prove-unity-bridge-package.ts
//  PROOF: the baked C# package is structurally whole — the manifest lawful,
//  the asmdef editor-only with the TestRunner references, every source file
//  present, and the load-bearing mechanics IN the source (the
//  [InitializeOnLoad] re-arm, the DomainUnload stop, the delayCall
//  ack-then-transition, the SessionState reload-surviving run key, the
//  guaranteed <test-run> root, the loopback-only listener, the token gate).
//  These are STRUCTURAL pins over the shipped source — the package never
//  compiles in-lane (that proof is the written Windows-box field drill);
//  they hold the source to the contract the fake bridge implements.
// ============================================================================

import { UNITY_BRIDGE_DIGEST, UNITY_BRIDGE_FILES } from '../../src/services/unity/bridgeFiles.generated.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function file(p: string): string {
  return UNITY_BRIDGE_FILES.find(f => f.path === p)?.content ?? ''
}

section('1. the bundle — files present, digest sane')
{
  const expected = [
    'Editor/BridgeServer.cs',
    'Editor/BridgeSettings.cs',
    'Editor/ConsoleRing.cs',
    'Editor/HierarchyHandler.cs',
    'Editor/Mercury.UnityBridge.Editor.asmdef',
    'Editor/MiniJson.cs',
    'Editor/PlayModeHandler.cs',
    'Editor/ScenesHandler.cs',
    'Editor/TestsHandler.cs',
    'README.md',
    'package.json',
  ]
  check(
    'exactly the expected files, sorted',
    JSON.stringify(UNITY_BRIDGE_FILES.map(f => f.path)) === JSON.stringify(expected),
    UNITY_BRIDGE_FILES.map(f => f.path).join(','),
  )
  check('64-hex digest', /^[0-9a-f]{64}$/.test(UNITY_BRIDGE_DIGEST))
  check('every file non-empty', UNITY_BRIDGE_FILES.every(f => f.content.length > 0))
  check('no .meta files shipped (the editor generates them on import)', UNITY_BRIDGE_FILES.every(f => !f.path.endsWith('.meta')))
}

section('2. the manifest — the embedded-package identity')
{
  const manifest = JSON.parse(file('package.json')) as Record<string, unknown>
  check('name is the reverse-domain id', manifest.name === 'com.mercury.unity-bridge')
  check('semver version', typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version))
  check('unity floor declared', manifest.unity === '2021.3')
  check(
    'test-framework dependency pinned',
    typeof (manifest.dependencies as Record<string, string>)['com.unity.test-framework'] === 'string',
  )
}

section('3. the asmdef — editor-only + the TestRunner references')
{
  const asmdef = JSON.parse(file('Editor/Mercury.UnityBridge.Editor.asmdef')) as Record<string, unknown>
  check('name matches the <org>.<package>.Editor convention', asmdef.name === 'Mercury.UnityBridge.Editor')
  check('editor-only platform', JSON.stringify(asmdef.includePlatforms) === JSON.stringify(['Editor']))
  check('excludePlatforms empty (exclusive with include)', JSON.stringify(asmdef.excludePlatforms) === JSON.stringify([]))
  const refs = asmdef.references as string[]
  check(
    'references carry both TestRunner assemblies',
    refs.includes('UnityEditor.TestRunner') && refs.includes('UnityEngine.TestRunner'),
  )
  check(
    'nunit precompiled reference for TNode',
    asmdef.overrideReferences === true &&
      (asmdef.precompiledReferences as string[]).includes('nunit.framework.dll'),
  )
}

section('4. the load-bearing mechanics live in the source')
{
  const server = file('Editor/BridgeServer.cs')
  check('[InitializeOnLoad] arms the server', server.includes('[InitializeOnLoad]'))
  check('DomainUnload stops the old domain’s listener (the rebind law)', server.includes('DomainUnload'))
  check('loopback only by construction', server.includes('IPAddress.Loopback') && !server.includes('IPAddress.Any'))
  check('the main-thread pump rides EditorApplication.update', server.includes('EditorApplication.update += Pump'))
  check('accept-newest fires at HELLO time (probe-immune), with the unauthed receive deadline', server.includes('ACCEPT-NEWEST AT HELLO TIME') && server.includes('ReceiveTimeout = 10_000'))
  check('ping answered on the socket thread (busy ≠ dead)', /op == "ping"/.test(server))
  check('the frame cap matches the contract (8MiB)', server.includes('8 * 1024 * 1024'))
  check('play-state events ride playModeStateChanged', server.includes('playModeStateChanged'))

  const play = file('Editor/PlayModeHandler.cs')
  check('ack-then-transition via delayCall (enter + exit)', (play.match(/EditorApplication\.delayCall \+=/g) ?? []).length === 2)
  check('willReload reads the Enter Play Mode Settings', play.includes('enterPlayModeOptionsEnabled') && play.includes('DisableDomainReload'))

  const tests = file('Editor/TestsHandler.cs')
  check('test callbacks re-register after reloads (the doc’s own law)', tests.includes('Rearm') && tests.includes('RegisterCallbacks'))
  check('the pending run key survives reloads in SessionState', tests.includes('SessionState.GetString') && tests.includes('SessionState.SetString'))
  check('the results writer guarantees a <test-run> root', tests.includes('<test-run') && tests.includes('StartsWith("<test-run"'))
  check('RunFinished ignores runs the bridge did not start', tests.includes('not ours'))

  const scenes = file('Editor/ScenesHandler.cs')
  check('scene_open refuses in play mode', scenes.includes('PLAY_MODE_ACTIVE'))
  check('SCENE_DIRTY names the save road', scenes.includes('SCENE_DIRTY') && /File > Save/.test(scenes))

  const settings = file('Editor/BridgeSettings.cs')
  check('paths are fenced inside the project', settings.includes('ResolveInsideProject'))
  check('the project root is cached for socket-thread reads', settings.includes('_cachedRoot'))
  check('the port default matches the contract (6011)', settings.includes('DefaultPort = 6011'))
  check('protocol version 1 in the package half', settings.includes('ProtocolVersion = 1'))

  const ring = file('Editor/ConsoleRing.cs')
  check('the ring rides logMessageReceivedThreaded under a lock', ring.includes('logMessageReceivedThreaded') && ring.includes('lock (Gate)'))
  check('the ring cap matches the contract (1000)', ring.includes('Capacity = 1000'))
}

section('5. nothing in the package dials out or runs foreign code')
{
  const allCs = UNITY_BRIDGE_FILES.filter(f => f.path.endsWith('.cs')).map(f => f.content).join('\n')
  check('no outbound connects (TcpClient/connect beyond the listener’s accept)', !allCs.includes('new TcpClient('))
  check('no process spawning', !allCs.includes('System.Diagnostics.Process') && !allCs.includes('Process.Start'))
  check('no shell/eval surface', !allCs.includes('Assembly.Load') && !allCs.includes('Activator.CreateInstance'))
}

console.log('\n' + (failures === 0 ? '✅ unity-bridge package proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
