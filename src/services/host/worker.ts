import { appendFileSync, mkdirSync } from 'node:fs'
import { HostPreparationCleanupFailed, keptWeightsPath, prepareKeptWeights, terminateVerified } from './keptWeights.js'
import { keptDiskPrice, matchesVolume, rentalVolume, readKeptVolume, writeKeptVolume, type KeptVolume } from './volumes.js'
import { randomUUID } from 'node:crypto'
import { configuredCompatEndpoints } from '../providers/openaicompat/compatAccounts.js'
import { hostHuggingfaceDispatchCredential } from './jobCredentials.js'
import { setTimeout as delay } from 'node:timers/promises'
import { vendorClient, vendorKey, vendorKeyNotice, vendorLabel, runpodOnly, type HostVendorId } from './vendors/client.js'
import { HostVendorHttpError } from './vendors/http.js'
import type { HostVendor } from './vendors/vendor.js'
import { linkLlmHostPod, runLlmHost } from '../llmHost/index.js'
import { hostReadyWords, LLM_HOST_WORDS } from '../../commands/llmhost/words.js'
import { RunpodHttpError, cents, type HostOffer, type HostPod } from './runpod.js'
import { HostClusterEnded, createHostResource, hostClusterRecord, hostCreateRefusal, hostResourceKind, hostShape, startHostCluster, terminateHostResource } from './cluster.js'
import { hostSetupTimeout } from './costs.js'
import { hostRecipeOfRecord } from './recipesFile.js'
import { hostNotice } from './notices.js'
import { hostDirectory, patchHostRecord, readHostRecord, removeHostRecord } from './store.js'
import { activeHostWatches, queueHostSetup, watchModel, watchRateWords } from './jobs.js'
import { bankDownloadScript, bankModelPath, bytesWords, folderBytes, recordBankFailure, sealBank, shortFolder, verifyBank } from './bank.js'
import { bankUploadBudget, uploadBankForRental } from './keepSafe.js'
import { runBoxScript } from './boxExecution.js'
import { reconcileRecord } from '../projectServices/serviceManager.js'
import { ensureHostKey, hostRunner, inspectSsh, sshArguments, startHostEngine, waitHostEngine, openHostTunnel, closeHostTunnel, type HostRunner, type SshTarget } from './ssh.js'
import { hostRetuneLive, reconcileHostTune, tunedRecipe } from './tune.js'
import { HostTerminationUnconfirmed, hostJobReadOnly, hostReadFailureWords } from './retry.js'

const notFound = (error: unknown): boolean => (error instanceof RunpodHttpError || error instanceof HostVendorHttpError) && error.status === 404
class HostPodMissing extends Error {}
const unauthorized = (error: unknown): boolean => (error instanceof RunpodHttpError || error instanceof HostVendorHttpError) && (error.status === 401 || error.status === 403)
const localOs = (): 'darwin' | 'linux' | 'windows' => process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'

