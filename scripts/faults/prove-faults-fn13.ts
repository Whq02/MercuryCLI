#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn13-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

try {
  const { vendorClient } = await import('../../src/models/hosting/vendors/client.ts')

  {
    const credDir = join(home, '.host-credentials')
    mkdirSync(credDir, { recursive: true, mode: 0o700 })
    const credId = randomUUID()
    const credFile = join(credDir, credId + '.json')
    writeFileSync(credFile, '{not valid json', { mode: 0o600 })
    const record = {
      id: 'hf-job-1',
      vendor: 'huggingface' as const,
      huggingfaceCredential: { home, source: 'captured' as const, id: credId, job: 'hf-job-1' },
    }
    let corruptMsg = ''
    try {
      vendorClient(record)
    } catch (error) {
      corruptMsg = error instanceof Error ? error.message : String(error)
    }
    check(
      'vendorClient surfaces corrupt captured Hugging Face credential read error instead of generic key-unavailable',
      corruptMsg.includes('The saved host credential could not be read.'),
      `got: ${corruptMsg}`,
    )

    if (POSIX_MODES) {
      const unreadableId = randomUUID()
      const unreadableFile = join(credDir, unreadableId + '.json')
      writeFileSync(unreadableFile, JSON.stringify({ key: 'hf_secret' }) + '\n', { mode: 0o600 })
      chmodSync(unreadableFile, 0o200)
      let eaccesMsg = ''
      try {
        vendorClient({
          id: 'hf-job-2',
          vendor: 'huggingface',
          huggingfaceCredential: { home, source: 'captured', id: unreadableId, job: 'hf-job-2' },
        })
      } catch (error) {
        eaccesMsg = error instanceof Error ? error.message : String(error)
      } finally {
        chmodSync(unreadableFile, 0o600)
      }
      check(
        'vendorClient surfaces EACCES on captured Hugging Face credential instead of generic key-unavailable',
        eaccesMsg.includes('The saved host credential could not be read.'),
        `got: ${eaccesMsg}`,
      )
    }

    let missingMsg = ''
    try {
      vendorClient({
        id: 'hf-job-3',
        vendor: 'huggingface',
        huggingfaceCredential: { home, source: 'captured', id: randomUUID(), job: 'hf-job-3' },
      })
    } catch (error) {
      missingMsg = error instanceof Error ? error.message : String(error)
    }
    check(
      'vendorClient preserves job-specific missing Hugging Face credential message',
      missingMsg.includes('The saved Hugging Face credential for this job is unavailable.'),
      `got: ${missingMsg}`,
    )

    let explicitOk = false
    try {
      const client = vendorClient(record, { key: 'hf_explicit_override' })
      explicitOk = client.vendor === 'huggingface'
    } catch {
      explicitOk = false
    }
    check(
      'vendorClient with explicit options.key still succeeds when record credential cannot be read',
      explicitOk,
    )
  }

  {
    const { reconcileHostTune } = await import('../../src/models/hosting/tune.ts')
    const { readHostRecord, removeHostRecord, writeHostRecord } = await import('../../src/models/hosting/store.ts')
    const { HOST_RECIPES } = await import('../../src/models/hosting/recipes.ts')
    const recipe = HOST_RECIPES.find(row => row.engine === 'llamacpp')!
    const fromTune = { quality: recipe.id, conversations: 4, contextPerConversation: 131072, effort: 'high' as const, updatedAt: new Date().toISOString() }
    const toTune = { quality: recipe.id, conversations: 8, contextPerConversation: 65536, effort: 'max' as const, updatedAt: new Date().toISOString() }
    const podId = 'reconcile-ssh-err-1'
    writeHostRecord({
      id: podId,
      vendor: 'runpod',
      name: 'reconcile-ssh-err',
      recipe: recipe.id,
      recipeRow: recipe,
      price: 5.0,
      startedAt: new Date().toISOString(),
      status: 'RUNNING',
      target: { host: '127.0.0.1', port: 2222, user: 'root' },
      step: 'reloading engine in place',
      tune: toTune,
      retuning: { pid: 2_147_000_000, at: Date.now() - 3 * 3600_000, from: fromTune, to: toTune },
    })
    const failingRunner = {
      async run(): Promise<string> {
        throw new Error('ssh: connect to host 127.0.0.1 port 2222: Connection timed out')
      },
      tunnel() {
        return { stop() {}, failed: () => undefined }
      },
    }
    const result = await reconcileHostTune(podId, failingRunner, new AbortController().signal)
    const after = readHostRecord(podId)
    check(
      'reconcileHostTune keeps retuning claim and tune intact when SSH read fails',
      result?.retuning !== undefined &&
        after?.retuning !== undefined &&
        after?.tune?.conversations === toTune.conversations &&
        after?.step !== 'engine reload interrupted',
      JSON.stringify({ retuning: Boolean(after?.retuning), conversations: after?.tune?.conversations, step: after?.step }),
    )

    const deadRunner = {
      async run(): Promise<string> {
        return JSON.stringify({ mark: 'MERCURY_ENGINE_READ ', alive: false }) + '\n'
      },
      tunnel() {
        return { stop() {}, failed: () => undefined }
      },
    }
    const deadResult = await reconcileHostTune(podId, deadRunner, new AbortController().signal)
    const afterDead = readHostRecord(podId)
    check(
      'reconcileHostTune still marks interrupted and reverts tune when pod reports engine dead',
      deadResult?.retuning === undefined &&
        afterDead?.retuning === undefined &&
        afterDead?.tune?.conversations === fromTune.conversations &&
        afterDead?.step === 'engine reload interrupted',
      JSON.stringify({ retuning: Boolean(afterDead?.retuning), conversations: afterDead?.tune?.conversations, step: afterDead?.step }),
    )
    removeHostRecord(podId)
  }

  {
    const { locateBlender, blenderLaneReadinessRecords } = await import('../../src/integrations/blender-protocol/blenderProject.ts')
    const prevBin = process.env.MERCURY_BLENDER_BIN
    const prevEnabled = process.env.MERCURY_BLENDER
    try {
      process.env.MERCURY_BLENDER = '1'
      const missingPin = join(scratch, 'no-such-blender')
      process.env.MERCURY_BLENDER_BIN = missingPin
      const missingCensus = locateBlender({ skipPathProbe: true, platform: 'darwin', appBundles: [] })
      check(
        'locateBlender still reports does not exist for an absent MERCURY_BLENDER_BIN',
        missingCensus.blender === undefined &&
          missingCensus.pinError === `MERCURY_BLENDER_BIN is set to ${missingPin}, which does not exist`,
        missingCensus.pinError ?? '(none)',
      )

      if (POSIX_MODES) {
        const lockedDir = join(scratch, 'locked-blender-dir')
        mkdirSync(lockedDir, { recursive: true, mode: 0o700 })
        const lockedPin = join(lockedDir, 'blender')
        writeFileSync(lockedPin, '#!/bin/sh\n', { mode: 0o700 })
        chmodSync(lockedDir, 0o000)
        try {
          process.env.MERCURY_BLENDER_BIN = lockedPin
          const census = locateBlender({ skipPathProbe: true, platform: 'darwin', appBundles: [] })
          const rows = blenderLaneReadinessRecords()
          check(
            'locateBlender reports access error instead of does not exist when MERCURY_BLENDER_BIN cannot be accessed',
            census.blender === undefined &&
              Boolean(census.pinError?.includes(`MERCURY_BLENDER_BIN is set to ${lockedPin}, which could not be accessed (`)) &&
              Boolean(census.pinError?.includes('EACCES')) &&
              Boolean(census.pinError?.includes('check its permissions or unset MERCURY_BLENDER_BIN')) &&
              !census.pinError?.includes('does not exist') &&
              rows[0]?.detail === census.pinError,
            JSON.stringify({ pinError: census.pinError, healthDetail: rows[0]?.detail }),
          )
        } finally {
          chmodSync(lockedDir, 0o700)
        }
      }
    } finally {
      if (prevBin === undefined) delete process.env.MERCURY_BLENDER_BIN
      else process.env.MERCURY_BLENDER_BIN = prevBin
      if (prevEnabled === undefined) delete process.env.MERCURY_BLENDER
      else process.env.MERCURY_BLENDER = prevEnabled
    }
  }

  {
    const workerMod = await import('../../src/models/hosting/worker.ts') as {
      restoreRentingSessionOutcome?: (record: { sessionId?: string; sessionModel?: string; sessionModelBefore?: string }) => Promise<{ state: string; detail?: string }>
    }
    const daemonDir = join(home, 'daemon')
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 })
    const workersFile = join(daemonDir, 'concourse-workers.json')
    const hostedModel = 'compat/pod-tf-1/qwen'
    const priorModel = 'compat/local/base'
    const sessionId = '11111111-1111-4111-8111-111111111111'

    writeFileSync(workersFile, '{corrupt json', { mode: 0o600 })
    const unreadOutcome = workerMod.restoreRentingSessionOutcome
      ? await workerMod.restoreRentingSessionOutcome({ sessionId, sessionModel: hostedModel, sessionModelBefore: priorModel })
      : { state: 'missing' }
    check(
      'restoreRentingSessionOutcome reports failed when session list cannot be read',
      unreadOutcome.state === 'failed' && Boolean(unreadOutcome.detail),
      JSON.stringify(unreadOutcome),
    )

    writeFileSync(
      workersFile,
      JSON.stringify({
        version: 1,
        workers: {
          'runner-1': {
            schema: 1,
            runnerId: 'runner-1',
            sessionId,
            workspaceId: scratch,
            isolation: 'shared',
            modelKey: hostedModel,
            spawnedAt: Date.now() - 1000,
            lastLiveAt: Date.now(),
            pid: process.pid,
          },
        },
      }) + '\n',
      { mode: 0o600 },
    )
    const rpcOutcome = workerMod.restoreRentingSessionOutcome
      ? await workerMod.restoreRentingSessionOutcome({ sessionId, sessionModel: hostedModel, sessionModelBefore: priorModel })
      : { state: 'missing' }
    check(
      'restoreRentingSessionOutcome reports failed with error detail when model switch RPC fails',
      rpcOutcome.state === 'failed' && Boolean(rpcOutcome.detail),
      JSON.stringify(rpcOutcome),
    )

    const movedOutcome = workerMod.restoreRentingSessionOutcome
      ? await workerMod.restoreRentingSessionOutcome({ sessionId, sessionModel: 'compat/other/model', sessionModelBefore: priorModel })
      : { state: 'missing' }
    check(
      'restoreRentingSessionOutcome reports skipped when session moved to another model',
      movedOutcome.state === 'skipped',
      JSON.stringify(movedOutcome),
    )

    const { terminateTensorFoldPod } = await import('../../src/models/hosting/tensorfoldPod.ts')
    const { writeHostRecord } = await import('../../src/models/hosting/store.ts')
    const { HostVendorHttpError } = await import('../../src/models/hosting/vendors/http.ts')
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

    const podFailId = 'tf-restore-fail-1'
    writeHostRecord({
      id: podFailId,
      vendor: 'runpod',
      name: 'tf-restore-fail',
      recipe: 'tensorfold-qwen',
      price: 2.0,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'RUNNING',
      sessionId,
      sessionModel: hostedModel,
      sessionModelBefore: priorModel,
    })
    const terminatedWithFailure = await terminateTensorFoldPod(podFailId, { client: goneClient })
    check(
      'terminateTensorFoldPod reports failed session restore in its terminated words',
      terminatedWithFailure.ok &&
        terminatedWithFailure.words.includes('this session stays on a model that is gone (') &&
        terminatedWithFailure.words.includes(') — run /model ' + priorModel),
      terminatedWithFailure.words,
    )

    const podSkipId = 'tf-restore-skip-1'
    writeHostRecord({
      id: podSkipId,
      vendor: 'runpod',
      name: 'tf-restore-skip',
      recipe: 'tensorfold-qwen',
      price: 2.0,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'RUNNING',
    })
    const terminatedClean = await terminateTensorFoldPod(podSkipId, { client: goneClient })
    check(
      'terminateTensorFoldPod adds no restore warning when no session restore was needed',
      terminatedClean.ok && !terminatedClean.words.includes('stays on a model'),
      terminatedClean.words,
    )
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
