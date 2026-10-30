import { appendFileSync } from 'node:fs'
import { HostPreparationCleanupFailed, prepareKeptWeights } from './keptWeights.js'
import { gigabytes, keptDiskPrice, matchesVolume, rentalVolume, readKeptVolume, writeKeptVolume, type KeptVolume } from './volumes.js'
import { randomUUID } from 'node:crypto'
import { configuredCompatEndpoints } from '../providers/openaicompat/compatAccounts.js'
import { hostHuggingfaceDispatchCredential } from './jobCredentials.js'
import { setTimeout as delay } from 'node:timers/promises'
import { vendorClient, vendorKey, vendorKeyNotice, vendorLabel, runpodOnly, type HostVendorId } from './vendors/client.js'
import { HostVendorHttpError } from './vendors/http.js'
import type { HostVendor } from './vendors/vendor.js'
import { VAST_VOLUME_MOUNT, VastClient } from './vendors/vast.js'
import { vastRentalVolume } from './vastVolumes.js'
import { linkLlmHostPod, runLlmHost } from '../llmHost/index.js'
import { hostMachineName, hostReadyWords, LLM_HOST_WORDS } from '../../commands/llmhost/words.js'
import { RunpodHttpError, cents, type HostOffer, type HostPod } from './runpod.js'
import { createHostResource, hostClusterRecord, hostCreateRefusal, hostResourceKind, hostShape, startHostCluster } from './cluster.js'
import { hostSetupTimeout } from './costs.js'
import { hostRecipeOfRecord } from './recipesFile.js'
import { hostNotice } from './notices.js'
import { hostDirectory, patchHostRecord, readHostRecord, removeHostRecord, type HostRecord } from './store.js'
import type { HostRecipe } from './recipes.js'
import { activeHostWatches, queueHostSetup, watchModel, watchRateWords } from './jobs.js'
import { bankModelPath, bytesWords, recordBankFailure, shortFolder, verifyBank } from './bank.js'
import { pullIntoBank } from './bankPull.js'
import { bankUploadBudget, bankUploadPreference, uploadBankForRental } from './keepSafe.js'
import { downloadPrivateRepoForRental, type WeightsSource } from './weightsSource.js'
import { reconcileRecord } from '../projectServices/serviceManager.js'
import { HostEngineDeath, engineDeathAfterReady, ensureHostKey, hostRunner, inspectSsh, sshArguments, startHostEngine, waitHostEngine, openHostTunnel, closeHostTunnel, type HostRunner, type SshTarget } from './ssh.js'
import { hostRetuneLive, reconcileHostTune, tunedRecipe } from './tune.js'
import { HostTerminationUnconfirmed, hostJobReadOnly, hostReadFailureWords } from './retry.js'
import { hostMachineOf, noteHostLink, hostLinkAttemptWords, hostLinkRecoveredWords, hostLinkLossWords } from './reliability.js'