export async function runHostJob(id: string, generation: string, options: { runner?: HostRunner; pauseMs?: number; timeoutMs?: number; signal?: AbortSignal; keepAlive?: boolean } = {}): Promise<void> {
  const initial = readHostRecord(id)
  if (!initial || initial.generation !== generation || !['queued', 'starting'].includes(initial.jobState ?? '')) return
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
  const runner = options.runner ?? hostRunner
  const pause = options.pauseMs ?? 5000
  const timeout = options.timeoutMs ?? (hostSetupTimeout(hostRecipeOfRecord(initial)) + (initial.vendor === 'vast' || initial.vendor === 'lambda' ? bankUploadBudget(hostRecipeOfRecord(initial)) : 0))
  const vendor = initial.vendor ?? 'runpod'
  let keyRefusal: string | undefined
  const huggingfaceKey = async (): Promise<string | undefined> => { try { return (await hostHuggingfaceDispatchCredential(initial))?.key } catch (error) { keyRefusal = error instanceof Error ? error.message : String(error); return undefined } }
  let key = vendor === 'huggingface' ? await huggingfaceKey() : vendorKey(vendor)
  const clean = (text: string): string => key ? text.split(key).join('[redacted]') : text
  const mark = (step: string): void => {
    const record = readHostRecord(id)
    if (!record || record.generation !== generation || record.jobState === 'stopped') controller.abort()
    signal.throwIfAborted()
    if (!record) return
    if (record.step === step || record.jobState === 'ready' || record.jobState === 'failed') return
    const at = Date.now()
    patchHostRecord(id, { step, advancedAt: at, steps: [...(record.steps ?? []), { step, at }] })
  }
  const log = (text: string): void => {
    if (initial.log && text) appendFileSync(initial.log, clean(text) + '\n', { mode: 0o600 })
    for (const match of text.matchAll(/MERCURY_STEP (.+)/g)) mark(match[1]!.trim().replace(/^downloading weights(?= ·|$)/, 'downloading weights on the machine'))
  }
  let offset = 0
  let logBusy = false
  let target: SshTarget | undefined
  let clusterStarted = false
  const originalRecipe = hostRecipeOfRecord(initial)
  const recipe = originalRecipe && initial.tune ? tunedRecipe(originalRecipe, initial.tune) : originalRecipe
  patchHostRecord(id, { jobState: 'running', error: undefined })
  const timer = setInterval(() => {
    const current = readHostRecord(id)
    if (!current || current.generation !== generation || current.jobState === 'stopped') controller.abort()
    if (initial.jobKind === 'watch' || !target || !recipe || logBusy || signal.aborted || current?.jobState === 'ready' || current?.jobState === 'failed') return
    const checking = current?.volumeId && !current.weightsCheck
    if (!checking && !initial.cluster) return
    logBusy = true
    void runner.run('ssh', [...sshArguments(target), checking ? 'tail -n 1 /workspace/mercury-host/' + recipe.id + '/weights-check.log 2>/dev/null || true' : 'dd if=/workspace/mercury-host/' + recipe.id + '/engine.log bs=1 skip=' + offset + ' count=8192 status=none'], signal)
      .then(text => { if (!checking) offset += Buffer.byteLength(text); log(text) })
      .catch(() => {})
      .finally(() => { logBusy = false })
  }, initial.jobKind !== 'setup' ? Math.min(pause, 100) : pause)
  if (initial.jobKind === 'bank') {
    const verifying = initial.bankTask === 'verify'
    let token: { key: string } | undefined
    const scrub = (text: string): string => token ? clean(text).split(token.key).join('[redacted]') : clean(text)
    try {
      if (!verifying) token = await hostHuggingfaceDispatchCredential(initial)
      if (!recipe) throw new Error('The saved host recipe is unavailable.')
      if (!initial.bankFolder) throw new Error('The bank folder is not recorded; open /llmhost → Bank and try again.')
      const folder = initial.bankFolder
      const path = bankModelPath(folder, recipe)
      if (verifying) {
        const receipt = await verifyBank(recipe, folder, signal, mark)
        mark('verified')
        hostNotice(initial, 'verified', initial.name + ' · verified against the ' + (receipt.check === 'manifest' ? 'pinned manifest' : 'download') + ' · ' + receipt.files + ' files · ' + bytesWords(receipt.bytes) + ' on ' + shortFolder(folder) + ' · /llmhost → Bank')
        removeHostRecord(id)
        return
      }
      mkdirSync(path, { recursive: true })
      mark('downloading from Hugging Face' + (token ? ' with your Hugging Face token' : ''))
      const expected = recipe.weightsGb * 1e9
      const progress = setInterval(() => { try { mark('downloading ' + bytesWords(folderBytes(path)) + ' of ' + bytesWords(expected)) } catch {} }, Math.max(1000, pause))
      try { await runBoxScript({ os: localOs(), target: undefined }, bankDownloadScript(recipe, path), runner, signal, 12 * 3600_000, token ? { HF_TOKEN: token.key } : undefined) } finally { clearInterval(progress) }
      const receipt = await sealBank(recipe, folder, signal, mark)
      mark('banked')
      hostNotice(initial, 'banked', initial.name + ' · banked on ' + shortFolder(folder) + ' · ' + bytesWords(receipt.bytes) + ' in ' + receipt.files + ' files · verified against the ' + (receipt.check === 'manifest' ? 'pinned manifest' : 'download') + ' · /llmhost → Bank')
      removeHostRecord(id)
    } catch (error) {
      const current = readHostRecord(id)
      if (current && current.generation === generation && current.jobState !== 'stopped') {
        const detail = scrub(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 400)
        const words = initial.name + ' · ' + (verifying ? 'verification failed: ' + detail + ' · b banks the weights again' : 'banking failed: ' + detail + ' · what was downloaded stays in the folder; b resumes') + ' · /llmhost → Bank'
        if (recipe && initial.bankFolder) recordBankFailure(recipe, bankModelPath(initial.bankFolder, recipe), detail)
        log(words)
        hostNotice(current, 'failed', words)
        removeHostRecord(id)
      }
    } finally { clearInterval(timer) }
    return
  }
  if (initial.jobKind === 'watch') {
    let created: HostPod | undefined
    try {
      if (!recipe) throw new Error('The saved host recipe is unavailable.')
      const vendors: HostVendorId[] = initial.watchVendors?.length ? initial.watchVendors : [vendor]
      const clients = new Map<HostVendorId, HostVendor>()
      for (const name of vendors) { const vendorApiKey = name === 'huggingface' ? await huggingfaceKey() : vendorKey(name); if (vendorApiKey) clients.set(name, vendorClient(name === vendor ? initial : name, { key: vendorApiKey })) }
      if (!clients.size) throw new Error('The saved ' + vendors.map(vendorLabel).join(', ') + ' key is unavailable.')
      const runpod = clients.get('runpod') && runpodOnly(clients.get('runpod')!, 'Fast-load weights disks')
      let sshKey: Awaited<ReturnType<typeof ensureHostKey>> | undefined
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
        let hit: HostVendorId = 'runpod'
        let volume: KeptVolume | undefined
        let outside: string | undefined
        let stage = 'provider read failed'
        try {
          const reads = await Promise.allSettled([...clients].map(async ([name, client]) => ({ name, offer: await client.watchOffer(recipe, maxPrice, signal) })))
          const failures: string[] = []
          const hits: { name: HostVendorId; offer: HostOffer }[] = []
          for (const [index, read] of reads.entries()) {
            if (read.status === 'fulfilled') { if (read.value.offer) hits.push({ name: read.value.name, offer: read.value.offer }) }
            else if (signal.aborted || unauthorized(read.reason) || clients.size === 1) throw read.reason
            else failures.push(vendorLabel([...clients.keys()][index]!) + ' read failed: ' + clean(String(read.reason)).slice(0, 120))
          }
          if (!hits.length && failures.length === clients.size) throw new Error(failures.join(' · '))
          if (failures.length) log(failures.join(' · '))
          const best = hits.sort((a, b) => a.offer.price - b.offer.price)[0]
          offer = best?.offer
          hit = best?.name ?? 'runpod'
          if (offer && hit === 'runpod' && runpod) {
            stage = 'weights disk not ready'
            volume = await rentalVolume(runpod, offer.recipe, signal)
            stage = 'provider read failed'
            const disk = volume
            if (disk?.kind === 'network' && offer.dataCenter && offer.dataCenter !== disk.dataCenter) {
              outside = offer.dataCenter
              offer = (await runpod.offers(signal)).filter(row => matchesVolume(disk, row.recipe) && row.dataCenter === disk.dataCenter && cents(row.price) <= cents(maxPrice)).sort((a, b) => a.price - b.price)[0]
            }
          }
        } catch (error) {
          if (signal.aborted || unauthorized(error)) throw error
          wait = Math.max(Math.min(60_000, wait * 2), (error instanceof RunpodHttpError ? error.retryAfterSeconds ?? 0 : 0) * 1000)
          const step = (error instanceof RunpodHttpError ? 'Runpod read failed' : stage) + ' · next read in ' + Math.ceil(wait / 1000) + ' s · ' + clean(String(error)).slice(0, 200)
          log(step)
          patchHostRecord(id, { step })
          await rest(wait)
          continue
        }
        wait = pollMs
        const rateLimit = watchRateWords(pollMs, runpod ? runpod.rateLimitPolicy() ?? '' : undefined, [...clients.keys()])
        const afterPoll = readHostRecord(id)
        if (!afterPoll || afterPoll.generation !== generation || afterPoll.jobState === 'stopped') return
        if (afterPoll.rateLimit !== rateLimit) patchHostRecord(id, { rateLimit })
        if (!offer && outside && volume) {
          const step = 'stock only in ' + outside + ' · weights disk ' + volume.id + ' lives in ' + volume.dataCenter + ' · next read in ' + Math.ceil(pollMs * 12 / 1000) + ' s'
          log(step)
          patchHostRecord(id, { step })
          await rest(pollMs * 12)
          continue
        }
        if (!offer) { await rest(pollMs); continue }
        const api = clients.get(hit)!
        const podName = 'mercury-' + randomUUID().slice(0, 12)
        const shapeWords = hostShape(offer.recipe) + ' · $' + offer.price.toFixed(2) + '/hr' + (offer.dataCenter ? ' in ' + offer.dataCenter : '') + (hit !== 'runpod' || clients.size > 1 ? ' · ' + vendorLabel(hit) : '')
        const marked = patchHostRecord(id, { creating: podName, step: 'creating ' + podName + ' · ' + shapeWords })
        if (!marked || marked.generation !== generation || marked.jobState === 'stopped') return
        let pod: HostPod
        try {
          if (!api.capabilities.managed) sshKey ??= await ensureHostKey(runner, signal)
          pod = await createHostResource(api, offer, sshKey?.publicKey ?? '', podName, volume)
        } catch (error) {
          const refusal = hostCreateRefusal(offer.recipe, error)
          if (!refusal) {
            const words = podName + ' may exist: ' + vendorLabel(hit) + ' gave no clear answer to the create · /llmhost → Machines I’m paying for · the watch stopped so it cannot rent twice · ' + clean(String(error))
            log(words)
            const failed = patchHostRecord(id, { jobState: 'failed', error: words, step: words })
            if (failed) hostNotice(failed, 'failed', failed.name + ' · ' + words)
            return
          }
          patchHostRecord(id, { creating: undefined })
          if (refusal.status !== 400 && refusal.status !== 429) throw error
          refused = vendorLabel(hit) + ' could not place ' + shapeWords + (refusal.detail ? ' · ' + refusal.detail : '')
          const step = vendorLabel(hit) + ' could not place ' + shapeWords + ' · no ' + hostResourceKind(offer.recipe) + ' was created · still watching' + (refusal.detail ? ' · ' + refusal.detail : '')
          log(step)
          patchHostRecord(id, { step })
          await rest(Math.max(pollMs, (refusal.retryAfterSeconds ?? 0) * 1000))
          continue
        }
        created = pod
        const rentedWords = 'Rented ' + model + ' · ' + shapeWords + ' · setting up'
        log(rentedWords)
        const setupRecord = queueHostSetup({
          ...hostClusterRecord(pod),
          vendor: hit,
          id: pod.id,
          name: pod.name,
          recipe: offer.recipe.id,
          recipeRow: offer.recipe,
          price: offer.price,
          ...(hit === 'huggingface' ? { recipeRow: offer.recipe } : {}),
          startedAt: pod.startedAt ?? pod.createdAt,
          status: pod.status,
          sessionId: afterPoll.sessionId,
          workspace: afterPoll.workspace,
          sshKey: api.capabilities.managed ? undefined : sshKey?.path,
          watchedFrom: id,
          huggingfaceCredential: afterPoll.huggingfaceCredential,
          volumeId: volume?.id,
          ...(hit === vendor && afterPoll.apiBaseUrl ? { apiBaseUrl: afterPoll.apiBaseUrl } : {}),
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
        const words = created ? created.id + ' was created but could not be recorded · ' + detail + ' · /llmhost → Machines I’m paying for' : 'stock watch stopped · ' + detail + (detail.includes('no pod was created') ? '' : ' · no pod was created')
        const failedRecord = patchHostRecord(id, { jobState: 'failed', error: words })!
        log(words)
        hostNotice(failedRecord, 'failed', failedRecord.name + ' · ' + words)
      }
    } finally { clearInterval(timer) }
    return
  }
  const deadline = Date.now() + timeout
  const readOnly = hostJobReadOnly({ label: vendorLabel(vendor), pauseMs: pause, timeoutMs: timeout, deadline, signal, mark })
  const cleanupRead = hostJobReadOnly({ label: vendorLabel(vendor), pauseMs: pause, timeoutMs: timeout, signal, mark })
  try {
    if (!key) throw new Error(keyRefusal ?? 'The saved ' + vendorLabel(vendor) + ' key is unavailable.')
    if (!recipe) throw new Error('The saved host recipe is unavailable.')
    const api = vendorClient(initial, { key })
    let endpointBase: string | undefined
    if (api.capabilities.managed) {
      if (!api.managedEndpoint) throw new Error('The managed provider has no readiness reader.')
      while (!signal.aborted && Date.now() + pause < deadline) {
        const observed = await readOnly('endpoint', readSignal => api.managedEndpoint!(id, readSignal)).catch(error => { if (notFound(error)) throw new HostPodMissing('the vendor no longer lists pod ' + id); throw error })
        patchHostRecord(id, { status: observed.pod.status })
        if (observed.pod.status === 'ERROR') throw new Error('HF endpoint failed to start. ' + await readOnly('log', readSignal => api.logs(id, readSignal)))
        if (observed.pod.status === 'RUNNING' && observed.baseUrl) { endpointBase = observed.baseUrl; break }
        mark('HF endpoint · starting · ' + Math.floor((Date.now() - (initial.jobStartedAt ?? Date.now())) / 60_000) + ' min')
        await delay(Math.min(pause, Math.max(1, deadline - Date.now())), undefined, { signal })
      }
      if (!endpointBase) throw new Error('HF endpoint did not reach running within the setup budget.')
    } else if (initial.cluster) {
      target = await startHostCluster(runpodOnly(api, 'Clusters'), initial, recipe, runner, signal, pause, timeout, mark, head => { target = head })
      clusterStarted = true
    } else {
    let last = 'SSH address not yet assigned'
    let keyRefusals = 0
    while (!signal.aborted && Date.now() < deadline) {
      const pod = await readOnly('pod', readSignal => api.get(id, readSignal)).catch(error => { if (notFound(error)) throw new HostPodMissing('the vendor no longer lists pod ' + id); throw error })
      const direct = pod.ssh?.direct
      if (pod.status === 'EXITED' || pod.status === 'ERROR') throw new Error('Pod is ' + pod.status + '. ' + await readOnly('log', readSignal => api.logs(id, readSignal)))
      if (direct && pod.status === 'RUNNING') {
        const candidate = { host: direct.host, port: direct.port, user: direct.username, key: initial.sshKey ?? initial.target?.key }
        try { await runner.run('ssh', [...sshArguments(candidate), vendor === 'lambda' ? 'cloud-init status --wait >/dev/null && test -w /workspace && command -v setsid >/dev/null && command -v curl >/dev/null' : 'true'], signal); target = candidate; break } catch (error) {
          last = String(error)
          keyRefusals = /Permission denied \(publickey\)/i.test(last) ? keyRefusals + 1 : 0
          if (keyRefusals >= 3) throw new Error('the pod did not accept Mercury’s SSH key · ' + vendorKeyNotice(vendor))
        }
      } else keyRefusals = 0
      await delay(pause, undefined, { signal })
    }
    if (!target) throw new Error(last)
    patchHostRecord(id, { target, status: 'RUNNING' })
    let keptWeights: string | undefined
    if (initial.volumeId) {
      keptWeights = await prepareKeptWeights(initial, recipe, runpodOnly(api, 'Fast-load weights disks'), target, runner, signal, mark, cleanupRead)
      if (initial.prepareWeightsOnly) return
    }
    if (!keptWeights) keptWeights = await uploadBankForRental(recipe, vendor, target, runner, signal, mark)
    mark(recipe.engine === 'llamacpp' ? 'checking engine' : 'installing')
    const vm = vendor === 'lambda'
    const docker = vm ? (await inspectSsh(target, runner, signal)).docker : false
    await startHostEngine(target, recipe, runner, signal, docker, !vm, undefined, keptWeights)
    await waitHostEngine(target, recipe, runner, signal, pause, timeout, log)
    }
    patchHostRecord(id, { target, status: 'RUNNING' })
    let port: number | undefined
    if (!api.capabilities.managed) {
      if (!target) throw new Error('The pod has no SSH address.')
      mark('starting engine')
      port = await openHostTunnel(id, target, runner, signal)
      patchHostRecord(id, { localPort: port })
      mark('tunnel on 127.0.0.1:' + port)
      endpointBase = 'http://127.0.0.1:' + port + '/v1'
    }
    const setupSignal = api.capabilities.managed ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) : signal
    let provider = initial.provider ?? ('pod-' + id.toLowerCase().replaceAll('_', '-')).slice(0, 32)
    const result = await runLlmHost(async question => {
      switch (question.step) {
        case 'servers': return initial.provider ?? '__add__'
        case 'action': return 'repoint'
        case 'address': return endpointBase!
        case 'dialect': return recipe.engine ?? 'sglang'
        case 'key': if (api.capabilities.managed) { key = await huggingfaceKey(); return key ?? null }; if (question.found === LLM_HOST_WORDS.keyOptional) return ''; break
        case 'model': return question.rows?.find(row => row.value === recipe.model || row.value.startsWith(recipe.model + ':'))?.value ?? (question.rows?.length === 1 ? question.rows[0]!.value : null)
        case 'name':
          if (configuredCompatEndpoints().some(endpoint => endpoint.name === provider)) provider = 'pod-' + randomUUID().replaceAll('-', '').slice(0, 28)
          return provider
        case 'confirm': return 'run'
      }
      throw new Error('Setup needs input at ' + question.title + '. Resume from /llmhost.')
    }, () => {}, setupSignal)
    if (result.registered) {
      patchHostRecord(id, { provider })
      linkLlmHostPod(provider, id)
    }
    if (!result.ok || !result.registered || !result.model) throw new Error(result.words)
    mark('ready')
    const record = patchHostRecord(id, { jobState: 'ready' })!
    hostNotice(record, 'ready', hostReadyWords(recipe.label, result.model, record))
    if (options.keepAlive !== false) {
      const reconnects = 5
      const reconnect = async (why: string): Promise<void> => {
        if (api.capabilities.managed || !target || port === undefined) throw new Error('The HF endpoint no longer answers: ' + why)
        for (let attempt = 1; ; attempt++) {
          const words = 'tunnel dropped · reconnecting · attempt ' + attempt + ' of ' + reconnects + ' · ' + why
          log(words)
          patchHostRecord(id, { step: words })
          try {
            await openHostTunnel(id, target, runner, signal, port)
            patchHostRecord(id, { step: 'ready' })
            log('tunnel reconnected on 127.0.0.1:' + port)
            return
          } catch (error) {
            signal.throwIfAborted()
            why = clean(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 200)
            if (attempt >= reconnects) throw new Error('The SSH tunnel dropped and ' + reconnects + ' reconnects failed: ' + why)
            await delay(Math.min(60_000, pause * 2 ** attempt), undefined, { signal })
          }
        }
      }
      while (!signal.aborted) {
        await delay(pause, undefined, { signal })
        const observed = readHostRecord(id)
        if (observed?.retuning && (hostRetuneLive(observed) || (await reconcileHostTune(id, runner, signal))?.retuning)) continue
        let response: Response
        try {
          if (api.capabilities.managed) key = await huggingfaceKey()
          response = await fetch(endpointBase + '/models', { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), ...(api.capabilities.managed ? { headers: { Authorization: 'Bearer ' + key } } : {}), redirect: 'error' })
        } catch (error) {
          const current = readHostRecord(id)
          if (current && hostRetuneLive(current) || current?.advancedAt !== observed?.advancedAt) continue
          await reconnect(clean(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 200))
          continue
        }
        const after = readHostRecord(id)
        if (after && hostRetuneLive(after)) { await response.body?.cancel(); continue }
        if (!response.ok) { await response.body?.cancel(); await reconnect('HTTP ' + response.status + ' from the ' + (api.capabilities.managed ? 'endpoint' : 'tunnel')); continue }
        await response.body?.cancel()
      }
    }
  } catch (error) {
    if (error instanceof HostPreparationCleanupFailed) { closeHostTunnel(id); return }
    const failure = error
    const failedSetup = readHostRecord(id)
    if (failedSetup && failedSetup.generation === generation && failedSetup.jobState !== 'stopped' && !(error instanceof HostTerminationUnconfirmed) && !hostReadFailureWords(error) && (!initial.cluster || clusterStarted && !signal.aborted) && failedSetup.jobState !== 'ready') {
      const resource = initial.cluster ? 'cluster' : 'pod'
      const volume = initial.volumeId && readKeptVolume(initial.volumeId)
      if (volume && volume.state !== 'kept' && volume.state !== 'failed' && volume.state !== 'gone') writeKeptVolume({ ...volume, state: 'failed', error: clean(String(error)), preparingPod: undefined })
      const plain = (value: unknown): string => clean(value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim()
      const detail = plain(error)
      const disk = volume && volume.state !== 'gone' ? 'weights disk ' + volume.id + ' is kept and bills ' + keptDiskPrice(volume) : initial.volumeId ? 'weights disk billing is not verified; check your account' : ''
      const next = disk ? '/llmhost → Bank → d deletes the disk, or rent again' : '/llmhost to check the setup and rent again'
      try {
        const cleanupApi = vendorClient(initial, key ? { key } : {})
        const missing = error instanceof HostPodMissing
        if (initial.cluster) {
          await terminateHostResource(runpodOnly(cleanupApi, 'Clusters'), { id, name: failedSetup.name, status: failedSetup.status, cost: failedSetup.price, createdAt: failedSetup.startedAt, family: initial.cluster }, cleanupRead)
        } else if (missing) {
          let listed
          try { listed = await cleanupRead('pod listing', readSignal => cleanupApi.pods(readSignal)) } catch (listing) { throw new HostTerminationUnconfirmed(cleanupApi.label, listing) }
          if (listed.some(row => row.id === id && row.status !== 'TERMINATED')) throw new Error(cleanupApi.label + ' still lists the pod and it may still bill.')
        } else await terminateVerified(cleanupApi, id, cleanupRead, cleanupApi.label)
        if (failedSetup.provider) { const { removeLlmHostProvider } = await import('../llmHost/index.js'); removeLlmHostProvider(failedSetup.provider) }
        const endedVolume = initial.volumeId && readKeptVolume(initial.volumeId)
        if (endedVolume && endedVolume.preparingPod === id) writeKeptVolume({ ...endedVolume, preparingPod: undefined })
        const ended = missing
          ? 'the vendor no longer lists pod ' + id + ' · nothing to terminate · ' + (disk ? disk + ' · ' : '') + 'if it still bills, Machines I’m paying for shows it' + (disk ? ' · ' + next : '')
          : detail + ' · ' + resource + ' terminated and verified absent' + (initial.cluster ? ' (Runpod no longer lists it)' : '') + ' · ' + (disk || 'nothing more bills') + ' · ' + next
        log(ended)
        hostNotice(initial, 'failed', initial.name + ' · ' + ended)
        if (initial.prepareWeightsOnly || initial.cluster) removeHostRecord(id)
        else patchHostRecord(id, { status: 'TERMINATED', jobState: 'failed', step: missing ? 'pod no longer listed' : 'setup failed · instance terminated', error: ended })
        closeHostTunnel(id)
        return
      } catch (cleanup) {
        const words = detail + ' · ' + (cleanup instanceof HostTerminationUnconfirmed ? plain(cleanup) : 'Mercury could not verify ' + resource + ' termination: ' + plain(cleanup) + ' · check your account; ' + resource + ' ' + id + ' may still bill') + (disk ? ' · ' + disk : '') + ' · /llmhost → Machines I’m paying for → Terminate'
        log(words)
        patchHostRecord(id, { jobState: 'failed', error: words, step: words })
        hostNotice(initial, 'failed', initial.name + ' · ' + words)
        closeHostTunnel(id)
        return
      }
    }
    const current = readHostRecord(id)
    if (current && current.generation === generation && current.jobState !== 'stopped') {
      const retried = hostReadFailureWords(failure)
      const resource = initial.cluster ? 'cluster' : 'pod'
      const bills = 'Mercury did not terminate the ' + resource + '; it bills $' + initial.price.toFixed(2) + '/hr while it runs'
      const wasReady = current.jobState === 'ready'
      const detail = clean(retried ? retried + ' · setup paused · ' + bills + ' · Resume retries, Terminate stops the bill' : String(failure))
      const record = patchHostRecord(id, { jobState: 'failed', error: detail, ...(retried || failure instanceof HostTerminationUnconfirmed ? { step: detail } : {}), ...(error instanceof HostClusterEnded ? { status: 'TERMINATED' } : {}) })!
      log(detail)
      if (error instanceof HostClusterEnded) {
        hostNotice(record, 'failed', record.name + ' · ' + detail)
        removeHostRecord(id)
      } else if (retried || failure instanceof HostTerminationUnconfirmed) hostNotice(record, 'failed', record.name + ' · ' + detail + (failure instanceof HostTerminationUnconfirmed ? ' · it may still bill' : '') + ' · /llmhost → Machines I’m paying for')
      else if (wasReady) hostNotice(record, 'failed', record.name + ' · the tunnel to the ' + resource + ' dropped after setup: ' + detail + ' · ' + bills + ' · /llmhost → Machines I’m paying for → Resume to reconnect, Terminate to stop the bill')
      else hostNotice(record, 'failed', record.name + ' · setup stalled at ' + record.step + ' · ' + detail + ' · /llmhost → Machines I’m paying for → Resume or Terminate')
    }
    closeHostTunnel(id)
  } finally { clearInterval(timer) }
}
