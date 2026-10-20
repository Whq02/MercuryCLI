import { appendFileSync } from 'node:fs'
import { keptWeightsPath, prepareKeptWeights } from './keptWeights.js'
import { rentalVolume, readKeptVolume, writeKeptVolume } from './volumes.js'
import { randomUUID } from 'node:crypto'
import { configuredCompatEndpoints } from '../providers/openaicompat/compatAccounts.js'
import { setTimeout as delay } from 'node:timers/promises'
import { readStoredRunpodApiKey } from '../providers/providerSecrets.js'
import { runLlmHost } from '../llmHost/index.js'
import { LLM_HOST_WORDS } from '../../commands/llmhost/words.js'
import { RunpodClient, RunpodHttpError, createRefusal, cents, type HostOffer, type HostPod } from './runpod.js'
import { hostRecipeOfRecord } from './recipesFile.js'
import { hostNotice } from './notices.js'
import { hostDirectory, patchHostRecord, readHostRecord, removeHostRecord } from './store.js'
import { activeHostWatches, queueHostSetup, watchModel, watchRateWords } from './jobs.js'
import { reconcileRecord } from '../projectServices/serviceManager.js'
import { ensureHostKey, hostRunner, sshArguments, startHostEngine, waitHostEngine, openHostTunnel, closeHostTunnel, type HostRunner, type SshTarget } from './ssh.js'

