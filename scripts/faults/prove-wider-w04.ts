#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w04-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.HF_TOKEN
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function withServer(
  handler: (req: { url?: string; headers: Record<string, string | string[] | undefined> }) => { status: number; body: string; contentType?: string },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    const reply = handler(req)
    res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json' })
    res.end(reply.body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

try {
  {
    const { chooseWeightsSource } = await import('../../src/models/hosting/weightsSource.ts')
    const { runLocalSetupRoad } = await import('../../src/models/local-setup/ggufRoad.ts')
    const { runModelDoor } = await import('../../src/models/hosting/door.ts')
    const { HOST_RECIPES } = await import('../../src/models/hosting/recipes.ts')
    const recipe = HOST_RECIPES.find(row => row.engine === 'llamacpp')!
    const secretsFile = join(home, '.provider-secrets.json')

    let absentPrivateLabel = ''
    await chooseWeightsSource(
      { recipe, vendor: 'runpod', managed: false },
      undefined,
      async plan => {
        absentPrivateLabel = plan.rows?.find(row => row.value === 'private-repo')?.label ?? ''
        return 'back'
      },
      () => {},
      new AbortController().signal,
    )
    check(
      'w04-1 absent HF key still labels private-repo with /logins huggingface',
      absentPrivateLabel.includes('/logins huggingface') && !absentPrivateLabel.includes('could not be read'),
      absentPrivateLabel,
    )

    writeFileSync(secretsFile, '{not valid json\n', { mode: 0o600 })
    try {
      const emitted: string[] = []
      let stepCount = 0
      let unreadableLabel = ''
      await chooseWeightsSource(
        { recipe, vendor: 'runpod', managed: false },
        undefined,
        async plan => {
          stepCount++
          if (stepCount === 1) {
            unreadableLabel = plan.rows?.find(row => row.value === 'private-repo')?.label ?? ''
            return 'private-repo'
          }
          return 'back'
        },
        event => { emitted.push(event.words) },
        new AbortController().signal,
      )
      check(
        'w04-1 weightsSource reports unreadable HF key without claiming a request went out',
        unreadableLabel.startsWith('Private repository · unavailable · the Hugging Face key could not be read (') &&
          !unreadableLabel.includes('so this went out without it') &&
          emitted.some(words => words.includes('the Hugging Face key could not be read (') && !words.includes('so this went out without it')),
        JSON.stringify({ unreadableLabel, emitted }),
      )

      await withServer(
        req => {
          if (req.url?.startsWith('/api/models?')) {
            return {
              status: 200,
              body: JSON.stringify([
                {
                  id: 'org/gated-chat',
                  downloads: 500,
                  gated: 'manual',
                  private: false,
                  pipeline_tag: 'text-generation',
                  tags: ['text-generation'],
                  siblings: [{ rfilename: 'model-Q4_K_M.gguf' }],
                },
              ]),
            }
          }
          return { status: 403, body: JSON.stringify({ error: 'gated' }) }
        },
        async baseUrl => {
          let ggufEnded = ''
          for await (const event of runLocalSetupRoad(async () => 'stop', {
            repo: 'org/gated-chat',
            hubBase: baseUrl,
            home,
            platform: 'darwin',
            totalMemoryBytes: 64 * 1024 ** 3,
          })) {
            if (event.type === 'done') ggufEnded = event.summary.words
          }
          check(
            'w04-1 ggufRoad appends unreadable HF key note on failed repo lookup',
            ggufEnded.includes('the Hugging Face key could not be read (') && ggufEnded.includes('so this went out without it'),
            ggufEnded,
          )

          const prevBase = process.env.MERCURY_HOST_HF_API_BASE
          process.env.MERCURY_HOST_HF_API_BASE = baseUrl
          try {
            let doorWillRun = ''
            let phase = 0
            await runModelDoor(
              async plan => {
                if (plan.step !== 'door-models') return null
                if (phase === 0) {
                  phase = 1
                  return 'search:gated'
                }
                if (phase === 1) {
                  if (plan.rows?.some(row => row.value === 'hf:org/gated-chat')) {
                    phase = 2
                    return 'hf:org/gated-chat'
                  }
                  return new Promise<string | null>(() => {})
                }
                doorWillRun = plan.willRun
                return null
              },
              () => {},
              new AbortController().signal,
              {
                offers: async () => [],
                pods: async () => [],
                records: () => [],
                road: async () => ({ ok: false, words: 'unused' }),
              },
            )
            check(
              'w04-1 door appends unreadable HF key note on gated HF pick',
              doorWillRun.includes('the Hugging Face key could not be read (') && doorWillRun.includes('so this went out without it'),
              doorWillRun,
            )
          } finally {
            if (prevBase === undefined) delete process.env.MERCURY_HOST_HF_API_BASE
            else process.env.MERCURY_HOST_HF_API_BASE = prevBase
          }
        },
      )
    } finally {
      chmodSync(secretsFile, 0o600)
      rmSync(secretsFile, { force: true })
    }
  }

  {
    const { runpodFixture } = await import('../host/runpodFixture.mjs')
    const { createHostRoad } = await import('../../src/models/hosting/index.ts')
    const { sweepHostIdle, HOST_IDLE_LIMIT_MS } = await import('../../src/models/hosting/idle.ts')
    const { writeHostRecord, readHostRecord, removeHostRecord } = await import('../../src/models/hosting/store.ts')
    const { saveVendorKey, vendorClient } = await import('../../src/models/hosting/vendors/client.ts')
    const rp = await runpodFixture()
    const daemonDir = join(home, 'daemon')
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 })
    const workersFile = join(daemonDir, 'concourse-workers.json')
    writeFileSync(workersFile, '{corrupt json\n', { mode: 0o600 })
    try {
      saveVendorKey('runpod', rp.key)
      const api = vendorClient('runpod', { key: rp.key, apiBaseUrl: rp.baseUrl })
      const offer = (await api.offers(new AbortController().signal))[0]!
      const sessionId = '22222222-2222-4222-8222-222222222222'
      const hostedModel = 'compat/pod-w04/qwen'
      const priorModel = 'compat/local/base'

      const pod1 = await api.create(offer, 'ssh-ed25519 fixture', 'w04-idle-restore')
      const oldAt = Date.now() - HOST_IDLE_LIMIT_MS - 60_000
      writeHostRecord({
        id: pod1.id,
        vendor: 'runpod',
        name: pod1.name,
        recipe: offer.recipe.id,
        price: pod1.cost,
        startedAt: new Date(oldAt).toISOString(),
        status: 'RUNNING',
        jobState: 'ready',
        steps: [{ step: 'ready', at: oldAt }],
        advancedAt: oldAt,
        apiBaseUrl: rp.baseUrl,
        sessionId,
        sessionModel: hostedModel,
        sessionModelBefore: priorModel,
      })
      await sweepHostIdle({ now: Date.now() })
      const afterIdle = readHostRecord(pod1.id)
      check(
        'w04-2 idle termination adds restore failure sentence when session cannot be switched back',
        Boolean(afterIdle?.error?.includes(' · this session stays on a model that is gone (')) &&
          Boolean(afterIdle?.error?.includes(') — run /model ' + priorModel)),
        afterIdle?.error ?? '(no error)',
      )
      removeHostRecord(pod1.id)

      const pod2 = await api.create(offer, 'ssh-ed25519 fixture', 'w04-road-restore')
      writeHostRecord({
        id: pod2.id,
        vendor: 'runpod',
        name: pod2.name,
        recipe: offer.recipe.id,
        price: pod2.cost,
        startedAt: pod2.createdAt,
        status: 'RUNNING',
        jobState: 'ready',
        apiBaseUrl: rp.baseUrl,
        sessionId,
        sessionModel: hostedModel,
        sessionModelBefore: priorModel,
      })
      const road = createHostRoad({ apiBaseUrl: rp.baseUrl, pauseMs: 1 })
      const result = await road(
        async q => {
          if (q.step === 'door-models') return 'pods'
          if (q.step === 'paid-pods') return pod2.id
          if (q.step === 'pod-controls' || q.step === 'pod-confirm') return 'terminate'
          return null
        },
        () => {},
        new AbortController().signal,
      )
      check(
        'w04-2 host road termination adds restore failure sentence when session cannot be switched back',
        result.ok &&
          result.words.includes(' · this session stays on a model that is gone (') &&
          result.words.includes(') — run /model ' + priorModel),
        result.words,
      )
    } finally {
      rmSync(workersFile, { force: true })
      await rp.close()
    }
  }

  {
    const { runpodFixture } = await import('../host/runpodFixture.mjs')
    const { createHostRoad } = await import('../../src/models/hosting/index.ts')
    const { sweepHostIdle, HOST_IDLE_LIMIT_MS } = await import('../../src/models/hosting/idle.ts')
    const { terminateTensorFoldPod } = await import('../../src/models/hosting/tensorfoldPod.ts')
    const { removeHostEndpoint } = await import('../../src/models/hosting/door.ts')
    const { writeHostRecord, readHostRecord, removeHostRecord } = await import('../../src/models/hosting/store.ts')
    const { saveVendorKey, vendorClient } = await import('../../src/models/hosting/vendors/client.ts')
    const { HostVendorHttpError } = await import('../../src/models/hosting/vendors/http.ts')
    const { updateSettingsForSource } = await import('../../src/platform/settings/settings.ts')
    const { bumpCatalogueEpoch } = await import('../../src/models/roads/catalogueEpoch.ts')
    const { configuredCompatEndpoints } = await import('../../src/models/roads/openaicompat/compatAccounts.ts')
    const { refreshCompatCatalogues } = await import('../../src/models/roads/openaicompat/compatCatalogue.ts')

    const localSetupDir = join(home, 'local-setup')
    mkdirSync(localSetupDir, { recursive: true, mode: 0o700 })
    const tfHostsFile = join(localSetupDir, 'tensorfold-hosts.json')
    writeFileSync(tfHostsFile, '{not valid json\n', { mode: 0o600 })
    const rp = await runpodFixture()
    const registerProvider = (name: string, podId: string): void => {
      updateSettingsForSource('userSettings', raw => ({
        compatProvider: {
          ...(typeof raw.compatProvider === 'object' && raw.compatProvider !== null ? raw.compatProvider : {}),
          [name]: { baseUrl: 'http://127.0.0.1:1/v1', label: name, dialect: 'chat-completions', hostPodId: podId },
        },
      }))
      bumpCatalogueEpoch()
    }
    try {
      saveVendorKey('runpod', rp.key)
      const api = vendorClient('runpod', { key: rp.key, apiBaseUrl: rp.baseUrl })
      const offer = (await api.offers(new AbortController().signal))[0]!

      const podIdle = await api.create(offer, 'ssh-ed25519 fixture', 'w04-unreg-idle')
      registerProvider('pod-unreg-idle', podIdle.id)
      const oldAt = Date.now() - HOST_IDLE_LIMIT_MS - 60_000
      writeHostRecord({
        id: podIdle.id,
        vendor: 'runpod',
        name: podIdle.name,
        recipe: offer.recipe.id,
        price: podIdle.cost,
        startedAt: new Date(oldAt).toISOString(),
        status: 'RUNNING',
        jobState: 'ready',
        steps: [{ step: 'ready', at: oldAt }],
        advancedAt: oldAt,
        apiBaseUrl: rp.baseUrl,
        provider: 'pod-unreg-idle',
      })
      await sweepHostIdle({ now: Date.now() })
      const idleAfter = readHostRecord(podIdle.id)
      check(
        'w04-3 idle termination reports failed TensorFold host unregister',
        Boolean(idleAfter?.error?.includes('it is still listed in the TensorFold hosts (')) &&
          Boolean(idleAfter?.error?.includes(') — remove it there')),
        idleAfter?.error ?? '(no error)',
      )
      removeHostRecord(podIdle.id)

      const podRoad = await api.create(offer, 'ssh-ed25519 fixture', 'w04-unreg-road')
      registerProvider('pod-unreg-road', podRoad.id)
      writeHostRecord({
        id: podRoad.id,
        vendor: 'runpod',
        name: podRoad.name,
        recipe: offer.recipe.id,
        price: podRoad.cost,
        startedAt: podRoad.createdAt,
        status: 'RUNNING',
        jobState: 'ready',
        apiBaseUrl: rp.baseUrl,
        provider: 'pod-unreg-road',
      })
      const road = createHostRoad({ apiBaseUrl: rp.baseUrl, pauseMs: 1 })
      const roadResult = await road(
        async q => {
          if (q.step === 'door-models') return 'pods'
          if (q.step === 'paid-pods') return podRoad.id
          if (q.step === 'pod-controls' || q.step === 'pod-confirm') return 'terminate'
          return null
        },
        () => {},
        new AbortController().signal,
      )
      check(
        'w04-3 host road termination reports failed TensorFold host unregister',
        roadResult.ok &&
          roadResult.words.includes('it is still listed in the TensorFold hosts (') &&
          roadResult.words.includes(') — remove it there'),
        roadResult.words,
      )

      const goneClient = {
        vendor: 'runpod',
        label: 'Runpod',
        keyHelp: '',
        capabilities: { stop: true, dataCenters: true, persistentDisk: 'volume' },
        rateLimitPolicy: () => undefined,
        shapes: () => [],
        offers: async () => [],
        watchOffer: async () => undefined,
        pods: async () => [],
        get: async () => { throw new HostVendorHttpError('Runpod GET /pods returned HTTP 404', 404) },
        create: async () => { throw new Error('unused') },
        stop: async () => { throw new Error('unused') },
        terminate: async () => {},
        logs: async () => '',
      } as never
      const podTfId = 'tf-unreg-fail-1'
      registerProvider('pod-unreg-tf', podTfId)
      writeHostRecord({
        id: podTfId,
        vendor: 'runpod',
        name: 'tf-unreg-fail',
        recipe: 'tensorfold-qwen',
        price: 2.0,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        status: 'RUNNING',
        provider: 'pod-unreg-tf',
      })
      let tfWords = ''
      let tfOk = false
      try {
        const tfRes = await terminateTensorFoldPod(podTfId, { client: goneClient })
        tfOk = tfRes.ok
        tfWords = tfRes.words
      } catch (error) {
        tfWords = 'THREW: ' + (error instanceof Error ? error.message : String(error))
      }
      check(
        'w04-3 terminateTensorFoldPod reports failed TensorFold host unregister without throwing',
        tfOk &&
          tfWords.includes('it is still listed in the TensorFold hosts (') &&
          tfWords.includes(') — remove it there'),
        tfWords,
      )

      registerProvider('pod-unreg-door', 'pod-door-1')
      const ep = configuredCompatEndpoints().find(row => row.name === 'pod-unreg-door')
      if (ep) await refreshCompatCatalogues({ name: ep.name, force: true })
      const doorRemoved = await removeHostEndpoint('pod-unreg-door')
      check(
        'w04-3 removeHostEndpoint reports failed TensorFold host unregister',
        doorRemoved.includes('it is still listed in the TensorFold hosts (') &&
          doorRemoved.includes(') — remove it there'),
        doorRemoved,
      )
    } finally {
      rmSync(tfHostsFile, { force: true })
      await rp.close()
    }
  }

  {
    const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
    const { acceptInput } = await import('../../src/daemon/runner/inputDoor.ts')
    const { createRunnerState } = await import('../../src/daemon/runner/runnerPorts.ts')
    const { INPUT_REFUSED_CODE } = await import('../../src/daemon/runner/structuredIO.ts')
    const { getSessionId, setOriginalCwd } = await import('../../src/boot/process-state/processState.ts')
    const { getTranscriptPath } = await import('../../src/sessions/transcripts/paths.ts')
    const { clearSessionMessagesCache } = await import('../../src/sessions/transcripts/sessionListings.ts')
    const { getCommandQueue, remove } = await import('../../src/daemon/runner/messageQueueManager.ts')
    const { dirname } = await import('node:path')
    const { randomUUID } = await import('node:crypto')

    const testSid = getSessionId()
    const projCwd = join(scratch, 'input-door-proj')
    mkdirSync(projCwd, { recursive: true })
    setOriginalCwd(projCwd)
    const transcriptPath = getTranscriptPath()
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, JSON.stringify({ uuid: randomUUID(), type: 'user', message: { role: 'user', content: 'hi' } }) + '\n', { mode: 0o600 })
    clearSessionMessagesCache()

    if (POSIX_MODES) {
      chmodSync(transcriptPath, 0o000)
      try {
        remove([...getCommandQueue()])
        const live = createRunnerState()
        const received = new Set<string>()
        const enqueuedRows: Array<{ type?: string; level?: string; text?: string; code?: string }> = []
        const ports = {
          live,
          options: {},
          driver: { kick: () => {}, isRunning: () => false, closeOutputOnce: async () => {} },
          enqueueRow: (row: { type?: string; level?: string; text?: string; code?: string }) => { enqueuedRows.push(row) },
          liveScope: () => ({ session_id: testSid }),
          getAppState: () => ({}),
          setAppState: () => {},
          localCommandInput: () => false,
          missionLineOf: () => null,
          receivedUuids: { add: (id: string) => void received.add(id), has: (id: string) => received.has(id) },
        } as unknown as Parameters<typeof acceptInput>[1]

        const first = await acceptInput({ kind: 'prompt', content: 'first line', id: randomUUID() }, ports)
        clearSessionMessagesCache()
        const second = await acceptInput({ kind: 'prompt', content: 'second line', id: randomUUID() }, ports)
        const queued = [...getCommandQueue()]
        remove(queued)
        const warnings = enqueuedRows.filter(r => r.level === 'warning' && r.code !== INPUT_REFUSED_CODE)
        check(
          'w04-4 acceptInput still accepts and queues rows when transcript is unreadable and emits warning notice once per session',
          first.accepted === true &&
            second.accepted === true &&
            queued.length === 2 &&
            warnings.length === 1 &&
            Boolean(warnings[0]?.text?.includes(`the transcript at ${transcriptPath} could not be read (`)) &&
            Boolean(warnings[0]?.text?.includes('), so this message was not checked for a duplicate')),
          JSON.stringify({ first, second, queuedCount: queued.length, enqueuedRows }),
        )
      } finally {
        chmodSync(transcriptPath, 0o600)
        rmSync(transcriptPath, { force: true })
        clearSessionMessagesCache()
      }
    }
  }

  {
    const { call: localMission } = await import('../../src/commands/mission/mission.ts')
    const { call: jsxMission } = await import('../../src/commands/mission/mission-jsx.tsx')
    const { answerSessionFacts } = await import('../../src/daemon/runner/sessionFactsArm.ts')
    const { createRunnerState } = await import('../../src/daemon/runner/runnerPorts.ts')
    const { sessionFactsFromWire } = await import('../../src/engine/connector/seatWire.ts')
    const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.ts')
    const { getSessionId, setOriginalCwd } = await import('../../src/boot/process-state/processState.ts')
    const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
    const { createTask, getTaskListId, getTasksDir, listSessionMission } = await import('../../src/engine/task-framework/tasks.ts')

    const sid = getSessionId()
    const projCwd = join(scratch, 'mission-proj')
    mkdirSync(projCwd, { recursive: true })
    setOriginalCwd(projCwd)
    const missionsDir = join(getProjectDir(projCwd), 'missions')
    const cardPath = join(missionsDir, `${sid}.json`)

    const absentRes = await localMission('', {} as never)
    check(
      'w04-5 /mission (text) says No mission set when card is absent',
      absentRes.type === 'text' && absentRes.value.includes('No mission set'),
      JSON.stringify(absentRes),
    )

    mkdirSync(missionsDir, { recursive: true })
    writeFileSync(cardPath, '{not valid json\n', { mode: 0o600 })
    try {
      const corruptTextRes = await localMission('', {} as never)
      check(
        'w04-5 /mission (text) reports unreadable mission card instead of No mission set',
        corruptTextRes.type === 'text' &&
          corruptTextRes.value.includes(`${cardPath} could not be read (`) &&
          corruptTextRes.value.includes(') — the mission is not shown') &&
          !corruptTextRes.value.includes('No mission set'),
        JSON.stringify(corruptTextRes),
      )

      let jsxDone = ''
      setFocusedSessionConnector({
        sessionId: () => sid,
        workRoster: () => ({ rows: [], mission: [], missionCard: null, samples: [], reported: true }),
        workspace: () => ({ cwd: projCwd, originalCwd: projCwd, projectRoot: projCwd }),
      } as never)
      try {
        await jsxMission(value => { jsxDone = value ?? '' }, {} as never, '')
      } finally {
        releaseFocusedSessionConnector()
      }
      check(
        'w04-5 /mission (jsx) reports unreadable mission card instead of No mission set',
        jsxDone.includes(`${cardPath} could not be read (`) &&
          jsxDone.includes(') — the mission is not shown') &&
          !jsxDone.includes('No mission set'),
        jsxDone,
      )
    } finally {
      rmSync(cardPath, { force: true })
    }

    const listId = getTaskListId()
    await createTask(listId, {
      subject: 'preserve this mission row',
      description: '',
      status: 'in_progress',
      blocks: [],
      blockedBy: [],
    })
    const live = createRunnerState()
    const appState = {
      mcp: { clients: [], tools: [] },
      toolPermissionContext: { mode: 'default' },
      effortValue: 'medium',
      tasks: {},
      fileHistory: { snapshots: [], trackedFiles: new Set<string>() },
    }
    const factsPorts = {
      live,
      checkBuildBehind: async () => {},
      getAppState: () => appState,
      liveMcp: { addedAt: new Map() },
      mcpSignIns: new Map(),
      messages: [],
      missionGuard: { missionCardView: () => null },
    } as unknown as Parameters<typeof answerSessionFacts>[0]

    const firstWire = await answerSessionFacts(factsPorts)
    const firstFacts = sessionFactsFromWire(firstWire)
    const epochFile = join(getTasksDir(listId), '.epoch')
    writeFileSync(epochFile, '{corrupt epoch\n', { mode: 0o600 })
    try {
      let listThrew = false
      try {
        await listSessionMission()
      } catch {
        listThrew = true
      }
      const secondWire = await answerSessionFacts(factsPorts)
      const secondFacts = sessionFactsFromWire(secondWire)
      check(
        'w04-5 listSessionMission surfaces read failure and sessionFactsArm keeps last published mission list',
        listThrew &&
          (firstFacts?.mission.length ?? 0) === 1 &&
          secondFacts?.mission.length === 1 &&
          secondFacts.mission[0]?.subject === 'preserve this mission row',
        JSON.stringify({ listThrew, first: firstFacts?.mission, second: secondFacts?.mission }),
      )
    } finally {
      rmSync(epochFile, { force: true })
    }
  }

  {
    const { setActiveMission, clearActiveMission, missionCardView } = await import('../../src/permissions/guards/mission.ts')
    const { writeMissionCard } = await import('../../src/sessions/mission-card/missionCard.ts')
    const { setOriginalCwd } = await import('../../src/boot/process-state/processState.ts')
    const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
    const { dirname } = await import('node:path')

    const projCwd = join(scratch, 'mission-write-fail-proj')
    mkdirSync(projCwd, { recursive: true })
    setOriginalCwd(projCwd)
    const missionsBlocker = join(getProjectDir(projCwd), 'missions')
    mkdirSync(dirname(missionsBlocker), { recursive: true })
    writeFileSync(missionsBlocker, 'blocker file\n', { mode: 0o600 })
    const sid = 'mission-write-fail-session'
    const expectedPath = join(missionsBlocker, `${sid}.json`)
    try {
      const writeRes = writeMissionCard(
        {
          schema: 1,
          sessionId: sid,
          goal: 'finish',
          state: 'armed',
          nextStep: null,
          iterations: 0,
          setAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        projCwd,
      ) as unknown as { ok?: boolean; path?: string; error?: string } | undefined
      check(
        'w04-6 writeMissionCard returns { ok: false, path, error } instead of void when write fails',
        writeRes !== undefined && writeRes.ok === false && writeRes.path === expectedPath && Boolean(writeRes.error),
        JSON.stringify(writeRes),
      )

      const { readFileSync } = await import('node:fs')
      const dbg = await import('../../src/platform/logs/debugLog.ts')
      const prevNodeEnv = process.env.NODE_ENV
      delete process.env.NODE_ENV
      dbg.enableDebugLogging()
      const dbgPath = dbg.getDebugLogPath()
      try {
        const directive = setActiveMission('ship cleanly', { sessionId: sid })
        await dbg.flushDebugLogs()
        const dbgText = (() => { try { return readFileSync(dbgPath, 'utf8') } catch { return '' } })()
        check(
          'w04-6 setActiveMission appends plain save-failure sentence and logs path+error to debug log',
          directive.includes('the mission could not be saved, so it will not survive this session') &&
            !directive.includes(expectedPath) &&
            dbgText.includes(expectedPath),
          `${directive} | dbg=${dbgText.slice(-200)}`,
        )

        const cleared = clearActiveMission(sid)
        const viewAfterClear = missionCardView(sid)
        check(
          'w04-6 clearActiveMission appends plain save-failure sentence and updates in-session cardMemo to cleared',
          Boolean(cleared?.includes('the mission could not be saved, so it will not survive this session')) &&
            !Boolean(cleared?.includes(expectedPath)) &&
            viewAfterClear?.state === 'cleared',
          JSON.stringify({ cleared, viewAfterClear }),
        )
      } finally {
        if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv
      }
    } finally {
      rmSync(missionsBlocker, { force: true })
    }
  }

  {
    const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
    const { createOrAppendSample, listSamples, listSamplesStrict, samplesRoot, setSampleListenerAddress } = await import('../../src/integrations/samples/store.ts')
    const { sampleRowsOf } = await import('../../src/integrations/samples/facts.ts')
    const prevSamples = process.env.MERCURY_SAMPLES
    process.env.MERCURY_SAMPLES = '1'
    try {
      const absent = listSamplesStrict('w04-absent-samples')
      check('w04-7 listSamplesStrict returns [] for ENOENT', absent.length === 0, JSON.stringify(absent))

      const sid = 'w04-samples-session'
      createOrAppendSample({ sessionId: sid, name: 'card', title: 'Keep Me', html: '<p>hi</p>' })
      const firstRows = await sampleRowsOf(sid)
      if (POSIX_MODES) {
        const root = samplesRoot(sid)
        chmodSync(root, 0o300)
        setSampleListenerAddress(null)
        try {
          let strictThrew = false
          try {
            listSamplesStrict(sid)
          } catch {
            strictThrew = true
          }
          const nonStrict = listSamples(sid)
          const created = createOrAppendSample({ sessionId: sid, name: 'second', title: 'Still Created', html: '<p>2</p>' })
          const secondRows = await sampleRowsOf(sid)
          check(
            'w04-7 listSamplesStrict throws on non-ENOENT, sampleRowsOf keeps last published rows, and createOrAppendSample still succeeds',
            strictThrew &&
              nonStrict.length === 0 &&
              created.record.title === 'Still Created' &&
              firstRows.length === 1 &&
              secondRows.length === 1 &&
              secondRows[0]?.title === 'Keep Me',
            JSON.stringify({ strictThrew, nonStrictLen: nonStrict.length, createdTitle: created.record.title, firstRows, secondRows }),
          )
        } finally {
          chmodSync(root, 0o700)
        }
      }
    } finally {
      if (prevSamples === undefined) delete process.env.MERCURY_SAMPLES
      else process.env.MERCURY_SAMPLES = prevSamples
    }
  }

  {
    const { armLocalWake: armInputLocalWake } = await import('../../src/daemon/runner/inputDoor.ts')
    const { createRunnerState } = await import('../../src/daemon/runner/runnerPorts.ts')
    const { armLocalWake: armBridgeWake, _resetScheduleBridgeForTesting } = await import('../../src/daemon/saturn/sessionScheduleBridge.ts')
    const { getCommandQueue, remove } = await import('../../src/daemon/runner/messageQueueManager.ts')

    _resetScheduleBridgeForTesting()
    remove([...getCommandQueue()])
    try {
      const enqueuedRows: Array<{ type?: string; level?: string; text?: string }> = []
      const live = createRunnerState()
      const ports = {
        live,
        streamingInput: true,
        driver: {
          kick: () => { throw new Error('driver kick failed') },
          isRunning: () => false,
        },
        enqueueRow: (row: { type?: string; level?: string; text?: string }) => { enqueuedRows.push(row) },
        liveScope: () => ({ session_id: 'w04-wake-session' }),
      } as unknown as Parameters<typeof armInputLocalWake>[0]

      armInputLocalWake(ports)
      const armed = armBridgeWake(1, 'wake prompt', { spelling: 'in 1s' })
      await new Promise(resolve => setTimeout(resolve, 1200))
      const notice = enqueuedRows.find(r => r.level === 'warning')
      check(
        'w04-8 throwing local wake sink surfaces warning notice to session instead of dropping wake silently',
        armed.ok &&
          notice !== undefined &&
          notice.text === 'a scheduled wake could not be delivered (driver kick failed) — send it again',
        JSON.stringify({ armed, enqueuedRows }),
      )
    } finally {
      _resetScheduleBridgeForTesting()
      remove([...getCommandQueue()])
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
