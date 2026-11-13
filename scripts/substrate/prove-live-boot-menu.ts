#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://github.com/example/mercury' }

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runTurns } from '../lib/rows.ts'
import { handoffTurn, isHandoffRequest, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.NODE_ENV = 'test'
process.env.MERCURY_DESKTOP_DRIVER = 'none'

const SCRATCH = mkdtempSync(join(tmpdir(), 'live-boot-menu-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
for (const k of [
  'MERCURY_HOME',
  'MERCURY_ENTER_MENU',
  'MERCURY_BOOT_ENV_APPLIED',
  'MERCURY_BLENDER',
  'MERCURY_BLENDER_BIN',
  'MERCURY_ASEPRITE',
  'MERCURY_GODOT',
  'MERCURY_GODOT_TOOLS',
  'MERCURY_UNITY',
  'MERCURY_DAP',
  'MERCURY_LSP_CPP',
  'MERCURY_WARDS',
  'MERCURY_SAMPLES',
  'MERCURY_HARNESS_MAP',
]) {
  delete process.env[k]
}
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'

const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-live-boot-menu exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const menu = await import('../../src/substrate/startupMenu.ts')
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.ts')
const { GodotTool } = await import('../../src/tools/GodotTool/GodotTool.ts')
const { UnityTool } = await import('../../src/tools/UnityTool/UnityTool.ts')
const { BlenderTool } = await import('../../src/tools/BlenderTool/BlenderTool.ts')
const { AsepriteTool } = await import('../../src/tools/AsepriteTool/AsepriteTool.ts')

type LiveApplyFn = (
  path?: string,
  env?: NodeJS.ProcessEnv,
) => {
  applied: Array<{ env: string; value: string }>
  envWins: string[]
  refused: Array<{ key: string; reason: string }>
  retired: string[]
  skippedNewSession: string[]
} | null

const applyLive = (menu as unknown as { applyLiveBootMenuEnv?: LiveApplyFn }).applyLiveBootMenuEnv
const isLiveEnvRow = (menu as unknown as { isLiveEnvRow?: (r: { env: string; applicationClass?: string }) => boolean }).isLiveEnvRow
const liveReadsOf = (): number => {
  const fn = (menu as unknown as { __liveBootEnvFileReadsForTests?: () => number }).__liveBootEnvFileReadsForTests
  return typeof fn === 'function' ? fn() : -1
}

const EXPECTED_LIVE_ENV_LANES = [
  'MERCURY_DAP',
  'MERCURY_GODOT_TOOLS',
  'MERCURY_UNITY',
  'MERCURY_BLENDER',
  'MERCURY_ASEPRITE',
]
const EXPECTED_SPAWN_SWITCHES = ['MERCURY_SESSION_SUBAGENTS', 'MERCURY_SESSION_WORKFLOWS']

section('§1 registry — deferred-tool dev lanes are live; boot-bound LSP and other rows stay new-session')
{
  const deferredTools = [DebugTool, GodotTool, UnityTool, BlenderTool, AsepriteTool]
  check(
    'every live dev-lane tool declares shouldDefer: true',
    deferredTools.every(t => t.shouldDefer === true),
    deferredTools.map(t => `${t.name}:${String(t.shouldDefer)}`).join(','),
  )
  const liveRows = menu.STARTUP_MENU.filter(r => r.applicationClass === 'live').map(r => r.env)
  check(
    'STARTUP_MENU marks the 2 spawn-switch rows and the 5 deferred-tool dev-lane rows as live',
    j(liveRows) === j(['MERCURY_DAP', ...EXPECTED_SPAWN_SWITCHES, 'MERCURY_GODOT_TOOLS', 'MERCURY_UNITY', 'MERCURY_BLENDER', 'MERCURY_ASEPRITE']),
    j(liveRows),
  )
  const liveEnvRows = typeof isLiveEnvRow === 'function' ? menu.STARTUP_MENU.filter(isLiveEnvRow).map(r => r.env) : []
  check(
    'isLiveEnvRow picks exactly the 5 deferred-tool dev-lane rows and excludes the latched spawn switches',
    j(liveEnvRows) === j(EXPECTED_LIVE_ENV_LANES),
    j(liveEnvRows),
  )
  const newSessionRows = menu.STARTUP_MENU.filter(r => r.applicationClass === undefined || r.applicationClass === 'new-session').map(r => r.env)
  check(
    'MERCURY_LSP_CPP and MERCURY_GODOT (boot-initialized LSP lanes) and the remaining 8 rows stay new-session',
    newSessionRows.includes('MERCURY_LSP_CPP') &&
      newSessionRows.includes('MERCURY_GODOT') &&
      newSessionRows.length === 10,
    j(newSessionRows),
  )
}

section('§2 applyLiveBootMenuEnv — live-only filter, anti-smuggling parity, real-env pins, stat gate, off clearing')
{
  check('startupMenu exports applyLiveBootMenuEnv()', typeof applyLive === 'function')
  const file = join(SCRATCH, 'unit-boot-env.json')
  writeFileSync(file, JSON.stringify({ version: menu.BOOT_ENV_VERSION, savedAt: 't0', env: { MERCURY_SAMPLES: '1' } }))
  const env: NodeJS.ProcessEnv = {}
  const bootRes = menu.applyBootMenuEnv(file, env)
  check('boot apply stamps MERCURY_SAMPLES=1 (a new-session row)', bootRes !== null && env.MERCURY_SAMPLES === '1')

  const readsBeforeUnchanged = liveReadsOf()
  const unchanged1 = typeof applyLive === 'function' ? applyLive(file, env) : ('missing' as never)
  const unchanged2 = typeof applyLive === 'function' ? applyLive(file, env) : ('missing' as never)
  const readsAfterUnchanged = liveReadsOf()
  check(
    'stat-gated: unchanged boot-env.json after boot returns null and reads 0 files across turns',
    unchanged1 === null && unchanged2 === null && readsBeforeUnchanged >= 0 && readsAfterUnchanged === readsBeforeUnchanged,
    `u1=${j(unchanged1)} u2=${j(unchanged2)} reads=${readsBeforeUnchanged}->${readsAfterUnchanged}`,
  )

  writeFileSync(
    file,
    JSON.stringify({
      version: menu.BOOT_ENV_VERSION,
      savedAt: 't1',
      env: {
        MERCURY_BLENDER: '1',
        MERCURY_ASEPRITE: '1',
        MERCURY_WARDS: '0',
        MERCURY_GODOT: '1',
        MERCURY_CACHE_TTL: '1h',
        MERCURY_TABULA_MINERVA: '1',
        PATH: '/evil',
        NODE_OPTIONS: '--require /evil.js',
      },
    }),
  )
  const readsBeforeChange = liveReadsOf()
  const r1 = typeof applyLive === 'function' ? applyLive(file, env) : null
  const readsAfterChange = liveReadsOf()
  check(
    'stat-gated: a changed boot-env.json reads the file exactly once, then 0 times on the next unchanged turn',
    r1 !== null &&
      readsAfterChange === readsBeforeChange + 1 &&
      (typeof applyLive === 'function' ? applyLive(file, env) : 'x') === null &&
      liveReadsOf() === readsAfterChange,
    `reads=${readsBeforeChange}->${readsAfterChange}`,
  )
  check(
    'only live dev-lane rows are applied to env (MERCURY_BLENDER=1, MERCURY_ASEPRITE=1)',
    r1 !== null &&
      env.MERCURY_BLENDER === '1' &&
      env.MERCURY_ASEPRITE === '1' &&
      j(r1.applied.map(a => a.env)) === j(['MERCURY_BLENDER', 'MERCURY_ASEPRITE']),
    j(r1),
  )
  check(
    'new-session and command rows in boot-env.json are skipped, never applied mid-session',
    r1 !== null &&
      env.MERCURY_WARDS === undefined &&
      env.MERCURY_GODOT === undefined &&
      env.MERCURY_CACHE_TTL === undefined &&
      j(r1.skippedNewSession) === j(['MERCURY_WARDS', 'MERCURY_GODOT', 'MERCURY_CACHE_TTL']),
    j(r1?.skippedNewSession),
  )
  check(
    'a new-session row applied at boot (MERCURY_SAMPLES=1) stays in env and keeps its self-applied attribution when cleared in boot-env.json',
    env.MERCURY_SAMPLES === '1' && menu.realEnvPin('MERCURY_SAMPLES', env) === null && menu.realEnvPin('MERCURY_BLENDER', env) === null,
    j({ samples: env.MERCURY_SAMPLES, pinSamples: menu.realEnvPin('MERCURY_SAMPLES', env), pinBlender: menu.realEnvPin('MERCURY_BLENDER', env) }),
  )
  check(
    'unregistered keys (PATH, NODE_OPTIONS) are refused with the anti-smuggling reason and retired keys are dropped cleanly',
    r1 !== null &&
      env.PATH === undefined &&
      env.NODE_OPTIONS === undefined &&
      r1.refused.length === 2 &&
      r1.refused.every(x => x.reason.includes('anti-smuggling')) &&
      j(r1.retired) === j(['MERCURY_TABULA_MINERVA']),
    j({ refused: r1?.refused, retired: r1?.retired }),
  )

  writeFileSync(file, JSON.stringify({ version: menu.BOOT_ENV_VERSION, savedAt: 't2', env: { MERCURY_BLENDER: 'banana' } }))
  const rForeign = typeof applyLive === 'function' ? applyLive(file, env) : null
  check(
    'a foreign value for a live row is refused and clears the prior self-applied value back to default',
    rForeign !== null && rForeign.refused.length === 1 && rForeign.refused[0]?.key === 'MERCURY_BLENDER' && env.MERCURY_BLENDER === undefined,
    j({ rForeign, blender: env.MERCURY_BLENDER }),
  )

  menu.saveBootDefaultsProfile({ MERCURY_BLENDER: '1' }, file)
  if (typeof applyLive === 'function') applyLive(file, env)
  check('re-arming MERCURY_BLENDER=1 applies again cleanly', env.MERCURY_BLENDER === '1')
  menu.saveBootDefaultsProfile({}, file)
  const rCleared = typeof applyLive === 'function' ? applyLive(file, env) : null
  check(
    'switching OFF in boot-env.json removes the self-applied live env var and leaves boot-time new-session rows intact',
    rCleared !== null && env.MERCURY_BLENDER === undefined && env.MERCURY_ASEPRITE === undefined && env.MERCURY_SAMPLES === '1',
    j({ blender: env.MERCURY_BLENDER, samples: env.MERCURY_SAMPLES }),
  )

  menu.saveBootDefaultsProfile({ MERCURY_UNITY: '1' }, file)
  if (typeof applyLive === 'function') applyLive(file, env)
  unlinkSync(file)
  const readsBeforeUnlink = liveReadsOf()
  const rUnlinked = typeof applyLive === 'function' ? applyLive(file, env) : null
  check(
    'deleting boot-env.json clears self-applied live rows with 0 file reads',
    rUnlinked !== null && env.MERCURY_UNITY === undefined && env.MERCURY_SAMPLES === '1' && liveReadsOf() === readsBeforeUnlink,
    j({ unity: env.MERCURY_UNITY, samples: env.MERCURY_SAMPLES }),
  )

  const pinnedEnv: NodeJS.ProcessEnv = { MERCURY_BLENDER: '0', MERCURY_DAP: '1' }
  menu.saveBootDefaultsProfile({ MERCURY_BLENDER: '1', MERCURY_DAP: '0' }, file)
  const rPinned = typeof applyLive === 'function' ? applyLive(file, pinnedEnv) : null
  check(
    'real-env pin wins: neither MERCURY_BLENDER=0 nor MERCURY_DAP=1 is overwritten by applyLiveBootMenuEnv',
    rPinned !== null &&
      pinnedEnv.MERCURY_BLENDER === '0' &&
      pinnedEnv.MERCURY_DAP === '1' &&
      j(rPinned.envWins) === j(['MERCURY_BLENDER', 'MERCURY_DAP']),
    j({ rPinned, pinnedEnv }),
  )
  menu.saveBootDefaultsProfile({}, file)
  if (typeof applyLive === 'function') applyLive(file, pinnedEnv)
  check(
    'real-env pin survives clearing boot-env.json too (never mistaken for self-applied)',
    pinnedEnv.MERCURY_BLENDER === '0' && pinnedEnv.MERCURY_DAP === '1',
    j(pinnedEnv),
  )

  const menuSrc = readFileSync(join(ROOT, 'src', 'substrate', 'startupMenu.ts'), 'utf8')
  for (const name of ['applyBootMenuEnv', 'applyLiveBootMenuEnv']) {
    const at = menuSrc.indexOf(`export function ${name}(`)
    const nextExport = menuSrc.indexOf('\nexport function ', at + 1)
    const nextHelper = menuSrc.indexOf('\nfunction ', at + 1)
    const end = Math.min(nextExport < 0 ? menuSrc.length : nextExport, nextHelper < 0 ? menuSrc.length : nextHelper)
    const body = at < 0 ? '' : menuSrc.slice(at, end)
    const read = body.indexOf('readFileSync(')
    const firstStat = body.indexOf('statFingerprint(')
    const lastStat = body.lastIndexOf('statFingerprint(')
    check(
      `${name} remembers the stat it took BEFORE it read the file, so a save that lands during the read is read at the next turn`,
      read > 0 && firstStat > 0 && firstStat < read && lastStat < read,
      `first stat at ${firstStat}, last stat at ${lastStat}, the read at ${read}`,
    )
  }
}

section('§3 receipts, evaluateExplicitApply & admitted snapshot revision')
{
  const rPath = join(SCRATCH, 'receipts-boot-env.json')
  const sLive = menu.saveBootDefaultsProfile({ MERCURY_BLENDER: '1' }, rPath, { existingSessionsUnchanged: 2 })
  check(
    'saving a live row states it reaches running sessions at their next turn (never "existing sessions unchanged")',
    sLive.ok === true &&
      sLive.receipt.includes('reaches running sessions at their next turn') &&
      sLive.receipt.includes('2 running sessions') &&
      !sLive.receipt.includes('existing sessions unchanged'),
    sLive.ok ? sLive.receipt : sLive.reason,
  )
  const sNew = menu.saveBootDefaultsProfile({ MERCURY_BLENDER: '1', MERCURY_WARDS: '0' }, rPath, { existingSessionsUnchanged: 2 })
  check(
    'saving only a new-session delta keeps "applies to sessions created after revision N · 2 existing sessions unchanged"',
    sNew.ok === true &&
      sNew.receipt.includes(`applies to sessions created after revision ${sNew.revision}`) &&
      sNew.receipt.includes('2 existing sessions unchanged'),
    sNew.ok ? sNew.receipt : sNew.reason,
  )
  const sMixed = menu.saveBootDefaultsProfile({ MERCURY_BLENDER: '1', MERCURY_ASEPRITE: '1' }, rPath, { existingSessionsUnchanged: 1 })
  check(
    'saving a mixed delta (live MERCURY_ASEPRITE added + new-session MERCURY_WARDS cleared) states both rules and names the row that reaches running sessions',
    sMixed.ok === true &&
      sMixed.receipt.includes('Saved defaults · Aseprite dev lanes: running sessions at their next turn · ') &&
      sMixed.receipt.includes(`the rest: sessions created after revision ${sMixed.revision}`) &&
      !sMixed.receipt.includes('live rows') &&
      !/lanes reach(es)? /.test(sMixed.receipt),
    sMixed.ok ? sMixed.receipt : sMixed.reason,
  )
  const switchRow = menu.STARTUP_MENU.find(r => r.env === 'MERCURY_SESSION_SUBAGENTS')
  const switchValue = switchRow ? menu.menuRowChoices(switchRow).find(c => c.value !== null)?.value : undefined
  const sPath = join(SCRATCH, 'receipts-switch-boot-env.json')
  const sSwitch =
    typeof switchValue === 'string'
      ? menu.saveBootDefaultsProfile({ MERCURY_SESSION_SUBAGENTS: switchValue }, sPath, { existingSessionsUnchanged: 2 })
      : null
  check(
    "saving only a session's own switch (Crewmates) keeps the new-session receipt: the turn-opening read skips it, so it does not claim to reach running sessions",
    sSwitch !== null &&
      sSwitch.ok === true &&
      sSwitch.receipt.includes(`applies to sessions created after revision ${sSwitch.revision}`) &&
      sSwitch.receipt.includes('2 existing sessions unchanged') &&
      !sSwitch.receipt.includes('running sessions'),
    sSwitch === null ? 'no choice found for MERCURY_SESSION_SUBAGENTS' : sSwitch.ok ? sSwitch.receipt : sSwitch.reason,
  )
  const switchEnv: Record<string, string> = {}
  if (typeof switchValue === 'string') switchEnv.MERCURY_SESSION_SUBAGENTS = switchValue
  const rSwitch = menu.saveBootDefaultsProfile(switchEnv, sPath)
  if (typeof applyLive === 'function') {
    const reached = applyLive(sPath, {})
    check(
      'the turn-opening read leaves that switch to new sessions (skippedNewSession), which is what its receipt says',
      rSwitch.ok === true && reached !== null && reached.skippedNewSession.includes('MERCURY_SESSION_SUBAGENTS') && reached.applied.length === 0,
      j(reached),
    )
  }
  menu.saveBootDefaultsProfile({}, sPath)
  const sSwitchAndLane =
    typeof switchValue === 'string'
      ? menu.saveBootDefaultsProfile({ MERCURY_SESSION_SUBAGENTS: switchValue, MERCURY_BLENDER: '1', MERCURY_UNITY: '1' }, sPath, { existingSessionsUnchanged: 1 })
      : null
  check(
    'a switch saved beside two lane rows: the two rows are named as reaching running sessions, the switch is "the rest"',
    sSwitchAndLane !== null &&
      sSwitchAndLane.ok === true &&
      sSwitchAndLane.receipt.includes('Saved defaults · Unity dev lanes, Blender dev lanes: running sessions at their next turn · ') &&
      sSwitchAndLane.receipt.includes(`the rest: sessions created after revision ${sSwitchAndLane.revision}`),
    sSwitchAndLane === null ? 'no choice found' : sSwitchAndLane.ok ? sSwitchAndLane.receipt : sSwitchAndLane.reason,
  )

  const snapPath = join(SCRATCH, 'snap-boot-env.json')
  menu.saveBootDefaultsProfile({}, snapPath)
  const snap = menu.resolveEffectiveSettingsSnapshot({
    sessionId: 'sess-live-eval',
    path: snapPath,
    env: { MERCURY_UNITY: '0' },
  })
  menu.saveBootDefaultsProfile({ MERCURY_BLENDER: '1', MERCURY_UNITY: '1', MERCURY_WARDS: '0' }, snapPath)
  const prof = menu.readBootDefaultsProfile(snapPath)
  const evalBefore = new Map(menu.evaluateExplicitApply(snap, prof).map(r => [r.env, r]))
  check(
    'evaluateExplicitApply queues a changed live dev-lane row and states that new-session rows keep captured snapshot r1',
    evalBefore.get('MERCURY_BLENDER')?.outcome === 'queued' &&
      (evalBefore.get('MERCURY_BLENDER')?.reason ?? '').includes('reaches running sessions at their next turn (application class: live)') &&
      (evalBefore.get('MERCURY_BLENDER')?.reason ?? '').includes(`snapshot r${snap.profileRevision}`),
    j(evalBefore.get('MERCURY_BLENDER')),
  )
  check(
    'evaluateExplicitApply refuses a real-env-pinned live row as today',
    evalBefore.get('MERCURY_UNITY')?.outcome === 'refused' &&
      (evalBefore.get('MERCURY_UNITY')?.reason ?? '').includes('pinned by the real environment'),
    j(evalBefore.get('MERCURY_UNITY')),
  )
  check(
    'evaluateExplicitApply refuses a changed new-session row as today',
    evalBefore.get('MERCURY_WARDS')?.outcome === 'refused' &&
      (evalBefore.get('MERCURY_WARDS')?.reason ?? '').includes('application class: new-session'),
    j(evalBefore.get('MERCURY_WARDS')),
  )
  const evalAfterTurn = new Map(menu.evaluateExplicitApply(snap, prof, { MERCURY_BLENDER: '1' }).map(r => [r.env, r]))
  check(
    'evaluateExplicitApply reports no-change once liveValues reflects the turn-boundary apply',
    evalAfterTurn.get('MERCURY_BLENDER')?.outcome === 'no-change',
    j(evalAfterTurn.get('MERCURY_BLENDER')),
  )
}

section('§4 tail announcements in-process — harness_map_delta + deferred_tools_delta once on ON and once on OFF, system prompt frozen')
{
  const { getHarnessMapDelta, resetHarnessMapForTest } = await import('../../src/utils/cockpit/harnessMap.ts')
  const { resetRuntimePostureForTest } = await import('../../src/utils/cockpit/runtimePosture.ts')
  const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
  const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')
  const { getTools } = await import('../../src/tools.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { getDeferredToolsDelta } = await import('../../src/utils/toolSearch.ts')
  const { _resetBlenderBridgeContextCacheForTesting } = await import('../../src/utils/blender/bridgeGates.ts')
  const { settleDapAdapterProbes } = await import('../../src/services/dap/dapClient.ts')
  await settleDapAdapterProbes()

  const fakeBlender = join(SCRATCH, 'fake-blender-inproc')
  writeFileSync(fakeBlender, '#!/bin/sh\necho "Blender 4.3.0"\nexit 0\n')
  chmodSync(fakeBlender, 0o755)
  process.env.MERCURY_BLENDER_BIN = fakeBlender
  const liveFile = join(SCRATCH, 'inproc-boot-env.json')
  menu.saveBootDefaultsProfile({}, liveFile)
  menu.applyBootMenuEnv(liveFile, process.env)
  _resetBlenderBridgeContextCacheForTesting()
  resetRuntimePostureForTest()
  resetHarnessMapForTest()
  clearSystemPromptSections()

  const toolsTurn1 = getTools({ ...getEmptyToolPermissionContext(), mode: 'default' } as never)
  const sysTurn1 = await getSystemPrompt(toolsTurn1, 'claude-opus-4-8')
  const dTools1 = getDeferredToolsDelta(toolsTurn1, [], undefined, 'claude-opus-4-8')
  const hMap1 = getHarnessMapDelta([])
  check('turn 1 (lane off): BlenderTool absent from catalog and initial harness map has no Blender line', !toolsTurn1.some(t => t.name === 'Blender') && !(sysTurn1.join('\n')).includes('Blender lanes are armed') && hMap1 === null)
  const history: Array<{ type: string; attachment?: Record<string, unknown> }> = [
    ...(dTools1 ? [{ type: 'attachment', attachment: { type: 'deferred_tools_delta', ...dTools1 } }] : []),
  ]

  menu.saveBootDefaultsProfile({ MERCURY_BLENDER: '1', MERCURY_GODOT_TOOLS: '1' }, liveFile)
  if (typeof applyLive === 'function') applyLive(liveFile, process.env)
  _resetBlenderBridgeContextCacheForTesting()

  const toolsTurn2 = getTools({ ...getEmptyToolPermissionContext(), mode: 'default' } as never)
  const sysTurn2 = await getSystemPrompt(toolsTurn2, 'claude-opus-4-8')
  const dTools2 = getDeferredToolsDelta(toolsTurn2, history as never, undefined, 'claude-opus-4-8')
  const hMap2 = getHarnessMapDelta(history as never)
  check(
    'turn 2 (lane switched ON): system prompt is byte-identical to turn 1 (cached prefix does not move, even with VULCAN armed)',
    j(sysTurn2) === j(sysTurn1),
  )
  check(
    'turn 2 (lane switched ON): BlenderTool joins the catalog and deferred_tools_delta announces Blender once',
    toolsTurn2.some(t => t.name === 'Blender') && dTools2 !== null && dTools2.addedNames.includes('Blender') && dTools2.removedNames.length === 0,
    j(dTools2),
  )
  check(
    'turn 2 (lane switched ON): harness_map_delta announces Blender and VULCAN lines once at the tail',
    hMap2 !== null && hMap2.added.some(l => l.includes('Blender lanes are armed')) && hMap2.added.some(l => l.includes('VULCAN')) && hMap2.removed.length === 0,
    j(hMap2),
  )
  if (dTools2) history.push({ type: 'attachment', attachment: { type: 'deferred_tools_delta', ...dTools2 } })
  if (hMap2) history.push({ type: 'attachment', attachment: { type: 'harness_map_delta', ...hMap2 } })

  const dTools3 = getDeferredToolsDelta(toolsTurn2, history as never, undefined, 'claude-opus-4-8')
  const hMap3 = getHarnessMapDelta(history as never)
  check('turn 3 (steady): neither deferred_tools_delta nor harness_map_delta repeats', dTools3 === null && hMap3 === null, j({ dTools3, hMap3 }))

  menu.saveBootDefaultsProfile({}, liveFile)
  if (typeof applyLive === 'function') applyLive(liveFile, process.env)
  _resetBlenderBridgeContextCacheForTesting()
  const toolsTurn4 = getTools({ ...getEmptyToolPermissionContext(), mode: 'default' } as never)
  const sysTurn4 = await getSystemPrompt(toolsTurn4, 'claude-opus-4-8')
  const dTools4 = getDeferredToolsDelta(toolsTurn4, history as never, undefined, 'claude-opus-4-8')
  const hMap4 = getHarnessMapDelta(history as never)
  check(
    'turn 4 (lane switched OFF): BlenderTool leaves the catalog, both deltas announce removal once, and system prompt stays byte-identical',
    !toolsTurn4.some(t => t.name === 'Blender') &&
      dTools4 !== null &&
      dTools4.removedNames.includes('Blender') &&
      hMap4 !== null &&
      hMap4.removed.some(l => l.includes('Blender lanes are armed')) &&
      j(sysTurn4) === j(sysTurn1),
    j({ dTools4, hMap4 }),
  )

  delete process.env.MERCURY_BLENDER
  delete process.env.MERCURY_GODOT_TOOLS
  delete process.env.MERCURY_BLENDER_BIN
  delete process.env.MERCURY_BOOT_ENV_APPLIED
  resetHarnessMapForTest()
  clearSystemPromptSections()
}

section('§5 live multi-turn session over dist/mercury.mjs — OFF → ON (ToolSearch + BlenderTool) → steady → OFF + real-env pin')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  check('dist/mercury.mjs and node present', false, `${DIST} node=${String(nodeBin)}`)
} else {
  type Body = { system?: unknown; tools?: Array<{ name?: string }>; messages?: Array<{ role?: string; content?: unknown }> }
  const withoutCacheControl = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutCacheControl)
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (k !== 'cache_control') out[k] = withoutCacheControl(v)
      return out
    }
    return value
  }
  const boundTools = (body: Body): unknown =>
    withoutCacheControl((body.tools ?? []).filter((t: { defer_loading?: boolean }) => t.defer_loading !== true))
  const messageTexts = (body: Body, fromIndex = 0): string =>
    (body.messages ?? [])
      .slice(fromIndex)
      .map(m => {
        if (typeof m.content === 'string') return m.content
        if (!Array.isArray(m.content)) return JSON.stringify(m.content)
        return m.content
          .map((b: { type?: string; text?: string; content?: unknown; tool_use_id?: string }) =>
            typeof b.text === 'string' ? b.text : JSON.stringify(b),
          )
          .join('\n')
      })
      .join('\n')

  const fakeBlender = join(SCRATCH, 'fake-blender-wire')
  writeFileSync(fakeBlender, '#!/bin/sh\necho "Blender 4.3.0"\nexit 0\n')
  chmodSync(fakeBlender, 0o755)

  {
    const home = mkdtempSync(join(SCRATCH, 'wire-home-'))
    const cwd = mkdtempSync(join(SCRATCH, 'wire-cwd-'))
    const configDir = join(home, '.mercury')
    mkdirSync(configDir, { recursive: true })
    const bootFile = join(configDir, 'boot-env.json')
    menu.saveBootDefaultsProfile({}, bootFile)

    const turns: ScriptedTurn[] = [
      { kind: 'text', text: 'WIRE-T1-DONE', thinking: 't1-thought', inputTransformations: [] },
      { kind: 'tool_use', name: 'ToolSearch', input: { query: 'select:Blender' }, id: 'tu-ts-blender', whenBody: 'turn two arm check', thinking: 't2a-thought' },
      { kind: 'tool_use', name: 'Blender', input: { op: 'blender_status' }, id: 'tu-bl-status', whenBody: '"tool_use_id":"tu-ts-blender"', thinking: 't2b-thought' },
      { kind: 'text', text: 'WIRE-T2-DONE', whenBody: '"tool_use_id":"tu-bl-status"', thinking: 't2c-thought', inputTransformations: [] },
      { kind: 'text', text: 'WIRE-T3-DONE', whenBody: 'turn three steady check', thinking: 't3-thought', inputTransformations: [] },
      { kind: 'tool_use', name: 'Blender', input: { op: 'blender_status' }, id: 'tu-bl-off', whenBody: 'turn four disarm check', thinking: 't4a-thought' },
      { kind: 'text', text: 'WIRE-T4-DONE', whenBody: '"tool_use_id":"tu-bl-off"', thinking: 't4b-thought', inputTransformations: [] },
    ]
    const fixture = await startFixtureApi([handoffTurn(), ...turns])
    const env: Record<string, string> = {
      HOME: home,
      TMPDIR: home,
      MERCURY_TMPDIR: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_DESKTOP_DRIVER: 'none',
      MERCURY_BLENDER_BIN: fakeBlender,
      MERCURY_TOOL_SEARCH: '1',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_THINKING_BINDING: 'drop_block',
    }
    const run = await runTurns({
      node: nodeBin,
      dist: DIST,
      args: ['--model', 'claude-opus-4-8', '--session-id', '550e8400-e29b-41d4-a716-446655440999'],
      cwd,
      env,
      timeoutMs: 90_000,
      turns: [
        { prompt: 'turn one baseline' },
        {
          prompt: 'turn two arm check',
          before: () => {
            menu.saveBootDefaultsProfile({ MERCURY_BLENDER: '1', MERCURY_WARDS: '0' }, bootFile, { existingSessionsUnchanged: 1 })
          },
        },
        { prompt: 'turn three steady check' },
        {
          prompt: 'turn four disarm check',
          before: () => {
            menu.saveBootDefaultsProfile({}, bootFile, { existingSessionsUnchanged: 1 })
          },
        },
      ],
    })
    const reqs = fixture.messageRequests().filter(q => !isHandoffRequest(q)).map(q => q.body as Body)
    check(
      '4-turn live session exits 0 and completes all 4 turns',
      run.exit === 0 &&
        run.stdout.includes('WIRE-T1-DONE') &&
        run.stdout.includes('WIRE-T2-DONE') &&
        run.stdout.includes('WIRE-T3-DONE') &&
        run.stdout.includes('WIRE-T4-DONE'),
      `exit=${run.exit} reqs=${reqs.length} stderr=${run.stderr.slice(0, 300)}`,
    )
    const r1 = reqs[0]
    const r2a = reqs.find(b => messageTexts(b).includes('turn two arm check') && !messageTexts(b).includes('tu-ts-blender'))
    const r2c = reqs.find(b => messageTexts(b).includes('tu-bl-status'))
    const r3 = reqs.find(b => messageTexts(b).includes('turn three steady check') && !messageTexts(b).includes('turn four disarm check'))
    const r4a = reqs.find(b => messageTexts(b).includes('turn four disarm check') && !messageTexts(b).includes('tu-bl-off'))
    const r4b = reqs.find(b => messageTexts(b).includes('tu-bl-off'))

    check(
      'turn 1 wire request does not advertise Blender',
      r1 !== undefined && !messageTexts(r1).includes('Blender — Blender with no window'),
    )
    const r1Len = r1?.messages?.length ?? 0
    check(
      'turn 2 wire request announces Blender in deferred_tools_delta at the tail once boot-env.json saves MERCURY_BLENDER=1',
      r2a !== undefined && messageTexts(r2a, r1Len).includes('Blender — Blender with no window'),
      r2a ? messageTexts(r2a, r1Len).slice(0, 300) : 'missing r2a',
    )
    check(
      'turn 2 cached prefix holds: system, bound tools, and prior messages prefix are byte-identical to turn 1 (Blender enters deferred)',
      r1 !== undefined &&
        r2a !== undefined &&
        j(withoutCacheControl(r1.system)) === j(withoutCacheControl(r2a.system)) &&
        j(boundTools(r1)) === j(boundTools(r2a)) &&
        (r2a.tools ?? []).some((t: { name?: string; defer_loading?: boolean }) => t.name === 'Blender' && t.defer_loading === true) &&
        (r1.messages ?? []).every((m, i) => j(withoutCacheControl(m)) === j(withoutCacheControl(r2a.messages?.[i]))),
    )
    check(
      'turn 2 ToolSearch admits Blender and BlenderTool executes blender_status with flag: armed (MERCURY_BLENDER)',
      r2c !== undefined && messageTexts(r2c).includes('flag: armed (MERCURY_BLENDER)'),
      r2c ? messageTexts(r2c, r1Len).slice(-400) : 'missing r2c',
    )
    const r2cLen = r2c?.messages?.length ?? 0
    check(
      'turn 3 (unchanged boot-env.json) does not re-announce Blender and keeps system byte-identical',
      r3 !== undefined &&
        r1 !== undefined &&
        !messageTexts(r3, r2cLen).includes('Blender — Blender with no window') &&
        j(withoutCacheControl(r3.system)) === j(withoutCacheControl(r1.system)),
    )
    const r3Len = r3?.messages?.length ?? 0
    check(
      'turn 4 (switched OFF in boot-env.json) announces Blender is no longer available at the tail, keeps cached prefix, and refuses a Blender tool call',
      r4a !== undefined &&
        r4b !== undefined &&
        r1 !== undefined &&
        messageTexts(r4a, r3Len).includes('The following tools are no longer available in this session:\nBlender') &&
        j(withoutCacheControl(r4a.system)) === j(withoutCacheControl(r1.system)) &&
        (r3?.messages ?? []).every((m, i) => j(withoutCacheControl(m)) === j(withoutCacheControl(r4a.messages?.[i]))) &&
        messageTexts(r4b, r3Len).includes('No such tool available: Blender'),
      r4b ? messageTexts(r4b, r3Len).slice(-400) : 'missing r4b',
    )
    await fixture.close()
  }

  {
    const home = mkdtempSync(join(SCRATCH, 'wire-pin-home-'))
    const cwd = mkdtempSync(join(SCRATCH, 'wire-pin-cwd-'))
    const configDir = join(home, '.mercury')
    mkdirSync(configDir, { recursive: true })
    const bootFile = join(configDir, 'boot-env.json')
    menu.saveBootDefaultsProfile({}, bootFile)

    const turns: ScriptedTurn[] = [
      { kind: 'text', text: 'PIN-T1-DONE' },
      { kind: 'text', text: 'PIN-T2-DONE', whenBody: 'pin turn two' },
    ]
    const fixture = await startFixtureApi([handoffTurn(), ...turns])
    const run = await runTurns({
      node: nodeBin,
      dist: DIST,
      args: ['--model', 'claude-opus-4-8'],
      cwd,
      env: {
        HOME: home,
        TMPDIR: home,
        MERCURY_TMPDIR: home,
        PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
        TERM: 'dumb',
        MERCURY_CONFIG_DIR: configDir,
        MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        MERCURY_DESKTOP_DRIVER: 'none',
        MERCURY_BLENDER_BIN: fakeBlender,
        MERCURY_BLENDER: '0',
        MERCURY_TOOL_SEARCH: '1',
        ANTHROPIC_BASE_URL: fixture.url,
        ANTHROPIC_API_KEY: 'fixture-key-000',
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
      },
      timeoutMs: 60_000,
      turns: [
        { prompt: 'pin turn one' },
        {
          prompt: 'pin turn two',
          before: () => {
            menu.saveBootDefaultsProfile({ MERCURY_BLENDER: '1' }, bootFile)
          },
        },
      ],
    })
    const reqs = fixture.messageRequests().filter(q => !isHandoffRequest(q)).map(q => q.body as Body)
    check(
      'wire real-env pin: MERCURY_BLENDER=0 in the runner environment wins over MERCURY_BLENDER=1 saved in boot-env.json',
      run.exit === 0 && reqs.length === 2 && !messageTexts(reqs[1]!).includes('Blender — Blender with no window'),
      `exit=${run.exit} reqs=${reqs.length}`,
    )
    await fixture.close()
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-live-boot-menu — ${checks - failures}/${checks} checks passed`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