const notFound = (error: unknown): boolean => (error instanceof RunpodHttpError || error instanceof HostVendorHttpError) && error.status === 404
class HostPodMissing extends Error {}
class HostLinkLost extends Error {
  constructor(message: string, readonly engineLog: string) { super(message) }
}
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
const unauthorized = (error: unknown): boolean => (error instanceof RunpodHttpError || error instanceof HostVendorHttpError) && (error.status === 401 || error.status === 403)
const inferredWeightsSource = (record: HostRecord, recipe: HostRecipe | undefined, vendor: HostVendorId): WeightsSource => {
  if (record.volumeId) return { kind: 'volume', volumeId: record.volumeId }
  const preference = recipe && (vendor === 'vast' || vendor === 'lambda') ? bankUploadPreference(recipe) : undefined
  return preference ? { kind: 'bank', folder: preference.folder } : { kind: 'huggingface' }
}
async function rentingSessionRow(record: Pick<HostRecord, 'sessionId'>): Promise<{ modelKey?: string } | undefined> {
  if (!record.sessionId) return undefined
  try {
    const { readSessionWorkers } = await import('../../daemon/concourseWorkers.js')
    return Object.values(readSessionWorkers()).find(row => row.sessionId === record.sessionId && row.endedAt === undefined && row.stoppedAt === undefined && row.parkedAt === undefined)
  } catch {
    return undefined
  }
}
export async function rentingSessionModel(record: Pick<HostRecord, 'sessionId'>): Promise<string | undefined> {
  return (await rentingSessionRow(record))?.modelKey
}
export async function switchRentingSession(record: Pick<HostRecord, 'sessionId'>, model: string): Promise<boolean> {
  if (!record.sessionId) return false
  try {
    if (!(await rentingSessionRow(record))) return false
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    const reply = await daemonControlRpc({ op: 'sessionControl', action: 'set-model', sessionId: record.sessionId, by: 'llmhost', model } as never, { timeoutMs: 30_000 }) as { ok?: boolean; outcome?: string }
    return reply.ok === true && (reply.outcome === 'applied' || reply.outcome === 'queued')
  } catch {
    return false
  }
}
export async function restoreRentingSession(record: Pick<HostRecord, 'sessionId' | 'sessionModel' | 'sessionModelBefore'>): Promise<boolean> {
  if (!record.sessionModelBefore || !record.sessionModel) return false
  const row = await rentingSessionRow(record)
  if (!row || row.modelKey !== record.sessionModel) return false
  return switchRentingSession(record, record.sessionModelBefore)
}
function watchedSourceFor(source: WeightsSource | undefined, hit: HostVendorId, managed: boolean, volume: KeptVolume | undefined): { source?: WeightsSource; skip?: string } {
  if (!source) return {}
  if (source.kind === 'volume') return volume ? { source: { kind: 'volume', volumeId: volume.id } } : { skip: 'your kept volume is not on that machine' }
  if (managed && source.kind !== 'huggingface') return { skip: vendorLabel(hit) + ' endpoints cannot use ' + (source.kind === 'bank' ? 'your bank' : 'a private repository') }
  return { source }
}

