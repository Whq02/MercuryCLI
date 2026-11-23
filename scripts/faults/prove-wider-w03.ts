#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { FAKE_BIN, GIB, MAC_48, QWEN_2B_REPO, fakeWorld } from '../tensorfold/fixtures/world.ts'

;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const serve = await import('../../src/models/tensorfold/serve.ts')
const road = await import('../../src/commands/tensorfold/road.ts')
const scene = await import('../../src/commands/tensorfold/scene.ts')
const panel = await import('../../src/commands/tensorfold/tensorfold.tsx')
const engine = await import('../../src/models/tensorfold/engine.ts')
const receipts = await import('../../src/models/facts/seatReceipts.ts')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

const W03_FIX_HINTS: Array<[string, string]> = [
  ['clean start', 'fix startTensorFold in src/models/tensorfold/serve.ts so a start with no side-step failure returns an empty warnings list'],
  ['clean stop', 'fix stopTensorFold in src/models/tensorfold/serve.ts so a stop with no side-step failure returns an empty warnings list'],
  ['start side-step failures', 'fix serveTensorFoldRow in src/commands/tensorfold/road.ts and startTensorFold in src/models/tensorfold/serve.ts so a failing rememberPort, rememberWindow or announce is returned as a warning and put in the road notice while the start succeeds'],
  ['stop side-step failures', 'fix onTensorFoldAct in src/commands/tensorfold/tensorfold.tsx and stopTensorFold in src/models/tensorfold/serve.ts so a failing pairing stop, forgetPort or forgetHost reaches the notice while the stop succeeds'],
  ['share act', 'fix onTensorFoldAct in src/commands/tensorfold/tensorfold.tsx so the share notice keeps the pairing code and the start warnings'],
  ['stopTensorFold on', 'fix stopTensorFold in src/models/tensorfold/serve.ts so an unreadable or damaged served file resolves with readError and is left as it is, and an absent file has no readError'],
  ['stopTensorFoldRow', 'fix stopTensorFoldRow in src/commands/tensorfold/road.ts so a served record that cannot be read answers the read-error sentence and mints no stopped receipt'],
  ['onTensorFoldAct stop', 'fix onTensorFoldAct in src/commands/tensorfold/tensorfold.tsx so the read-error sentence from the stop reaches the panel notice'],
  ['ENOENT cache folder', 'fix readTensorFoldPanelFacts in src/commands/tensorfold/scene.ts so a missing cache folder sets no readNotice'],
  ['unreadable models folder', 'fix readTensorFoldPanelFacts in src/commands/tensorfold/scene.ts so an unreadable cache folder sets a readNotice naming the path and the error'],
  ['unreadable config.json', 'fix readTensorFoldPanelFacts in src/commands/tensorfold/scene.ts so an unreadable config.json sets a readNotice naming that file'],
  ['helperModelChoices', 'fix helperModelChoices in src/models/roads/local/tensorfoldHelper.ts so an unreadable 2B config gives the could-not-be-read reason, not the not-pulled reason'],
  ['unreadable file stat', 'fix readHfSnapshot in src/models/tensorfold/inventory.ts (onReadError) and readTensorFoldPanelFacts in src/commands/tensorfold/scene.ts so a file whose stat fails is reported and set in the readNotice'],
  ['absent hosts store', 'fix readTensorFoldPanelFacts in src/commands/tensorfold/scene.ts so a missing hosts store sets no readNotice'],
  ['non-object hosts store keeps', 'fix tensorFoldHosts, tensorFoldHostRecords and tensorFoldPorts in src/models/roads/local/tensorfoldHosts.ts so a hosts store that is not an object reads as empty and does not throw'],
  ['non-object hosts store puts', 'fix readTensorFoldPanelFacts in src/commands/tensorfold/scene.ts and the strict reader in src/models/roads/local/tensorfoldHosts.ts so the not-a-JSON-object message reaches readNotice once'],
  ['TensorFoldPanel renders', 'fix TensorFoldPanel in src/commands/tensorfold/tensorfold.tsx so the hosts store error shows in its notice exactly once'],
  ['torn JSON hosts store', 'fix readTensorFoldPanelFacts in src/commands/tensorfold/scene.ts so a torn hosts store names its path and the read error in readNotice'],
  ['EACCES hosts store', 'fix readTensorFoldPanelFacts in src/commands/tensorfold/scene.ts and src/models/roads/local/tensorfoldHosts.ts so an unreadable hosts store reads as empty and names its path and the read error in readNotice'],
]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const fix = cond ? undefined : W03_FIX_HINTS.find(([prefix]) => label.startsWith(prefix))?.[1]
  const shown = !cond && (detail || fix) ? ` — ${[detail.slice(0, 600), fix].filter(Boolean).join(' | ')}` : ''
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown}`)
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

const binary = `${FAKE_BIN}/tensorfold`
const noApp = async (): Promise<{ running: boolean }> => ({ running: false })
engine.__pinTensorFoldMachineForTest(MAC_48)

console.log('w03-1: startTensorFold and stopTensorFold surface side-step failures in result and notice')
{
  const world = fakeWorld('wider-w03-1')
  const servedFile = join(world.home, 'served.json')
  const keyPath = join(world.home, 'api-key')
  const makeKeyFile = () => {
    writeFileSync(keyPath, `mercury[inference]: ${'k'.repeat(32)}\n`, { mode: 0o600 })
    return { path: keyPath, key: 'k'.repeat(32), line: `mercury[inference]: ${'k'.repeat(32)}` }
  }
  const port = await freePort()
  process.env.PATH = world.env.PATH!
  const baseServeIo = {
    binary,
    cwd: world.cwd,
    sessionId: 'proof',
    env: world.env,
    serviceEnv: { ...world.serviceEnv, FAKE_TENSORFOLD_BIND_LOOPBACK: '1' },
    servedFile,
    machine: MAC_48,
    app: noApp,
    freeMemoryBytes: async () => 40 * GIB,
    answersAs: async () => undefined,
    keyFile: makeKeyFile,
    machineName: () => 'studio-w03',
    rememberHost: async () => undefined,
    forgetHost: async () => undefined,
    rememberPort: () => undefined,
    rememberWindow: () => undefined,
    forgetPort: () => undefined,
  }

  const clean = await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, baseServeIo)
  const cleanWarnings = (clean as { warnings?: readonly string[] }).warnings
  check('clean start returns empty warnings list', Array.isArray(cleanWarnings) && cleanWarnings.length === 0, JSON.stringify(cleanWarnings))
  const cleanStopped = await serve.stopTensorFold('qwen3.5-2b', { servedFile, forgetPort: () => undefined, forgetHost: async () => undefined })
  const cleanStopWarnings = (cleanStopped as { warnings?: readonly string[] } | void)?.warnings
  check('clean stop returns empty warnings list', Array.isArray(cleanStopWarnings) && cleanStopWarnings.length === 0, JSON.stringify(cleanStopWarnings))

  road.__resetTensorFoldRoadForTest()
  const facts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: null, env: world.env, home: world.home, servedFile, localModels: () => [], hosts: () => [] })
  const row = { ...facts.rows.find(candidate => candidate.repo === QWEN_2B_REPO)!, port }
  const servedOutcome = await road.serveTensorFoldRow(
    row,
    262_144,
    {
      serve: {
        ...baseServeIo,
        rememberPort: () => { throw new Error('port-store-ro') },
        rememberWindow: () => { throw new Error('window-store-ro') },
        announce: async () => { throw new Error('mdns-down') },
      },
      prove: { env: { ...world.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' }, persist: () => ({ sentence: ' · saved' }), setAppState: () => undefined, focusedConnector: () => ({ carrier: 'in-process' }) as never },
    },
    { share: true },
  )
  const startWarnings = (servedOutcome?.served as { warnings?: readonly string[] } | undefined)?.warnings ?? []
  const startNotice = road.tensorFoldRoadState().notice ?? ''
  check(
    'start side-step failures (rememberPort, rememberWindow, announce) are returned and put in the notice while start succeeds',
    servedOutcome !== null &&
      startWarnings.some(w => w.includes('port-store-ro')) &&
      startWarnings.some(w => w.includes('window-store-ro')) &&
      startWarnings.some(w => w.includes('mdns-down')) &&
      startNotice.includes('port-store-ro') &&
      startNotice.includes('window-store-ro') &&
      startNotice.includes('mdns-down'),
    JSON.stringify({ startWarnings, startNotice }),
  )
  await serve.stopTensorFold('qwen3.5-2b', { servedFile, forgetPort: () => undefined, forgetHost: async () => undefined })

  await serve.startTensorFold(
    { repo: QWEN_2B_REPO, window: 262_144, port, share: true },
    {
      ...baseServeIo,
      announce: async () => ({
        code: '123456',
        stop: () => Promise.reject(new Error('pairing-close-failed')),
      }),
    },
  )
  road.__resetTensorFoldRoadForTest()
  const liveFacts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: null, env: world.env, home: world.home, servedFile, localModels: () => [], hosts: () => [] })
  const liveRow = liveFacts.rows.find(candidate => candidate.repo === QWEN_2B_REPO)!
  await panel.onTensorFoldAct(
    { kind: 'stop', row: liveRow },
    liveFacts,
    {
      serve: {
        servedFile,
        forgetPort: () => { throw new Error('forget-port-ro') },
        forgetHost: async () => { throw new Error('forget-host-ro') },
      },
    },
  )
  const stopNotice = road.tensorFoldRoadState().notice ?? ''
  check(
    'stop side-step failures (pairing.stop, forgetPort, forgetShared) surface in the TensorFold notice while stop succeeds',
    serve.servedTensorFold({ servedFile }).length === 0 &&
      stopNotice.includes('stopped qwen3.5-2b') &&
      stopNotice.includes('pairing-close-failed') &&
      stopNotice.includes('forget-port-ro') &&
      stopNotice.includes('forget-host-ro'),
    JSON.stringify({ stopNotice, remaining: serve.servedTensorFold({ servedFile }).length }),
  )

  await serve.startTensorFold({ repo: QWEN_2B_REPO, window: 262_144, port }, baseServeIo)
  road.__resetTensorFoldRoadForTest()
  const shareFacts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: null, env: world.env, home: world.home, servedFile, localModels: () => [], hosts: () => [] })
  const shareRow = shareFacts.rows.find(candidate => candidate.repo === QWEN_2B_REPO)!
  await panel.onTensorFoldAct(
    { kind: 'share', row: shareRow },
    shareFacts,
    {
      serve: {
        ...baseServeIo,
        rememberPort: () => { throw new Error('share-port-ro') },
        announce: async () => ({ code: '654321', stop: () => undefined }),
      },
      prove: { env: { ...world.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' }, persist: () => ({ sentence: ' · saved' }), setAppState: () => undefined, focusedConnector: () => ({ carrier: 'in-process' }) as never },
    },
  )
  const shareNotice = road.tensorFoldRoadState().notice ?? ''
  check(
    'share act keeps both the pairing code and start side-step warnings in the notice',
    shareNotice.includes('654321') && shareNotice.includes('share-port-ro'),
    JSON.stringify(shareNotice),
  )
  await serve.stopTensorFold('qwen3.5-2b', { servedFile, forgetPort: () => undefined, forgetHost: async () => undefined })
}

console.log('w03-2: stopTensorFold reports an unreadable or damaged served record instead of claiming stopped')
{
  const world = fakeWorld('wider-w03-2')
  const corruptFile = join(world.home, 'corrupt-served.json')
  writeFileSync(corruptFile, '{"repo": "broken', 'utf8')
  const stopResult = await serve.stopTensorFold('qwen3.5-2b', { servedFile: corruptFile }) as { warnings?: readonly string[]; readError?: string }
  check(
    'stopTensorFold on damaged served.json resolves with readError and leaves file intact',
    typeof stopResult?.readError === 'string' && stopResult.readError.length > 0 && readFileSync(corruptFile, 'utf8') === '{"repo": "broken',
    JSON.stringify(stopResult),
  )
  const seenReceipts: string[] = []
  const unsub = receipts.subscribeSeatReceipts(r => seenReceipts.push(r.text))
  const receiptsBefore = seenReceipts.length
  const fakeServed = [{ repo: QWEN_2B_REPO, name: 'qwen3.5-2b', port: 18080, window: 262_144, pid: 99999, startedAt: new Date().toISOString() }]
  road.__resetTensorFoldRoadForTest()
  const rowMsg = await road.stopTensorFoldRow({ repo: QWEN_2B_REPO, shortName: 'qwen3.5-2b' }, fakeServed, { serve: { servedFile: corruptFile } })
  const mintedAfter = seenReceipts.slice(receiptsBefore)
  check(
    'stopTensorFoldRow answers the read-error sentence instead of "stopped <name>" and mints no stopped receipt',
    rowMsg.startsWith('the record of what is already serving could not be read (') &&
      rowMsg.endsWith(') · nothing was stopped') &&
      !rowMsg.includes('stopped qwen3.5-2b') &&
      mintedAfter.every(t => !t.includes('stopped qwen3.5-2b')),
    JSON.stringify({ rowMsg, mintedAfter }),
  )
  const facts = await scene.readTensorFoldPanelFacts({ cacheRoot: world.cache, machine: MAC_48, engine: null, env: world.env, home: world.home, servedFile: corruptFile, served: fakeServed, localModels: () => [], hosts: () => [] })
  const row = facts.rows.find(candidate => candidate.repo === QWEN_2B_REPO)!
  await panel.onTensorFoldAct({ kind: 'stop', row }, facts, { serve: { servedFile: corruptFile } })
  const notice = road.tensorFoldRoadState().notice ?? ''
  check(
    'onTensorFoldAct stop puts the read-error sentence in the panel notice',
    notice.startsWith('the record of what is already serving could not be read (') && notice.endsWith(') · nothing was stopped'),
    JSON.stringify(notice),
  )
  unsub()
  if (POSIX_MODES) {
    const lockedFile = join(world.home, 'locked-served.json')
    writeFileSync(lockedFile, '{"repo":"org/m","name":"m","port":8080,"window":32768,"pid":1,"startedAt":"2026-01-01T00:00:00Z","project":"/tmp"}\n', 'utf8')
    chmodSync(lockedFile, 0o000)
    const lockedResult = await serve.stopTensorFold('m', { servedFile: lockedFile }) as { warnings?: readonly string[]; readError?: string }
    chmodSync(lockedFile, 0o600)
    check(
      'stopTensorFold on EACCES served.json resolves with readError',
      typeof lockedResult?.readError === 'string' && lockedResult.readError.length > 0,
      JSON.stringify(lockedResult),
    )
  }
  const absentResult = await serve.stopTensorFold('m', { servedFile: join(world.home, 'absent.json') }) as { warnings?: readonly string[]; readError?: string }
  check('stopTensorFold on absent served.json has no readError', absentResult?.readError === undefined, JSON.stringify(absentResult))
}

console.log('w03-3: inventory read failures (listDir, readText, sizeOf) surface in scene notice and helper instead of silent absence')
{
  const inventory = await import('../../src/models/tensorfold/inventory.ts')
  const helper = await import('../../src/models/roads/local/tensorfoldHelper.ts')
  const world = fakeWorld('wider-w03-3')
  const absentCache = join(world.root, 'absent-hf-cache')
  const absentFacts = await scene.readTensorFoldPanelFacts({
    cacheRoot: absentCache,
    machine: MAC_48,
    engine: null,
    env: world.env,
    home: world.home,
    servedFile: join(world.home, 'served.json'),
    localModels: () => [],
    hosts: () => [],
  }) as { readNotice?: string }
  check('ENOENT cache folder produces no readNotice', absentFacts.readNotice === undefined, JSON.stringify(absentFacts.readNotice))

  if (POSIX_MODES) {
    const lockedCache = join(world.root, 'locked-hf-cache')
    mkdirSync(lockedCache, { recursive: true })
    chmodSync(lockedCache, 0o000)
    const dirFacts = await scene.readTensorFoldPanelFacts({
      cacheRoot: lockedCache,
      machine: MAC_48,
      engine: null,
      env: world.env,
      home: world.home,
      servedFile: join(world.home, 'served.json'),
      localModels: () => [],
      hosts: () => [],
    }) as { readNotice?: string }
    chmodSync(lockedCache, 0o700)
    check(
      'unreadable models folder sets scene readNotice naming path and error',
      typeof dirFacts.readNotice === 'string' &&
        dirFacts.readNotice.startsWith(`${lockedCache} could not be read (`) &&
        dirFacts.readNotice.endsWith('), so the models in it are not listed'),
      JSON.stringify(dirFacts.readNotice),
    )

    const cfgWorld = fakeWorld('wider-w03-3-cfg')
    const cfgPath = join(cfgWorld.cache, 'models--mlx-community--Qwen3.5-2B-MLX-4bit', 'snapshots', '93760be4f1f69842a46bc13dbdc0f19e291392a3', 'config.json')
    chmodSync(cfgPath, 0o000)
    const cfgFacts = await scene.readTensorFoldPanelFacts({
      cacheRoot: cfgWorld.cache,
      machine: MAC_48,
      engine: null,
      env: cfgWorld.env,
      home: cfgWorld.home,
      servedFile: join(cfgWorld.home, 'served.json'),
      localModels: () => [],
      hosts: () => [],
    }) as { readNotice?: string }
    const prevHub = process.env.HF_HUB_CACHE
    process.env.HF_HUB_CACHE = cfgWorld.cache
    const twoBChoice = helper.helperModelChoices({ usable: 36 * GIB, session: null, banked4b: false, engineFound: true, adapter: false }).find(choice => choice.size === '2b')
    if (prevHub === undefined) delete process.env.HF_HUB_CACHE
    else process.env.HF_HUB_CACHE = prevHub
    chmodSync(cfgPath, 0o600)
    check(
      'unreadable config.json sets scene readNotice naming config.json',
      typeof cfgFacts.readNotice === 'string' &&
        cfgFacts.readNotice.startsWith(`${cfgPath} could not be read (`) &&
        cfgFacts.readNotice.endsWith('), so the models in it are not listed'),
      JSON.stringify(cfgFacts.readNotice),
    )
    check(
      'helperModelChoices reports unreadable 2B config instead of "pull the 2B in /tensorfold"',
      typeof twoBChoice?.reason === 'string' &&
        twoBChoice.reason.includes('could not be read (') &&
        twoBChoice.reason !== helper.HELPER_2B_NOT_PULLED_REASON,
      JSON.stringify(twoBChoice),
    )

    const statWorld = fakeWorld('wider-w03-3-stat')
    const snapDir = join(statWorld.cache, 'models--mlx-community--Qwen3.5-2B-MLX-4bit', 'snapshots', '93760be4f1f69842a46bc13dbdc0f19e291392a3')
    const lockedTargetDir = join(statWorld.root, 'locked-target')
    mkdirSync(lockedTargetDir, { recursive: true })
    writeFileSync(join(lockedTargetDir, 'extra.safetensors'), 'x')
    const badLink = join(snapDir, 'extra.safetensors')
    symlinkSync(join(lockedTargetDir, 'extra.safetensors'), badLink)
    chmodSync(lockedTargetDir, 0o000)
    const statErrors: Array<{ path: string; error: string }> = []
    inventory.readHfSnapshot(statWorld.cache, QWEN_2B_REPO, { onReadError: failure => statErrors.push(failure) })
    const statFacts = await scene.readTensorFoldPanelFacts({
      cacheRoot: statWorld.cache,
      machine: MAC_48,
      engine: null,
      env: statWorld.env,
      home: statWorld.home,
      servedFile: join(statWorld.home, 'served.json'),
      localModels: () => [],
      hosts: () => [],
    }) as { readNotice?: string }
    chmodSync(lockedTargetDir, 0o700)
    check(
      'unreadable file stat (EACCES) reports readError in readHfSnapshot and scene readNotice',
      statErrors.some(item => item.path === badLink) &&
        typeof statFacts.readNotice === 'string' &&
        statFacts.readNotice.startsWith(`${badLink} could not be read (`) &&
        statFacts.readNotice.endsWith('), so the models in it are not listed'),
      JSON.stringify({ statErrors, readNotice: statFacts.readNotice }),
    )
  }
}

console.log('w03-4: unreadable or damaged tensorfold-hosts.json keeps readers empty and surfaces strict error once in screen notice')
{
  const hostsMod = await import('../../src/models/roads/local/tensorfoldHosts.ts')
  const { getMercuryHome } = await import('../../src/platform/environment/envUtils.js')
  const world = fakeWorld('wider-w03-4')
  const storeFile = join(getMercuryHome(), 'local-setup', 'tensorfold-hosts.json')
  mkdirSync(join(getMercuryHome(), 'local-setup'), { recursive: true })
  rmSync(storeFile, { force: true })

  const absentFacts = await scene.readTensorFoldPanelFacts({
    cacheRoot: world.cache,
    machine: MAC_48,
    engine: null,
    env: world.env,
    home: world.home,
    servedFile: join(world.home, 'served.json'),
    localModels: () => [],
  }) as { readNotice?: string }
  check('absent hosts store produces no readNotice', absentFacts.readNotice === undefined, JSON.stringify(absentFacts.readNotice))

  writeFileSync(storeFile, '[]\n', { mode: 0o600 })
  check(
    'non-object hosts store keeps readers returning empty without throwing',
    hostsMod.tensorFoldHosts().length === 0 && hostsMod.tensorFoldHostRecords().length === 0 && hostsMod.tensorFoldPorts().length === 0,
  )
  const badObjFacts = await scene.readTensorFoldPanelFacts({
    cacheRoot: world.cache,
    machine: MAC_48,
    engine: null,
    env: world.env,
    home: world.home,
    servedFile: join(world.home, 'served.json'),
    localModels: () => [],
  }) as { readNotice?: string }
  const expectedNonObj = `TensorFold hosts store at ${storeFile} is not a JSON object`
  check(
    'non-object hosts store puts strict error message in scene readNotice once',
    badObjFacts.readNotice === expectedNonObj && badObjFacts.readNotice.split(expectedNonObj).length === 2,
    JSON.stringify(badObjFacts.readNotice),
  )

  const React = await import('react')
  const { Box } = await import('../../src/screen/themedRenderer.ts')
  const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
  const { mountOffscreen, settle, waitFor } = await import('../lib/settingsPopupHarness.ts')
  road.__resetTensorFoldRoadForTest()
  const mounted = await mountOffscreen(
    React.createElement(
      AppStateProvider as never,
      {},
      React.createElement(
        ThemeProvider as never,
        {},
        React.createElement(
          Box,
          { flexDirection: 'column', width: 160, height: 48, justifyContent: 'center' },
          React.createElement(panel.TensorFoldPanel as never, {
            onDone: () => undefined,
            io: {
              facts: {
                cacheRoot: world.cache,
                machine: MAC_48,
                engine: null,
                env: world.env,
                home: world.home,
                platform: 'darwin' as const,
                servedFile: join(world.home, 'served.json'),
                localModels: () => [],
                app: async () => ({ running: false }),
                diskFreeBytes: () => 37_578_240_000,
              },
              road: {},
              current: () => 'claude-opus-5-5',
            },
          } as never),
        ),
      ),
    ),
    160,
    48,
  )
  await waitFor(() => mounted.lines().some(line => line.includes('TENSORFOLD')), 10_000)
  await settle(250)
  const rawLines = mounted.lines()
  const screenText = rawLines.map(line => line.replace(/[│╭╮╰╯─]/g, ' ').trim()).join(' ').replace(/\s+/g, ' ')
  mounted.unmount()
  await settle(100)
  const occurrences = screenText.split('is not a JSON object').length - 1
  check(
    'TensorFoldPanel renders the hosts store error in its notice once',
    screenText.includes('TensorFold hosts store at') && occurrences === 1,
    JSON.stringify({ occurrences, matchingLines: rawLines.filter(l => l.includes('TensorFold hosts store') || l.includes('not a JSON object')) }),
  )

  writeFileSync(storeFile, '{ torn-json', { mode: 0o600 })
  const tornFacts = await scene.readTensorFoldPanelFacts({
    cacheRoot: world.cache,
    machine: MAC_48,
    engine: null,
    env: world.env,
    home: world.home,
    servedFile: join(world.home, 'served.json'),
    localModels: () => [],
  }) as { readNotice?: string }
  check(
    'torn JSON hosts store names store path and read error in readNotice',
    typeof tornFacts.readNotice === 'string' && tornFacts.readNotice.startsWith(`TensorFold hosts store at ${storeFile} could not be read (`),
    JSON.stringify(tornFacts.readNotice),
  )

  if (POSIX_MODES) {
    chmodSync(storeFile, 0o000)
    const eaccesFacts = await scene.readTensorFoldPanelFacts({
      cacheRoot: world.cache,
      machine: MAC_48,
      engine: null,
      env: world.env,
      home: world.home,
      servedFile: join(world.home, 'served.json'),
      localModels: () => [],
    }) as { readNotice?: string }
    chmodSync(storeFile, 0o600)
    check(
      'EACCES hosts store keeps readers empty and surfaces error in readNotice',
      typeof eaccesFacts.readNotice === 'string' && eaccesFacts.readNotice.startsWith(`TensorFold hosts store at ${storeFile} could not be read (`),
      JSON.stringify(eaccesFacts.readNotice),
    )
  }

  rmSync(storeFile, { force: true })
}

console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: prove-wider-w03`)
process.exit(failures === 0 ? 0 : 1)