export async function runHostJob(id: string, generation: string, options: { runner?: HostRunner; pauseMs?: number; timeoutMs?: number; signal?: AbortSignal; keepAlive?: boolean } = {}): Promise<void> {
  const initial = readHostRecord(id)
  if (!initial || initial.generation !== generation || !['queued', 'starting'].includes(initial.jobState ?? '')) return
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
  const runner = options.runner ?? hostRunner
  const pause = options.pauseMs ?? 5000
  const timeout = options.timeoutMs ?? 90 * 60_000
  const key = readStoredRunpodApiKey()
  const clean = (text: string): string => key ? text.split(key).join('[redacted]') : text
  const mark = (step: string): void => {
    const record = readHostRecord(id)
    if (!record || record.generation !== generation || record.jobState === 'stopped') controller.abort()
    signal.throwIfAborted()
    if (!record) return
    if (record.step === step || record.jobState === 'ready') return
    const at = Date.now()
    patchHostRecord(id, { step, advancedAt: at, steps: [...(record.steps ?? []), { step, at }] })
  }
  const log = (text: string): void => {
    if (initial.log && text) appendFileSync(initial.log, clean(text) + '\n', { mode: 0o600 })
    for (const match of text.matchAll(/MERCURY_STEP (.+)/g)) mark(match[1]!.trim())
  }
  let logBusy = false
  let target: SshTarget | undefined
  let offset = 0
  const recipe = hostRecipeOfRecord(initial)
  patchHostRecord(id, { jobState: 'running', error: undefined })
  const timer = setInterval(() => {
    const current = readHostRecord(id)
    if (!current || current.generation !== generation || current.jobState === 'stopped') controller.abort()
    if (initial.jobKind === 'watch' || !target || !recipe || logBusy || signal.aborted || current?.jobState === 'ready') return
    logBusy = true
    void runner.run('ssh', [...sshArguments(target), current?.volumeId && !current.weightsCheck ? 'tail -n 1 /workspace/mercury-host/' + recipe.id + '/weights-check.log 2>/dev/null || true' : 'dd if=/workspace/mercury-host/' + recipe.id + '/engine.log bs=1 skip=' + offset + ' count=8192 status=none'], signal)
      .then(async text => {
        if (!current?.volumeId || current.weightsCheck) offset += Buffer.byteLength(text); log(text)
        if (readHostRecord(id)?.step?.startsWith('downloading weights')) {
          const size = await runner.run('ssh', [...sshArguments(target!), 'du -sb ' + (current?.volumeId ? keptWeightsPath(recipe) : '/workspace/mercury-host/' + recipe.id + '/weights') + ' 2>/dev/null || true'], signal)
          const bytes = Number(/^(\d+)/.exec(size)?.[1])
          if (Number.isFinite(bytes)) mark('downloading weights ' + (bytes / 1e9).toFixed(2) + ' GB')
        }
      })
      .catch(() => {})
      .finally(() => { logBusy = false })
  }, initial.jobKind === 'watch' ? Math.min(pause, 100) : pause)
  if (initial.jobKind === 'watch') {
    let created: HostPod | undefined
    try {
      if (!key) throw new Error('The saved Runpod key is unavailable.')
      if (!recipe) throw new Error('The saved host recipe is unavailable.')
      const api = new RunpodClient(key, initial.apiBaseUrl)
      const sshKey = await ensureHostKey(runner, signal)
      const pollMs = options.pauseMs ?? initial.pollIntervalMs ?? 5000
      const watchWindowMs = options.timeoutMs ?? initial.pollWindowMs ?? 12 * 3600_000
      const deadline = (initial.jobStartedAt ?? Date.now()) + watchWindowMs
      const maxPrice = initial.maxPrice ?? initial.price
      const model = watchModel(initial)
      const rest = async (ms: number): Promise<void> => {
        for (let left = ms; left > 0; left -= 60_000) {
          await delay(Math.min(left, 60_000), undefined, { signal })
          if (left > 60_000) patchHostRecord(id, { advancedAt: Date.now() })
        }
      }
      let wait = pollMs
      let refused = ''
      while (!signal.aborted && Date.now() < deadline) {
        const current = readHostRecord(id)
        if (!current || current.generation !== generation || current.jobState === 'stopped') return
        const rival = activeHostWatches().find(row => row.id !== id && watchModel(row) === model && ((row.jobStartedAt ?? 0) < (current.jobStartedAt ?? 0) || row.jobStartedAt === current.jobStartedAt && row.id < id))
        if (rival) {
          const words = 'stock watch ended: ' + rival.id + ' already watches ' + model + ' · no pod was created'
          const ended = patchHostRecord(id, { jobState: 'stopped', step: words })
          if (ended) hostNotice(ended, 'ended', ended.name + ' · ' + words)
          return
        }
        patchHostRecord(id, { advancedAt: Date.now() })
        let offer: HostOffer | undefined
        try {
          offer = await api.watchOffer(recipe, maxPrice, signal)
        } catch (error) {
          if (signal.aborted || error instanceof RunpodHttpError && (error.status === 401 || error.status === 403)) throw error
          wait = Math.max(Math.min(60_000, wait * 2), (error instanceof RunpodHttpError ? error.retryAfterSeconds ?? 0 : 0) * 1000)
          const step = 'Runpod read failed · next read in ' + Math.ceil(wait / 1000) + ' s · ' + clean(String(error)).slice(0, 200)
          log(step)
          patchHostRecord(id, { step })
          await rest(wait)
          continue
        }
        wait = pollMs
        const rateLimit = watchRateWords(pollMs, api.rateLimitPolicy() ?? '')
        const afterPoll = readHostRecord(id)
        if (!afterPoll || afterPoll.generation !== generation || afterPoll.jobState === 'stopped') return
        if (afterPoll.rateLimit !== rateLimit) patchHostRecord(id, { rateLimit })
        if (!offer) { await rest(pollMs); continue }
        const podName = 'mercury-' + randomUUID().slice(0, 12)
        const shapeWords = offer.recipe.count + '× ' + offer.recipe.gpu + ' · $' + offer.price.toFixed(2) + '/hr' + (offer.dataCenter ? ' in ' + offer.dataCenter : '')
        const marked = patchHostRecord(id, { creating: podName, step: 'creating ' + podName + ' · ' + shapeWords })
        if (!marked || marked.generation !== generation || marked.jobState === 'stopped') return
        const volume = await rentalVolume(api, offer.recipe, signal)
        if (volume?.kind === 'network' && offer.dataCenter && offer.dataCenter !== volume.dataCenter) {
          offer = (await api.offers(signal)).filter(row => row.recipe.model === volume.model && (row.recipe.include ?? '') === volume.include && row.dataCenter === volume.dataCenter && cents(row.price) <= cents(maxPrice)).sort((a, b) => a.price - b.price)[0]
          if (!offer) { patchHostRecord(id, { creating: undefined }); await rest(pollMs); continue }
        }
        let pod: HostPod
        try {
          pod = await api.create(offer, sshKey.publicKey, podName, volume)
        } catch (error) {
          const refusal = createRefusal(error)
          if (!refusal) {
            const words = podName + ' may exist: Runpod gave no clear answer to the create · /llmhost → Pods I’m paying for · the watch stopped so it cannot rent twice · ' + clean(String(error))
            log(words)
            const failed = patchHostRecord(id, { jobState: 'failed', error: words, step: words })
            if (failed) hostNotice(failed, 'failed', failed.name + ' · ' + words)
            return
          }
          patchHostRecord(id, { creating: undefined })
          if (refusal.status !== 400 && refusal.status !== 429) throw error
          refused = 'Runpod could not place ' + shapeWords + (refusal.detail ? ' · ' + refusal.detail : '')
          const step = 'Runpod could not place ' + shapeWords + ' · no pod was created · still watching' + (refusal.detail ? ' · ' + refusal.detail : '')
          log(step)
          patchHostRecord(id, { step })
          await rest(Math.max(pollMs, (refusal.retryAfterSeconds ?? 0) * 1000))
          continue
        }
        created = pod
        const rentedWords = 'Rented ' + model + ' · ' + shapeWords + ' · setting up'
        log(rentedWords)
        const setupRecord = queueHostSetup({
          id: pod.id,
          name: pod.name,
          recipe: offer.recipe.id,
          price: offer.price,
          startedAt: pod.startedAt ?? pod.createdAt,
          status: pod.status,
          sessionId: afterPoll.sessionId,
          workspace: afterPoll.workspace,
          sshKey: sshKey.path,
          watchedFrom: id,
          volumeId: volume?.id,
          ...(afterPoll.apiBaseUrl ? { apiBaseUrl: afterPoll.apiBaseUrl } : {}),
        })
        hostNotice(setupRecord, 'rented', rentedWords)
        removeHostRecord(id)
        if (!reconcileRecord(hostDirectory(), 'host-' + id.toLowerCase())) {
          await runHostJob(setupRecord.id, setupRecord.generation!, options)
        }
        return
      }
      const ended = readHostRecord(id)
      if (ended && ended.generation === generation && ended.jobState !== 'stopped') {
        const words = 'watch ended after ' + (watchWindowMs >= 3600_000 ? +(watchWindowMs / 3600_000).toFixed(1) + ' hours' : Math.round(watchWindowMs / 1000) + ' s') + (refused ? '' : ' without stock ≤ $' + maxPrice.toFixed(2) + '/hr') + ' · no pod was created' + (refused ? ' · last refusal: ' + refused : '')
        const stoppedRecord = patchHostRecord(id, { jobState: 'stopped', status: 'EXPIRED', step: words })!
        hostNotice(stoppedRecord, 'expired', stoppedRecord.name + ' · ' + words)
      }
    } catch (error) {
      const current = readHostRecord(id)
      if (current && current.generation === generation && current.jobState !== 'stopped') {
        const detail = clean(String(error))
        const words = created ? created.id + ' was created but could not be recorded · ' + detail + ' · /llmhost → Pods I’m paying for' : 'stock watch stopped · ' + detail + (detail.includes('no pod was created') ? '' : ' · no pod was created')
        const failedRecord = patchHostRecord(id, { jobState: 'failed', error: words })!
        log(words)
        hostNotice(failedRecord, 'failed', failedRecord.name + ' · ' + words)
      }
    } finally { clearInterval(timer) }
    return
  }
  try {
    if (!key) throw new Error('The saved Runpod key is unavailable.')
    if (!recipe) throw new Error('The saved host recipe is unavailable.')
    const api = new RunpodClient(key, initial.apiBaseUrl)
    const deadline = Date.now() + timeout
    let last = 'SSH address not yet assigned'
    while (!signal.aborted && Date.now() < deadline) {
      const pod = await api.get(id, signal)
      const direct = pod.ssh?.direct
      if (pod.status === 'EXITED' || pod.status === 'ERROR') throw new Error('Pod is ' + pod.status + '. ' + await api.logs(id))
      if (direct && pod.status === 'RUNNING') {
        const candidate = { host: direct.host, port: direct.port, user: direct.username, key: initial.sshKey ?? initial.target?.key }
        try { await runner.run('ssh', [...sshArguments(candidate), 'true'], signal); target = candidate; break } catch (error) { last = String(error) }
      }
      await delay(pause, undefined, { signal })
    }
    if (!target) throw new Error(last)
    patchHostRecord(id, { target, status: 'RUNNING' })
    let keptWeights: string | undefined
    if (initial.volumeId) {
      keptWeights = await prepareKeptWeights(initial, recipe, api, target, runner, signal, mark)
      if (initial.prepareWeightsOnly) return
    }
    mark('installing')
    await startHostEngine(target, recipe, runner, signal, false, true, undefined, keptWeights)
    await waitHostEngine(target, recipe, runner, signal, pause, timeout)
    mark('starting engine')
    const port = await openHostTunnel(id, target, runner, signal)
    patchHostRecord(id, { localPort: port })
    mark('tunnel on 127.0.0.1:' + port)
    let provider = initial.provider ?? ('pod-' + id.toLowerCase().replaceAll('_', '-')).slice(0, 32)
    const result = await runLlmHost(async question => {
      switch (question.step) {
        case 'servers': return initial.provider ?? '__add__'
        case 'action': return 'repoint'
        case 'address': return 'http://127.0.0.1:' + port + '/v1'
        case 'dialect': return recipe.engine ?? 'sglang'
        case 'key': if (question.found === LLM_HOST_WORDS.keyOptional) return ''; break
        case 'model': return question.rows?.find(row => row.value === recipe.model || row.value.startsWith(recipe.model + ':'))?.value ?? (question.rows?.length === 1 ? question.rows[0]!.value : null)
        case 'name':
          if (configuredCompatEndpoints().some(endpoint => endpoint.name === provider)) provider = 'pod-' + randomUUID().replaceAll('-', '').slice(0, 28)
          return provider
        case 'confirm': return 'run'
      }
      throw new Error('Setup needs input at ' + question.title + '. Resume from /llmhost.')
    }, () => {}, signal)
    if (!result.ok || !result.registered || !result.model) throw new Error(result.words)
    patchHostRecord(id, { provider })
    mark('ready')
    const record = patchHostRecord(id, { jobState: 'ready' })!
    hostNotice(record, 'ready', recipe.label + ' is ready on ' + result.model + ' · $' + (record.price * Math.max(0, Date.now() - Date.parse(record.startedAt)) / 3600_000).toFixed(2) + ' so far (estimate; storage extra)')
    if (options.keepAlive !== false) while (!signal.aborted) {
      await delay(pause, undefined, { signal })
      const response = await fetch('http://127.0.0.1:' + port + '/v1/models', { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'error' })
      if (!response.ok) throw new Error('The SSH tunnel no longer answers: HTTP ' + response.status)
      await response.body?.cancel()
    }
  } catch (error) {
    let failure = error
    if (initial.prepareWeightsOnly && readHostRecord(id)) {
      const volume = initial.volumeId && readKeptVolume(initial.volumeId)
      if (volume && volume.state !== 'kept' && volume.state !== 'failed') writeKeptVolume({ ...volume, state: 'failed', error: clean(String(error)), preparingPod: id })
      try {
        if (!key) throw new Error('The saved Runpod key is unavailable for cleanup.')
        const cleanupApi = new RunpodClient(key, initial.apiBaseUrl)
        await cleanupApi.terminate(id)
        if ((await cleanupApi.pods()).some(row => row.id === id)) throw new Error('Runpod still lists the pod.')
        hostNotice(initial, 'failed', 'Preparation failed; temporary pod ' + id + ' terminated. The weights disk still bills. ' + clean(String(error)))
        removeHostRecord(id)
      } catch (cleanup) { failure = new Error(id + ' may still bill: preparation failed and termination was not verified. Pods I’m paying for → Terminate. ' + clean(String(error)) + ' · ' + clean(String(cleanup))) }
    }
    const current = readHostRecord(id)
    if (current && current.generation === generation && current.jobState !== 'stopped') {
      const detail = clean(String(failure))
      const record = patchHostRecord(id, { jobState: 'failed', error: detail })!
      log(detail)
      hostNotice(record, 'failed', record.name + ' · setup stalled at ' + record.step + ' · ' + detail + ' · /llmhost → Pods I’m paying for → Resume or Terminate')
    }
    closeHostTunnel(id)
  } finally { clearInterval(timer) }
}