export async function runHostJob(id: string, generation: string, options: { runner?: HostRunner; pauseMs?: number; timeoutMs?: number; engineGraceMs?: number; signal?: AbortSignal; keepAlive?: boolean } = {}): Promise<void> {
  const initial = readHostRecord(id)
  if (!initial || initial.generation !== generation || !['queued', 'starting'].includes(initial.jobState ?? '')) return
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
  const runner = options.runner ?? hostRunner
  const pause = options.pauseMs ?? 5000
  const timeout = options.timeoutMs ?? (hostSetupTimeout(hostRecipeOfRecord(initial)) + (['vast', 'lambda', 'hyperstack', 'verda', 'digitalocean'].includes(initial.vendor ?? '') ? bankUploadBudget(hostRecipeOfRecord(initial)) : 0))
  const vendor = initial.vendor ?? 'runpod'
  let keyRefusal: string | undefined
  const huggingfaceKey = async (): Promise<string | undefined> => { try { return (await hostHuggingfaceDispatchCredential(initial))?.key } catch (error) { keyRefusal = error instanceof Error ? error.message : String(error); return undefined } }
  let key = vendor === 'huggingface' ? await huggingfaceKey() : vendorKey(vendor)
  const secrets: string[] = []
  const clean = (text: string): string => [key, ...secrets].reduce<string>((out, secret) => secret ? out.split(secret).join('[redacted]') : out, text)
  const mark = (step: string): void => {
    const record = readHostRecord(id)
    if (!record || record.generation !== generation || record.jobState === 'stopped') controller.abort()
    signal.throwIfAborted()
    if (!record) return
    if (record.step === step || record.jobState === 'ready' || record.jobState === 'paused' || record.jobState === 'failed') return
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
  const originalRecipe = hostRecipeOfRecord(initial)
  const recipe = originalRecipe && initial.tune ? tunedRecipe(originalRecipe, initial.tune) : originalRecipe
  patchHostRecord(id, { jobState: 'running', error: undefined })
  const timer = setInterval(() => {
    const current = readHostRecord(id)
    if (!current || current.generation !== generation || current.jobState === 'stopped') controller.abort()
    if (initial.jobKind === 'watch' || !target || !recipe || logBusy || signal.aborted || current?.jobState === 'ready' || current?.jobState === 'paused' || current?.jobState === 'failed') return
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
      if (verifying) {
        const receipt = await verifyBank(recipe, folder, signal, mark)
        mark('verified')
        hostNotice(initial, 'verified', initial.name + ' · check passed · ' + receipt.files + ' files · ' + bytesWords(receipt.bytes))
        removeHostRecord(id)
        return
      }
      mark('downloading from Hugging Face' + (token ? ' with your Hugging Face token' : ''))
      const receipt = await pullIntoBank(recipe, folder, { signal, token: token?.key, runner, progress: mark, pollMs: Math.max(1000, pause) })
      mark('banked')
      hostNotice(initial, 'banked', initial.name + ' · banked on ' + shortFolder(folder) + ' · ' + bytesWords(receipt.bytes))
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
          const wantsVolume = !current.weightsSource || current.weightsSource.kind === 'volume'
          if (offer && hit === 'runpod' && runpod && wantsVolume) {
            stage = 'weights disk not ready'
            volume = await rentalVolume(runpod, offer.recipe, signal)
            stage = 'provider read failed'
            const disk = volume
            if (disk?.kind === 'network' && offer.dataCenter && offer.dataCenter !== disk.dataCenter) {
              outside = offer.dataCenter
              offer = (await runpod.offers(signal)).filter(row => matchesVolume(disk, row.recipe) && row.dataCenter === disk.dataCenter && cents(row.price) <= cents(maxPrice)).sort((a, b) => a.price - b.price)[0]
            }
          }
          const vast = clients.get('vast')
          if (offer && hit === 'vast' && vast instanceof VastClient && wantsVolume) {
            stage = 'Vast.ai volume not ready'
            const mount = await vastRentalVolume(vast, offer.recipe, offer, signal)
            volume = mount ? readKeptVolume(mount.id) : undefined
            stage = 'provider read failed'
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
        const shapeWords = hostShape(offer.recipe) + ' · $' + offer.price.toFixed(2) + '/hr' + (offer.dataCenter ? ' in ' + offer.dataCenter : '') + (hit !== 'runpod' || clients.size > 1 ? ' · ' + vendorLabel(hit) : '')
        const watched = watchedSourceFor(afterPoll.weightsSource, hit, Boolean(api.capabilities.managed), volume)
        if (watched.skip) {
          const step = 'stock at ' + vendorLabel(hit) + ' (' + shapeWords + ') but ' + watched.skip + ' · no ' + hostResourceKind(offer.recipe) + ' was created · still watching'
          log(step)
          patchHostRecord(id, { step })
          await rest(pollMs * 12)
          continue
        }
        const mount = !afterPoll.weightsSource || watched.source?.kind === 'volume' ? volume : undefined
        const podName = 'mercury-' + randomUUID().slice(0, 12)
        const marked = patchHostRecord(id, { creating: podName, step: 'creating ' + podName + ' · ' + shapeWords })
        if (!marked || marked.generation !== generation || marked.jobState === 'stopped') return
        let pod: HostPod
        try {
          if (!api.capabilities.managed) sshKey ??= await ensureHostKey(runner, signal)
          pod = await createHostResource(api, offer, sshKey?.publicKey ?? '', podName, mount)
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
          machineId: hostMachineOf(hit, offer),
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
          volumeId: mount?.id,
          ...(watched.source ? { weightsSource: watched.source } : {}),
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
    let loadedWeights: string | undefined
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
    } else {
    let last = 'SSH address not yet assigned'
    let sshDeadline = deadline
    let sshRead = readOnly
    let keyRefused = false
    let keyAttached = false
    for (;;) {
      while (!signal.aborted && Date.now() < sshDeadline) {
        const pod = await sshRead('pod', readSignal => api.get(id, readSignal)).catch(error => { if (notFound(error)) throw new HostPodMissing('the vendor no longer lists pod ' + id); if (hostReadFailureWords(error) && Date.now() >= sshDeadline - pause) throw new Error(last); throw error })
        const direct = pod.ssh?.direct
        keyRefused = false
        if (pod.status === 'EXITED' || pod.status === 'ERROR') throw new Error('Pod is ' + pod.status + '. ' + await sshRead('log', readSignal => api.logs(id, readSignal)))
        if (direct && pod.status === 'RUNNING') {
          const candidate = { host: direct.host, port: direct.port, user: direct.username, key: initial.sshKey ?? initial.target?.key }
          try { await runner.run('ssh', [...sshArguments(candidate), vendor === 'lambda' ? 'cloud-init status --wait >/dev/null && test -w /workspace && command -v setsid >/dev/null && command -v curl >/dev/null' : api.capabilities.vm ? 'test -r /workspace/.mercury-vm-ready && test -w /workspace && command -v setsid >/dev/null && command -v curl >/dev/null' : 'true'], signal); target = candidate; break } catch (error) {
            last = String(error)
            const refused = /Permission denied \(publickey\)/i.test(last)
            keyRefused = refused
            mark(keyAttached ? 'waiting for SSH · key attached to the instance · retrying' : refused ? 'waiting for SSH · the machine has not accepted the key yet · retrying until it does' : 'waiting for SSH')
            if (refused) last = keyAttached ? 'the machine still refuses Mercury’s SSH key' : 'the machine never accepted Mercury’s SSH key before the setup deadline · ' + vendorKeyNotice(vendor)
          }
        }
        await delay(Math.min(pause, Math.max(1, sshDeadline - Date.now())), undefined, { signal })
      }
      signal.throwIfAborted()
      if (target) break
      if (!(api instanceof VastClient) || !keyRefused || keyAttached) throw new Error((keyAttached ? 'Mercury attached the SSH key to this instance and retried · ' : '') + last)
      const pod = await cleanupRead('pod', readSignal => api.get(id, readSignal))
      if (pod.status !== 'RUNNING' || !pod.ssh?.direct) throw new Error(last)
      try {
        const keyPath = initial.sshKey ?? initial.target?.key
        if (!keyPath) throw new Error('the rental has no saved SSH key file')
        const publicKey = (await runner.run('ssh-keygen', ['-y', '-f', keyPath], signal)).trim()
        secrets.push(publicKey)
        await api.attachSshKey(id, publicKey, signal)
      } catch (error) { throw new Error('Mercury could not attach the SSH key to this instance · ' + clean(error instanceof Error ? error.message : String(error))) }
      keyAttached = true
      log('Mercury attached the SSH key to this instance · retrying SSH')
      sshDeadline = Date.now() + Math.min(timeout, 4 * 60_000)
      sshRead = hostJobReadOnly({ label: api.label, pauseMs: pause, timeoutMs: timeout, deadline: sshDeadline, signal, mark })
    }
    patchHostRecord(id, { target, status: 'RUNNING' })
    const answering = initial.linkLost && await runner.run('ssh', [...sshArguments(target), 'curl -fsS --max-time 10 http://127.0.0.1:30000/health && curl -fsS --max-time 10 http://127.0.0.1:30000/v1/models'], signal).then(() => true).catch(() => false)
    if (answering) {
      loadedWeights = initial.loadedWeights
      mark('engine still answering · reconnecting')
    } else {
    let keptWeights: string | undefined
    let engineCache: string | undefined
    const source = initial.weightsSource ?? inferredWeightsSource(initial, recipe, vendor)
    const vm = vendor === 'lambda' || api.capabilities.vm === true
    const docker = vm ? (await inspectSsh(target, runner, signal)).docker : false
    const stillLoaded = initial.loadedWeights && source.kind !== 'volume'
      ? await runner.run('ssh', [...sshArguments(target), 'test -d ' + quote(initial.loadedWeights) + ' && echo MERCURY_WEIGHTS_PRESENT'], signal).then(out => out.includes('MERCURY_WEIGHTS_PRESENT')).catch(() => false)
      : false
    if (stillLoaded) {
      keptWeights = initial.loadedWeights
      mark('weights already on the machine · no download')
    } else if (source.kind === 'volume') {
      if (initial.volumeId !== source.volumeId) throw new Error('The chosen weights volume ' + source.volumeId + ' is not mounted on this machine; nothing was downloaded. Rent again from /llmhost.')
      const disk = readKeptVolume(source.volumeId)
      keptWeights = await prepareKeptWeights(initial, recipe, disk?.kind === 'vast' ? api : runpodOnly(api, 'Fast-load weights disks'), target, runner, signal, mark, cleanupRead)
      if (initial.prepareWeightsOnly) return
      if (disk?.kind === 'vast') engineCache = (disk.mountPath ?? VAST_VOLUME_MOUNT) + '/engine-cache'
    } else if (source.kind === 'bank') {
      keptWeights = await uploadBankForRental(recipe, vendor, target, runner, signal, mark, { folder: source.folder })
      if (!keptWeights) throw new Error('The bank upload returned no folder on the machine; nothing was downloaded.')
    } else if (source.kind === 'private-repo') {
      const token = await huggingfaceKey()
      if (!token) throw new Error(keyRefusal ?? 'The saved Hugging Face sign-in is unavailable, so ' + source.repo + ' cannot be read; nothing was downloaded. Connect with /logins huggingface and resume.')
      secrets.push(token)
      keptWeights = await downloadPrivateRepoForRental(source, recipe, token, target, runner, signal, mark, { docker, pod: !vm })
    }
    mark(recipe.engine === 'llamacpp' ? 'checking engine' : 'installing')
    await startHostEngine(target, recipe, runner, signal, docker, !vm, undefined, keptWeights, undefined, engineCache)
    await waitHostEngine(target, recipe, runner, signal, pause, timeout, log, options.engineGraceMs)
    loadedWeights = keptWeights ?? (recipe.weightsGb || recipe.engine === 'llamacpp' ? '/workspace/mercury-host/' + recipe.id + '/weights' : undefined)
    }
    }
    patchHostRecord(id, { target, status: 'RUNNING' })
    let port: number | undefined
    if (!api.capabilities.managed) {
      if (!target) throw new Error('The pod has no SSH address.')
      mark('starting engine')
      port = await openHostTunnel(id, target, runner, signal, initial.linkLost ? initial.localPort : undefined)
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
    const record = patchHostRecord(id, { jobState: 'ready', engineDeath: undefined, linkLost: undefined, ...(loadedWeights ? { loadedWeights } : {}) })!
    const modelBefore = await rentingSessionModel(record)
    const switched = await switchRentingSession(record, result.model)
    hostNotice(record, 'ready', hostReadyWords(recipe.label, result.model, record, switched))
    if (switched && modelBefore && modelBefore !== result.model && !record.sessionModelBefore) patchHostRecord(id, { sessionModelBefore: modelBefore, sessionModel: result.model })
    if (options.keepAlive !== false) {
      const reconnects = 5
      const reconnect = async (why: string): Promise<void> => {
        if (api.capabilities.managed || !target || port === undefined) throw new Error('The HF endpoint no longer answers: ' + why)
        let engineLog = 'engine log unread'
        const death = await engineDeathAfterReady(target, recipe, runner, signal, text => {
          const lines = clean(text).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('MERCURY_')).slice(-8)
          engineLog = lines.length ? 'Last engine lines:\n' + lines.join('\n') : 'engine log is empty'
        }).catch(() => undefined)
        if (death) throw death
        for (let attempt = 1; ; attempt++) {
          const words = hostLinkAttemptWords(noteHostLink({ ...record, vendor }, { outcome: 'reconnecting', attempt, why }), reconnects)
          log(words)
          patchHostRecord(id, { step: words })
          try {
            await openHostTunnel(id, target, runner, signal, port)
            patchHostRecord(id, { step: 'ready' })
            log(hostLinkRecoveredWords(noteHostLink({ ...record, vendor }, { outcome: 'recovered', attempt }), port))
            return
          } catch (error) {
            signal.throwIfAborted()
            why = clean(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 200)
            if (attempt >= reconnects) throw new HostLinkLost(hostLinkLossWords(noteHostLink({ ...record, vendor }, { outcome: 'lost', attempt, why })), engineLog)
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
    if (error instanceof HostEngineDeath && failedSetup && failedSetup.generation === generation && failedSetup.jobState !== 'stopped') {
      const machine = hostMachineName(vendor, id)
      const words = machine + ' · ' + clean(error.message) + ' · paused, $' + failedSetup.price.toFixed(2) + '/hr still billing · Resume or Terminate in /llmhost'
      log(words)
      const at = error.facts.at
      const step = 'paused · the engine died after setup'
      const paused = patchHostRecord(id, { jobState: 'paused', step, error: words, engineDeath: error.facts, linkLost: undefined, advancedAt: at, steps: [...(failedSetup.steps ?? []), { step, at }] }) ?? failedSetup
      hostNotice(paused, 'paused', initial.name + ' · ' + words)
      closeHostTunnel(id)
      return
    }
    if (error instanceof HostLinkLost && failedSetup && failedSetup.generation === generation && failedSetup.jobState !== 'stopped') {
      const words = clean(error.message) + ' · paused, $' + failedSetup.price.toFixed(2) + '/hr still billing · Resume or Terminate in /llmhost'
      log(words)
      const at = Date.now()
      const step = 'paused · the link dropped after setup'
      const paused = patchHostRecord(id, { jobState: 'paused', step, error: words, linkLost: true, advancedAt: at, steps: [...(failedSetup.steps ?? []), { step, at }] }) ?? failedSetup
      hostNotice(paused, 'paused', initial.name + ' · ' + words + '\n' + error.engineLog)
      closeHostTunnel(id)
      return
    }
    if (failedSetup && failedSetup.generation === generation && failedSetup.jobState !== 'stopped' && !(error instanceof HostTerminationUnconfirmed) && !hostReadFailureWords(error) && failedSetup.jobState !== 'ready') {
      const resource = initial.cluster ? 'cluster' : 'pod'
      const volume = initial.volumeId && readKeptVolume(initial.volumeId)
      if (volume && volume.state !== 'kept' && volume.state !== 'failed' && volume.state !== 'gone') writeKeptVolume({ ...volume, state: 'failed', error: clean(String(error)), preparingPod: undefined })
      const plain = (value: unknown): string => clean(value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim()
      const detail = plain(error)
      const disk = volume && volume.state !== 'gone' ? 'weights disk ' + volume.id + ' is kept' + (volume.partialBytes === undefined ? '' : ' with ' + gigabytes(volume.partialBytes) + ' downloaded') + ' and bills ' + keptDiskPrice(volume) : initial.volumeId ? 'weights disk billing is not verified; check your account' : ''
      if (error instanceof HostPodMissing) {
        const next = disk ? '/llmhost → Bank → d deletes the disk, or rent again' : '/llmhost to check the setup and rent again'
        try {
          const cleanupApi = vendorClient(initial, key ? { key } : {})
          let listed
          try { listed = await cleanupRead('pod listing', readSignal => cleanupApi.pods(readSignal)) } catch (listing) { throw new HostTerminationUnconfirmed(cleanupApi.label, listing) }
          if (listed.some(row => row.id === id && row.status !== 'TERMINATED')) throw new Error(cleanupApi.label + ' still lists the pod and it may still bill.')
          if (failedSetup.provider) { const { removeLlmHostProvider } = await import('../llmHost/index.js'); removeLlmHostProvider(failedSetup.provider) }
          const endedVolume = initial.volumeId && readKeptVolume(initial.volumeId)
          if (endedVolume && endedVolume.preparingPod === id) writeKeptVolume({ ...endedVolume, preparingPod: undefined })
          const ended = 'the vendor no longer lists pod ' + id + ' · nothing to terminate · ' + (disk ? disk + ' · ' : '') + 'if it still bills, Machines I’m paying for shows it' + (disk ? ' · ' + next : '')
          log(ended)
          hostNotice(initial, 'failed', initial.name + ' · ' + ended)
          if (initial.prepareWeightsOnly) removeHostRecord(id)
          else patchHostRecord(id, { status: 'TERMINATED', jobState: 'failed', step: 'pod no longer listed', error: ended })
        } catch (cleanup) {
          const words = detail + ' · ' + (cleanup instanceof HostTerminationUnconfirmed ? plain(cleanup) : 'Mercury could not verify ' + resource + ' termination: ' + plain(cleanup) + ' · check your account; ' + resource + ' ' + id + ' may still bill') + (disk ? ' · ' + disk : '') + ' · /llmhost → Machines I’m paying for → Terminate'
          log(words)
          patchHostRecord(id, { jobState: 'failed', error: words, step: words })
          hostNotice(initial, 'failed', initial.name + ' · ' + words)
        }
        closeHostTunnel(id)
        return
      }
      const machine = initial.cluster ? 'Runpod cluster ' + id + ' (' + (initial.nodes?.length ?? initial.cluster.compute.podCount) + ' nodes)' : hostMachineName(vendor, id)
      const billing = /^Pod is EXITED\b/.test(detail) ? machine + ' · stopped; disk still bills until Terminate' : machine + ' · $' + failedSetup.price.toFixed(2) + '/hr still billing'
      const words = 'setup paused · ' + detail + ' · ' + billing + (disk ? ' · ' + disk : '') + ' · Resume or Terminate in /llmhost'
      log(words)
      const at = Date.now()
      const step = 'paused at ' + (failedSetup.step ?? 'setup').replace(/ · retrying until it does$/, '')
      const paused = patchHostRecord(id, { jobState: 'paused', step, error: words, advancedAt: at, steps: [...(failedSetup.steps ?? []), { step, at }] }) ?? failedSetup
      hostNotice(paused, 'paused', initial.name + ' · ' + words)
      closeHostTunnel(id)
      return
    }
    const current = readHostRecord(id)
    if (current && current.generation === generation && current.jobState !== 'stopped') {
      const retried = hostReadFailureWords(failure)
      const resource = initial.cluster ? 'cluster' : 'pod'
      const bills = 'Mercury did not terminate the ' + resource + '; it bills $' + current.price.toFixed(2) + '/hr while it runs'
      const wasReady = current.jobState === 'ready'
      const detail = clean(retried ? retried + ' · setup paused · ' + bills + ' · Resume retries, Terminate stops the bill' : String(failure))
      const at = Date.now()
      const record = patchHostRecord(id, { jobState: retried ? 'paused' : 'failed', error: detail, ...(retried || failure instanceof HostTerminationUnconfirmed ? { step: detail } : {}), ...(retried ? { advancedAt: at, steps: [...(current.steps ?? []), { step: detail, at }] } : {}) })!
      log(detail)
      if (retried || failure instanceof HostTerminationUnconfirmed) hostNotice(record, 'failed', record.name + ' · ' + detail + (failure instanceof HostTerminationUnconfirmed ? ' · it may still bill' : '') + ' · /llmhost → Machines I’m paying for')
      else if (wasReady) hostNotice(record, 'failed', record.name + ' · the tunnel to the ' + resource + ' dropped after setup: ' + detail + ' · ' + bills + ' · /llmhost → Machines I’m paying for → Resume to reconnect, Terminate to stop the bill')
      else hostNotice(record, 'failed', record.name + ' · setup stalled at ' + record.step + ' · ' + detail + ' · /llmhost → Machines I’m paying for → Resume or Terminate')
    }
    closeHostTunnel(id)
  } finally { clearInterval(timer) }
}
