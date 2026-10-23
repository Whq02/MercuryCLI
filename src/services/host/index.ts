import { randomUUID } from 'node:crypto'
import { createBoxRoad } from './boxRoad.js'
import { setTimeout as delay } from 'node:timers/promises'
import { hostPaidPodWords, hostSetupEstimate, LLM_HOST_WORDS as words } from '../../commands/llmhost/words.js'
import { runLlmHost, type LlmHostRoad, type LlmHostResult } from '../llmHost/index.js'
import { HOST_VENDORS, vendorClient, vendorKey, vendorLabel, saveVendorKey, vendorStorage, vendorKeyNotice, runpodOnly, type HostVendorId } from './vendors/client.js'
import { HOST_VENDOR_INFO, type HostVendor } from './vendors/vendor.js'
import { formatHostOfferLabel, hostRecipeVerificationWord, type HostRecipe } from './recipes.js'
import { currentHostRecipes } from './recipesFile.js'
import { compatModelEndpoint } from '../providers/openaicompat/compatAccounts.js'
import { createHostResource, getHostResource, listHostResources, terminateHostResource, hostClusterRecord, hostCreateRefusal, hostResourceKind, hostResourceLabel, hostShape } from './cluster.js'
import { heavyWeights, hostPriceLines, hostShortStorageWords, hostStorageWords } from './costs.js'
import { cents, type RunpodClient, type HostOffer, type HostPod } from './runpod.js'
import { closeHostTunnel, ensureHostKey, fitsSsh, hostRunner, inspectSsh, localKeyPath, openHostTunnel, sshAliases, sshArguments, startHostEngine, waitHostEngine, type HostRunner, type SshTarget } from './ssh.js'
import { hostRecords, readHostRecord, removeHostRecord, writeHostRecord, type HostRecord } from './store.js'
import { activeHostWatches as activeWatches, hostJobRunning, hostLogTail, queueHostSetup, queueHostWatch, requireHostJobOwner, stopHostSetup, watchModel, watchRateWords } from './jobs.js'
import { hostJobReadOnly, HostTerminationUnconfirmed } from './retry.js'
import { getFocusedSessionConnector } from '../engine-connector/focusedConnector.js'
import { getSessionId } from '../../bootstrap/state.js'
import { BANK_DOOR, bankAction, bankDoor, ensureBankFolder, keptDiskForPod, terminateVolumeChoice, volumeDeleteDoor, volumeFitsOffer } from './fastLoad.js'
import { deleteKeptVolume, fastLoadEstimate, readKeptVolume, rentalVolume, reconcileVolumes, vastVolumeBilling, volumeLabel, volumePrice, type KeptVolume } from './volumes.js'
import { VastClient, VAST_VOLUME_NOTICE } from './vendors/vast.js'
import { deleteVastKeptVolume, reconcileVastVolumes, vastBootMinutes, vastKeptVolumes, vastRentalVolume, vastVolumeDeleteDoor, vastVolumeLabel } from './vastVolumes.js'

type HostOptions = { apiBaseUrl?: string; vendorApiBaseUrls?: Partial<Record<HostVendorId, string>>; runner?: HostRunner; pauseMs?: number; readyTimeoutMs?: number; startJob?: (record: HostRecord) => void; sessionId?: string; rental?: { client: HostVendor; offer: HostOffer } }
type VendorPod = HostPod & { vendor: HostVendorId }
const paidValue = (pod: VendorPod): string => pod.vendor === 'runpod' ? pod.id : pod.vendor + ':' + pod.id
const paidWords = (pod: VendorPod): string => vendorLabel(pod.vendor) + ' · ' + (pod.vendor === 'huggingface' ? pod.name + ' · HF endpoint · ' + (pod.status === 'PROVISIONING' ? 'starting · ' + Math.max(0, Math.floor((Date.now() - Date.parse(pod.createdAt)) / 60_000)) + ' min' : pod.status) + ' · ' + price(pod.cost) : pod.family ? hostResourceLabel(pod) + ' · ' + pod.id + ' · ' + pod.status + ' · ' + price(pod.cost) : hostPaidPodWords(pod, readHostRecord(pod.id)))
const price = (amount: number): string => '$' + amount.toFixed(2) + '/hr'
const shape = hostShape
const modelTitle = (recipe: HostRecipe): string => recipe.label.split(' · ')[0]!
const stockRank = (value?: string): number => value === 'HIGH' ? 3 : value === 'MEDIUM' ? 2 : value === 'LOW' ? 1 : 0
const verifiedRank = (recipe: HostRecipe): number => ['measured', 'documented', 'community', 'unverified'].indexOf(hostRecipeVerificationWord(recipe))
const keepWords = (pod: HostPod, vendor: HostVendorId): string => pod.id + ' · ' + (vendor === 'huggingface' ? 'HF endpoint · ' + (pod.status === 'EXITED' ? 'Paused · no compute bills' : 'running · ' + price(pod.cost) + ' until Pause or Terminate') + ' · /llmhost → Pods I’m paying for' : pod.family ? 'cluster still billable · /llmhost → Pods I’m paying for → Terminate' : pod.status === 'EXITED' ? words.stoppedDisk : 'pod still running · /llmhost → Pods I’m paying for → ' + (vendor === 'lambda' ? 'Terminate (Lambda has no Stop)' : 'Stop or Terminate'))

async function forgetEndedPods(live: readonly HostPod[]): Promise<string[]> {
  const { configuredCompatEndpoints } = await import('../providers/openaicompat/compatAccounts.js')
  const { removeLlmHostProvider } = await import('../llmHost/index.js')
  const lines: string[] = []
  const listed = (id: string): boolean => live.some(row => row.id === id || row.nodes?.some(node => node.id === id))
  const removed = (name: string): void => {
    removeLlmHostProvider(name)
    lines.push(name + ' is no longer in the account — its model entry was removed')
  }
  for (const record of hostRecords()) {
    if (record.jobKind === 'watch' || record.jobKind === 'bank' || record.creating) continue
    if (listed(record.id)) continue
    if (record.jobState === 'queued' || record.jobState === 'starting' || hostJobRunning(record)) continue
    if (record.provider) removed(record.provider)
    closeHostTunnel(record.id)
    removeHostRecord(record.id)
    if (!record.provider) lines.push(record.name + ' · ' + record.id + ' is no longer in the account')
  }
  for (const endpoint of configuredCompatEndpoints()) {
    if (endpoint.hostPodId && !listed(endpoint.hostPodId) && !readHostRecord(endpoint.hostPodId)) removed(endpoint.name)
  }
  return lines
}

export function createHostRoad(options: HostOptions = {}): LlmHostRoad {
  return async (ask, emit, lifetimeSignal) => {
    const signal = lifetimeSignal
    const sessionId = options.sessionId ?? (getFocusedSessionConnector().sessionId() || getSessionId())
    const runner = options.runner ?? hostRunner
    const pauseMs = options.pauseMs ?? 5000
    const timeoutMs = options.readyTimeoutMs ?? 90 * 60_000
    let vendor: HostVendorId = options.rental?.client.vendor ?? 'runpod'
    let key = vendorKey(vendor)
    let api: HostVendor | undefined = options.rental?.client
    let selectedRental = options.rental?.offer
    const baseFor = (id: HostVendorId): string | undefined => options.vendorApiBaseUrls?.[id] ?? (id === 'runpod' ? options.apiBaseUrl : undefined)
    const clients = new Map<HostVendorId, HostVendor>()
    if (api) clients.set(vendor, api)
    const clientFor = (id: HostVendorId): HostVendor => {
      let client = clients.get(id)
      if (!client) { client = vendorClient(id, { apiBaseUrl: baseFor(id) }); clients.set(id, client) }
      return client
    }
    const vastClient = (): VastClient | undefined => { if (!vendorKey('vast')) return; const client = clientFor('vast'); return client instanceof VastClient ? client : undefined }
    const bankOptionsFor = () => ({ runner, sessionId, apiBaseUrl: baseFor('runpod'), vastApiBaseUrl: baseFor('vast'), startJob: options.startJob, api: () => vendorKey('runpod') ? runpodOnly(clientFor('runpod'), 'Fast-load weights disks') : undefined, vast: vastClient, connect: () => connect('runpod') })
    const vastVolumeRows = async (): Promise<{ value: string; label: string }[]> => {
      const client = vastClient()
      if (!client) return []
      try { await reconcileVastVolumes(client, signal) } catch (error) { emit({ title: words.paid, words: 'Vast.ai volume list unavailable; volumes are not shown and may still bill. ' + String(error) }); return [] }
      const rows: { value: string; label: string }[] = []
      for (const row of vastKeptVolumes().filter(row => row.state !== 'gone')) {
        let stock = ''
        if (row.recipeRow && row.machineId) try { const offer = (await client.recipeOffers([row.recipeRow], signal)).find(item => item.machineId === row.machineId); stock = offer ? ' · ' + shape(offer.recipe) + ' in stock on that machine at ' + price(offer.price) : ' · no stock on that machine right now · w watch it' } catch { stock = ' · stock on that machine unread' }
        rows.push({ value: 'vastvolume:' + row.id, label: vastVolumeLabel(row) + stock })
      }
      return rows
    }
    let pod: HostPod | undefined
    let record: HostRecord | undefined
    let saved: LlmHostResult | undefined
    let pendingName = ''
    const stopped = (): LlmHostResult => ({ ok: false, words: pod ? keepWords(pod, vendor) : pendingName ? pendingName + ' · creation may still be running. /llmhost → Pods I’m paying for; no retry was sent.' : words.stopped })
    const question: Parameters<LlmHostRoad>[0] = plan => lifetimeSignal.aborted ? Promise.resolve(null) : ask(plan)
    const connect = async (id: HostVendorId): Promise<boolean> => {
      if (id === 'huggingface') {
        if (!vendorKey(id)) {
          const choice = await question({ step: 'huggingface-signin', title: 'Hugging Face sign-in', found: 'Use the same sign-in as /logins huggingface. The token needs Inference Endpoints management permission and access to the model.', willRun: 'Nothing is rented until the price confirmation.', rows: [{ value: 'login', label: 'Open existing Hugging Face sign-in' }, { value: 'saved', label: 'Use saved sign-in' }, { value: 'cancel', label: words.cancel }] })
          if (choice === 'login') await question({ step: 'huggingface-login', title: 'Hugging Face sign-in', found: '', willRun: '' })
          else if (choice !== 'saved') return false
        }
        const savedKey = vendorKey(id)
        if (!savedKey) { emit({ title: 'Hugging Face', words: 'No Hugging Face sign-in is saved. Connect with /logins huggingface, then return to /llmhost.' }); return false }
        const client = vendorClient(id, { apiBaseUrl: baseFor(id) })
        try { await client.pods(signal) } catch (error) { emit({ title: 'Hugging Face', words: String(error).split(savedKey).join('[redacted]') }); return false }
        clients.set(id, client)
        if (id === vendor) { key = savedKey; api = client }
        return true
      }
      const help = HOST_VENDOR_INFO[id].keyHelp
      const entered = await question({ step: id + '-key', title: vendorLabel(id) + ' API key', found: help, willRun: 'Nothing is rented until the price confirmation.', secret: true })
      if (!entered?.trim()) return false
      const client = vendorClient(id, { key: entered.trim(), apiBaseUrl: baseFor(id) })
      try { await client.pods(signal) } catch (error) { emit({ title: vendorLabel(id), words: String(error).split(entered.trim()).join('[redacted]') }); return false }
      saveVendorKey(id, entered.trim()); clients.set(id, client)
      if (id === vendor) { key = entered.trim(); api = client }
      return true
    }
    let listsComplete = true
    let listErrors: string[] = []
    const paidPods = async (): Promise<VendorPod[]> => {
      listsComplete = true
      listErrors = []
      const rows = await Promise.all(HOST_VENDORS.filter(id => vendorKey(id)).map(async id => {
        try { return (await listHostResources(clientFor(id), signal, detail => { listsComplete = false; listErrors.push(vendorLabel(id) + ' · ' + detail); emit({ title: vendorLabel(id), words: detail }) })).map(row => ({ ...row, vendor: id })) }
        catch (error) { listsComplete = false; listErrors.push(vendorLabel(id) + ' paid machines could not be read; count incomplete.'); emit({ title: vendorLabel(id), words: 'Paid machines could not be read; the other vendors are still shown. ' + String(error) }); return [] }
      }))
      return rows.flat()
    }
    const mark = (): void => {
      if (!pod) return
      emit({ title: words.manage, words: [record?.weightsCheck, record?.step, record?.error, record ? hostLogTail(record) : ''].filter(Boolean).join(' · ') || keepWords(pod, vendor), host: { id: pod.id, managed: api?.capabilities.managed, price: pod.cost, startedAt: pod.startedAt ?? pod.createdAt, status: record?.status ?? pod.status, canResume: Boolean(api?.capabilities.managed && pod.status === 'EXITED' || record && !hostJobRunning(record) && record.status === 'RUNNING'), canTune: Boolean(vendor === 'runpod' && record?.provider && record.target && record.status === 'RUNNING' && !pod.family), step: record?.step === 'building llama.cpp' ? record.step + ' ' + Math.floor((Date.now() - (record.advancedAt ?? Date.now())) / 60_000) + ' min' : record?.step } })
    }
    const finish = async (): Promise<LlmHostResult> => {
      if (!pod || !api) return saved ?? stopped()
      for (;;) {
        record = readHostRecord(pod.id)
        if (record?.status === 'TERMINATED') return { ok: false, words: record.error ?? 'Instance terminated and verified absent.' }
        if (record?.retuning) { const { reconcileHostTune } = await import('./tune.js'); record = await reconcileHostTune(pod.id, runner, signal) }
        mark()
        const refresh = setInterval(() => { if (pod) { record = readHostRecord(pod.id); mark() } }, 1000)
        let action: string | null
        try { action = await question({ step: 'pod-controls', title: words.manage, found: api.label + ' · ' + pod.name + ' · ' + pod.id + ' · ' + price(pod.cost), willRun: pod.family ? 'Cluster nodes and disks bill until termination; Runpod has no cluster Stop action.' : vendorStorage(vendor) + (vendor === 'runpod' ? '' : ' Tune reload and fast-load weights disks are Runpod-only.'), rows: [...(vendor === 'runpod' && record?.provider && record.target && pod.status === 'RUNNING' && !pod.family ? [{ value: 'tune', label: 'Tune · quality, conversations × context, thinking' }] : []), ...(api.capabilities.managed && pod.status === 'EXITED' || record && !hostJobRunning(record) && pod.status === 'RUNNING' ? [{ value: 'resume', label: api.capabilities.managed ? 'Resume endpoint' : 'Resume setup' }] : []), ...(!api.capabilities.stop || pod.family || pod.status === 'EXITED' ? [] : [{ value: 'stop', label: api.capabilities.managed ? 'Pause · end compute billing' : words.stopPod }]), { value: 'logs', label: 'Logs · vendor log tail' }, { value: 'terminate', label: api.capabilities.managed ? 'Terminate · delete the endpoint' : words.terminatePod }, { value: 'close', label: pod.status === 'EXITED' ? api.capabilities.managed ? 'Close · keep the paused endpoint' : words.closePod : words.keepPod }] }) } finally { clearInterval(refresh) }
        const latest = readHostRecord(pod.id)
        if (latest?.status === 'TERMINATED') return { ok: false, words: latest.error ?? 'Instance terminated and verified absent.' }
        if (!action || action === 'close') return { ...(saved ?? { ok: true }), words: keepWords(pod, vendor) }
        if (action === 'logs') { emit({ title: api.label + ' logs', words: await api.logs(pod.id) }); continue }
        if (action === 'tune' && record) {
          runpodOnly(api, 'Tune reload')
          const { runTune } = await import('./tune.js')
          const recipe = currentHostRecipes().find(row => row.id === record!.recipe)
          if (recipe) await runTune(modelTitle(recipe), { recipes: currentHostRecipes(), pod: record, runner, signal, pauseMs, timeoutMs: options.readyTimeoutMs }, question, emit)
          continue
        }
        if (action === 'resume') {
          if (api.capabilities.managed && api.resume && pod.status === 'EXITED') {
            const confirmed = await question({ step: 'hf-resume', title: 'Resume HF endpoint', found: pod.name, willRun: 'HF resumes compute billing at the current hardware rate. No new endpoint is created.', rows: [{ value: 'resume', label: 'Confirm resume' }, { value: 'cancel', label: words.cancel }] })
            if (confirmed !== 'resume') continue
            pod = await api.resume(pod.id)
          }
          if (record) {
            if (!options.startJob) await requireHostJobOwner()
            record = queueHostSetup({ ...record, status: pod.status })
            options.startJob?.(record)
          }
          continue
        }
        if (!['stop', 'terminate'].includes(action) || action === 'stop' && (pod.family || !api.capabilities.stop)) continue
        const confirm = await question({ step: 'pod-confirm', title: api.capabilities.managed ? action === 'stop' ? 'Pause HF endpoint' : 'Terminate HF endpoint' : action === 'stop' ? words.stopPod : words.terminatePod, found: pod.name + ' · ' + pod.id, willRun: api.capabilities.managed ? action === 'stop' ? 'Pause the endpoint and verify compute has stopped. No disk bills.' : 'Delete the HF endpoint and verify it is absent from the endpoint list.' : action === 'stop' ? words.stoppedDisk : pod.family ? 'Permanently delete this cluster, all ' + pod.family.compute.podCount + ' nodes and everything on their disks.' : pod.mounts?.network?.length || pod.mounts?.global?.length ? 'Delete this pod. Attached weights disks bill separately; choose keep or delete next.' : vendor === 'runpod' ? 'Permanently delete this pod and everything on its volume disk.' : 'Permanently delete this ' + api.label + ' instance and everything on its disk.', rows: [{ value: action, label: 'Confirm ' + action }, { value: 'cancel', label: words.cancel }] })
        if (confirm !== action || lifetimeSignal.aborted) continue
        const volumeId = keptDiskForPod(pod, record)
        const weightsChoice = action === 'terminate' ? await terminateVolumeChoice(volumeId, question, signal) : 'keep'
        if (!weightsChoice) continue
        if (record) { await stopHostSetup(pod.id); record = readHostRecord(pod.id) }
        const progress = (step: string): void => emit({ title: words.manage, words: pod!.id + ' · ' + step, host: { id: pod!.id, price: pod!.cost, startedAt: pod!.startedAt ?? pod!.createdAt, status: pod!.status, step } })
        const confirming = hostJobReadOnly({ label: api.label, pauseMs, timeoutMs: 4 * 60_000, signal, mark: progress })
        const plain = (error: unknown): string => { const text = error instanceof Error ? error.message : String(error); return key ? text.split(key).join('[redacted]') : text }
        if (action === 'terminate') {
          progress('terminating · waiting for ' + api.label + ' to drop it from the account list')
          try { await terminateHostResource(api, pod, confirming) } catch (error) {
            const detail = pod.id + ' · ' + plain(error) + (error instanceof HostTerminationUnconfirmed ? ' · it may still bill; Terminate again once ' + api.label + ' answers' : ' · it may still bill · /llmhost → Pods I’m paying for → Terminate again')
            emit({ title: words.manage, words: detail })
            saved = { ok: false, words: detail }
            continue
          }
          closeHostTunnel(pod.id)
          const { configuredCompatEndpoints } = await import('../providers/openaicompat/compatAccounts.js')
          const { removeLlmHostProvider } = await import('../llmHost/index.js')
          for (const endpoint of configuredCompatEndpoints()) {
            if (endpoint.hostPodId === pod.id || endpoint.name === record?.provider) removeLlmHostProvider(endpoint.name)
          }
          removeHostRecord(pod.id)
          if (weightsChoice === 'delete' && volumeId) {
            const vastApi = vastClient()
            try { if (readKeptVolume(volumeId)?.kind === 'vast' && vastApi) await deleteVastKeptVolume(vastApi, volumeId); else await deleteKeptVolume(runpodOnly(api, 'Fast-load weights disks'), volumeId) } catch (error) {
              const detail = words.terminatedPod + ' · weights disk ' + volumeId + ' deletion is not verified and it may still bill. Pods I’m paying for → Delete. ' + String(error)
              emit({ title: words.manage, words: detail, host: { id: pod.id, price: 0, startedAt: pod.createdAt, status: 'TERMINATED' } })
              return { ok: false, words: detail }
            }
          }
          const endedWords = api.capabilities.managed ? 'HF endpoint terminated · verified absent · no compute bills.' : words.terminatedPod
          emit({ title: words.manage, words: endedWords, host: { id: pod.id, managed: api.capabilities.managed, price: 0, startedAt: pod.createdAt, status: 'TERMINATED' } })
          return { ...(saved ?? { ok: true }), words: endedWords }
        }
        progress('stopping · waiting for ' + api.label + ' to report it stopped')
        try {
          await api.stop(pod.id)
          const deadline = Date.now() + 120_000
          while (Date.now() < deadline) { pod = await confirming('pod', readSignal => api!.get(pod!.id, readSignal)); if (pod.status === 'EXITED') break; await delay(pauseMs, undefined, { signal }) }
          if (pod.status !== 'EXITED') throw new Error('Stop requested but the pod has not stopped yet. It may still be billing compute.')
        } catch (error) {
          const detail = pod.id + ' · ' + plain(error) + ' · compute may still bill · /llmhost → Pods I’m paying for → Stop again or Terminate'
          emit({ title: words.manage, words: detail })
          saved = { ok: false, words: detail }
          continue
        }
        closeHostTunnel(pod.id)
        if (record) { record.status = pod.status; if (api.capabilities.managed) record.step = 'Paused · no compute bills'; writeHostRecord(record) }
      }
    }
    const adoptRented = async (rented: HostRecord): Promise<LlmHostResult> => {
      vendor = rented.vendor ?? 'runpod'
      if (!vendorKey(vendor)) return { ok: true, words: rented.id + ' · rented by the stock watch on ' + vendorLabel(vendor) + ' · /llmhost → Pods I’m paying for' }
      key = vendorKey(vendor); api = clientFor(vendor)
      pod = await getHostResource(api, rented.id, signal); record = rented
      return finish()
    }
    const cancelWatch = async (watchId: string): Promise<LlmHostResult> => {
      const rentedBy = (): HostRecord | undefined => hostRecords().find(row => row.watchedFrom === watchId)
      let rented = rentedBy()
      if (!rented) { await stopHostSetup(watchId); rented = rentedBy() }
      if (rented) {
        emit({ title: words.paid, words: 'The stock watch already rented ' + rented.id + ' · billing has started' })
        return adoptRented(rented)
      }
      const creating = readHostRecord(watchId)?.creating
      removeHostRecord(watchId)
      const ended = creating ? 'Stock watch cancelled while creating ' + creating + ' · that pod may exist: /llmhost → Pods I’m paying for' : 'Stock watch cancelled · no pod was created.'
      emit({ title: words.paid, words: ended })
      return { ok: !creating, words: ended }
    }
    const finishWatch = async (watchId: string): Promise<LlmHostResult> => {
      for (;;) {
        const rented = hostRecords().find(row => row.watchedFrom === watchId)
        if (rented) return adoptRented(rented)
        const watch = readHostRecord(watchId)
        if (!watch || watch.jobState === 'stopped' || watch.jobState === 'failed') return { ok: watch?.jobState !== 'failed', words: watch?.error ?? 'Stock watch ended · no pod was created.' }
        const markWatch = (current: HostRecord): void => emit({ title: words.manage, words: current.step ?? 'watching for stock ≤ ' + price(current.maxPrice ?? current.price), host: { id: current.id, price: current.maxPrice ?? current.price, startedAt: current.startedAt, status: 'WATCHING', step: current.step } })
        markWatch(watch)
        const refresh = setInterval(() => {
          const nextRented = hostRecords().find(row => row.watchedFrom === watchId)
          if (nextRented) { emit({ title: words.manage, words: 'Rented ' + nextRented.name + ' · setting up', host: { id: nextRented.id, price: nextRented.price, startedAt: nextRented.startedAt, status: nextRented.status, step: nextRented.step } }); return }
          const current = readHostRecord(watchId)
          if (current) markWatch(current)
        }, 1000)
        let action: string | null
        try {
          action = await question({ step: 'watch-controls', title: words.manage, found: watch.name + ' · ' + watch.id + ' · watching ≤ ' + price(watch.maxPrice ?? watch.price), willRun: watch.rateLimit ?? watchRateWords(watch.pollIntervalMs ?? 5000), rows: [{ value: 'cancel', label: 'Cancel · stop watching for stock' }, { value: 'close', label: 'Keep watching and close' }] })
        } finally { clearInterval(refresh) }
        const rentedAfter = hostRecords().find(row => row.watchedFrom === watchId)
        if (rentedAfter) return adoptRented(rentedAfter)
        if (!action || action === 'close') return { ok: true, words: watch.id + ' · watching for stock ≤ ' + price(watch.maxPrice ?? watch.price) + ' · /llmhost → Pods I’m paying for → Cancel' }
        if (action === 'cancel') return cancelWatch(watchId)
      }
    }
    const watchRoad = async (watchRecipe: HostRecipe, watchVendors: HostVendorId[], budget?: number): Promise<LlmHostResult | 'models'> => {
      const chosenModel = modelTitle(watchRecipe)
      const watching = activeWatches().find(row => watchModel(row) === chosenModel)
      if (watching) { emit({ title: words.paid, words: 'A stock watch for ' + chosenModel + ' is already running · ' + watching.id }); return finishWatch(watching.id) }
      const connected = watchVendors.filter(id => vendorKey(id))
      if (!connected.length) return { ok: false, words: 'No connected provider to watch. Connect one from the model screen first; nothing was rented.' }
      const shapes = connected.flatMap(id => clientFor(id).shapes().filter(row => modelTitle(row.recipe) === chosenModel).map(row => ({ vendor: id, row }))).sort((a, b) => a.row.price - b.row.price)
      const knownShape = shapes[0]
      const cataloguePrice = knownShape?.row.price
      const catalogueWords = cataloguePrice === undefined ? 'no catalogue price now' : 'catalogue ' + price(cataloguePrice) + (connected.length > 1 && knownShape ? ' at ' + vendorLabel(knownShape.vendor) : '')
      const providers = connected.map(vendorLabel).join(', ')
      let ceiling = cataloguePrice
      for (;;) {
        const ctx = (watchRecipe as HostRecipe & { contextPerSlot?: number }).contextPerSlot ?? watchRecipe.context
        const confirmWatch = await question({ step: 'rent-confirm', lines: hostPriceLines(watchRecipe, ceiling), title: words.rentalConfirm, found: watchRecipe.label + ' · ' + shape(watchRecipe) + ' · no stock now · ' + (ceiling === undefined ? catalogueWords + ' · set a price ceiling' : 'ceiling ' + price(ceiling) + ' (' + catalogueWords + ')' + (budget ? ' · ~' + (budget / ceiling).toFixed(1) + 'h for $' + budget : '')) + (connected.length > 1 ? ' · across ' + providers : ''), willRun: watchRecipe.verification + ' · ' + (ctx ? ctx.toLocaleString('en-US') + ' context · ' : '') + (watchRecipe.weightsGb ? hostStorageWords(watchRecipe, ceiling) + ' ' : watchRecipe.diskGb + ' GB disk (extra). ') + watchRateWords(options.pauseMs ?? 5000, undefined, connected) + '; stops after 12 hours or on Cancel.' + (connected.length > 1 ? ' The first provider with stock at or under the ceiling rents it (the cheapest when several answer at once); the others keep their own storage and key terms.' : ''), rows: [...(ceiling === undefined ? [] : [{ value: 'watch', label: words.watchConfirm + ' (' + price(ceiling) + ')' }]), { value: 'ceiling', label: cataloguePrice === undefined ? 'Set a price ceiling' : 'Set a lower price ceiling (catalogue ' + price(cataloguePrice) + ')' }, { value: 'models', label: 'Choose another model' }, { value: 'cancel', label: words.cancel }] })
        if (!confirmWatch || confirmWatch === 'cancel' || signal.aborted) return stopped()
        if (confirmWatch === 'models') return 'models'
        if (confirmWatch === 'ceiling') {
          const entered = await question({ step: 'watch-ceiling', title: 'Price ceiling in USD/hr', found: watchRecipe.label + ' · ' + shape(watchRecipe) + ' · ' + (cataloguePrice === undefined ? catalogueWords : 'last known catalogue price ' + price(cataloguePrice)), willRun: 'Rent only when a fitting shape has stock at or under this hourly price' + (watchRecipe.count > 1 ? ' for all ' + watchRecipe.count * (watchRecipe.nodes ?? 1) + ' GPUs' : '') + (connected.length > 1 ? ' at any of ' + providers : '') + '.', initial: ceiling?.toFixed(2) ?? '' })
          if (entered === null) return stopped()
          const next = entered.trim() ? Number(entered) : cataloguePrice
          if (next === undefined || !Number.isFinite(next) || next <= 0 || cataloguePrice !== undefined && cents(next) > cents(cataloguePrice)) { emit({ title: words.rentalConfirm, words: cataloguePrice === undefined ? 'Enter a positive hourly ceiling.' : 'Enter a positive hourly ceiling at or under ' + price(cataloguePrice) + '.' }); continue }
          ceiling = next
          continue
        }
        if (confirmWatch === 'watch' && ceiling !== undefined) {
          if (!options.startJob) await requireHostJobOwner()
          const needsSsh = connected.some(id => !clientFor(id).capabilities.managed)
          if (needsSsh) emit({ title: words.publicKey, words: '' })
          const sshKey = needsSsh ? await ensureHostKey(runner, signal) : undefined
          signal.throwIfAborted()
          const id = 'watch-' + randomUUID().slice(0, 12)
          record = queueHostWatch({ id, name: watchRecipe.label, recipe: watchRecipe.id, price: ceiling, maxPrice: ceiling, watchVendors: connected, ...(options.pauseMs ? { pollIntervalMs: options.pauseMs } : {}), startedAt: new Date().toISOString(), status: 'WATCHING', sessionId, workspace: process.cwd(), sshKey: sshKey?.path, ...(baseFor('runpod') ? { apiBaseUrl: baseFor('runpod') } : {}) })
          if (record.id !== id) emit({ title: words.paid, words: 'A stock watch for ' + chosenModel + ' is already running · ' + record.id })
          else options.startJob?.(record)
          return finishWatch(record.id)
        }
      }
    }
    try {
      const { runModelDoor, rentDoorVendor, isHostDoorReentry, initialDoorModel, modelTitle } = await import('./door.js')
      const { tuneBudget } = await import('./tune.js')
      const { listBoxes } = await import('./boxes.js')
      const { BOX_RECIPES } = await import('./boxRecipes.js')
      const sameModel = (a: string, b: string): boolean => a.replace(/[^a-z0-9]/gi, '').toLowerCase() === b.replace(/[^a-z0-9]/gi, '').toLowerCase()
      if (!isHostDoorReentry(ask)) return await runModelDoor(question, emit, signal, {
        initialModel: initialDoorModel(ask),
        offers: () => vendorKey('runpod') ? clientFor('runpod').offers(signal) : Promise.resolve(undefined),
        pods: async () => {
          const pods = await paidPods()
          if (listsComplete && hostRecords().every(row => vendorKey(row.vendor ?? 'runpod'))) for (const line of await forgetEndedPods(pods)) emit({ title: words.paid, words: line })
          return pods
        },
        podErrors: () => listErrors,
        get vendors() { return HOST_VENDORS.filter(id => id !== 'runpod' && vendorKey(id)).map(clientFor) },
        connectVendor: connect,
        confirmRental: question,
        rentVendor: (client, offer, rentAsk, rentEmit, rentSignal) => rentDoorVendor(createHostRoad({ ...options, rental: { client: clientFor(client.vendor as HostVendorId), offer } }), client, offer, rentAsk, rentEmit, rentSignal),
        records: hostRecords,
        road: createHostRoad(options),
        boxes: () => listBoxes().map(box => ({ name: box.name, kind: box.kind, os: box.os, memoryGb: box.memoryGb, unifiedMemory: box.unifiedMemory, engines: box.engines.map(engine => ({ kind: engine.kind, version: engine.version, port: engine.port })), models: currentHostRecipes().filter(recipe => BOX_RECIPES.some(row => sameModel(row.label.split(' · ')[0]!, modelTitle(recipe)))).map(modelTitle) })),
        startBox: (box, recipe, boxAsk, boxEmit, boxSignal) => {
          const boxRecipe = BOX_RECIPES.find(row => sameModel(row.label.split(' · ')[0]!, modelTitle(recipe)))
          if (!boxRecipe) return Promise.resolve({ ok: false, words: modelTitle(recipe) + ' has no local recipe. Nothing was started.' })
          const preset: Record<string, string | undefined> = { boxes: box.name, 'box-controls': 'model', 'box-recipes': boxRecipe.id }
          return createBoxRoad(runner)(plan => { const answer = preset[plan.step]; if (answer !== undefined && (!plan.rows || plan.rows.some(row => row.value === answer))) { delete preset[plan.step]; return Promise.resolve(answer) } return boxAsk(plan) }, boxEmit, boxSignal)
        },
        budgetLines: (recipe, gpuMemoryGb) => { const budget = tuneBudget(recipe, gpuMemoryGb / Math.max(1, recipe.count), recipe.count); return [budget.words, ...budget.candidates.filter(row => row.fits).slice(0, 4).map(row => row.label)] },
        connect: () => connect('runpod'),
        watch: async recipe => { const watched = await watchRoad(recipe, HOST_VENDORS.filter(id => vendorKey(id))); return watched === 'models' ? undefined : watched },
        bank: async (action, recipe) => {
          const bankOptions = bankOptionsFor()
          if (action === 'open') return bankDoor(question, emit, signal, bankOptions)
          const folder = await ensureBankFolder(question)
          return folder ? bankAction(recipe, action, folder, question, emit, signal, bankOptions) : undefined
        },
      })
      let pods = await paidPods()
      if (listsComplete && hostRecords().every(row => vendorKey(row.vendor ?? 'runpod'))) for (const line of await forgetEndedPods(pods)) emit({ title: words.paid, words: line })
      let volumes: Awaited<ReturnType<RunpodClient['volumes']>> = []
      let volumeListError = ''
      if (vendorKey('runpod')) try { volumes = await reconcileVolumes(runpodOnly(clientFor('runpod'), 'Fast-load weights disks'), signal) } catch (error) { volumeListError = ' + volumes unread'; emit({ title: words.paid, words: 'Volume list unavailable; billed count is incomplete. ' + String(error) }) }
      let vastVolumes = vastClient() ? await vastVolumeRows() : []
      const watches = activeWatches()
      const door = await question({ step: 'where', title: words.where, found: 'Choose where the model runs. No GPU is rented without a separate price confirmation.', willRun: '', rows: [{ value: 'rent', label: words.rent }, { value: 'ssh', label: words.ssh }, { value: 'existing', label: words.existing }, { value: 'boxes', label: 'One of my computers' }, { value: 'fast-load', label: BANK_DOOR }, ...(HOST_VENDORS.some(id => vendorKey(id)) ? [{ value: 'pods', label: words.paid + ' · ' + (pods.length + watches.length + volumes.length + vastVolumes.length) + volumeListError }] : []), ...watches.map(row => ({ value: 'watch:' + row.id, label: row.name + ' · ' + row.id + ' · WATCHING ≤ ' + price(row.maxPrice ?? row.price) + ' · Cancel' })), ...pods.map(row => ({ value: 'pod:' + paidValue(row), label: paidWords(row) }))] })
      if (!door) return stopped()
      if (door === 'existing') return runLlmHost(ask, emit, signal)
      if (door === 'boxes') return createBoxRoad(runner)(ask, emit, signal)
      if (door === 'fast-load') return bankDoor(question, emit, signal, bankOptionsFor())
      let target: SshTarget
      let recipe: HostRecipe
      let docker = false
      let bank: string | undefined
      if (door === 'rent' || door === 'pods' || door.startsWith('pod:') || door.startsWith('watch:')) {
        if (door === 'rent') {
          const selected = await question({ step: 'rental-vendor', title: 'Rent from which vendor?', found: 'Each vendor has its own key, stock and billing. No rental starts before the price confirmation.', willRun: 'Clusters and fast-load weights disks are Runpod-only.', rows: HOST_VENDORS.map(id => ({ value: id, label: vendorLabel(id) + (vendorKey(id) ? ' · connected' : ' · connect →') })) })
          if (!selected || !HOST_VENDORS.includes(selected as HostVendorId)) return stopped()
          vendor = selected as HostVendorId
        }
        if (door === 'rent') {
          if (!vendorKey(vendor) && !await connect(vendor)) return stopped()
          key = vendorKey(vendor); api = clientFor(vendor)
        }
        if (door === 'pods' || door.startsWith('pod:') || door.startsWith('watch:')) {
          if (door.startsWith('watch:')) return cancelWatch(door.slice(6))
          pods = await paidPods()
          volumes = vendorKey('runpod') ? await reconcileVolumes(runpodOnly(clientFor('runpod'), 'Fast-load weights disks'), signal).catch(error => { emit({ title: words.paid, words: 'Volume list unavailable; weights disks are not shown and may still bill. ' + String(error) }); return [] }) : []
          vastVolumes = vastClient() ? await vastVolumeRows() : []
          const liveWatches = activeWatches()
          const id = door.startsWith('pod:') ? door.slice(4) : await question({ step: 'paid-pods', title: words.paid, found: 'Live account list, including pods created outside Mercury, volumes and stock watches. Disks bill without a pod; external volumes are read-only.' + (vastVolumes.length ? ' A Vast.ai volume bills per GB-month on its one machine; d deletes it (verified), w watches stock on that machine.' : ''), willRun: listErrors.join(' · '), keys: vastVolumes.length ? [{ key: 'd', value: 'delete', label: 'delete' }, { key: 'w', value: 'watch', label: 'watch stock' }] : undefined, rows: [...volumes.map(row => ({ value: 'volume:' + row.id, label: volumeLabel(row) })), ...vastVolumes, ...liveWatches.map(row => ({ value: 'watch:' + row.id, label: row.name + ' · ' + row.id + ' · WATCHING ≤ ' + price(row.maxPrice ?? row.price) + ' · Cancel' })), ...pods.map(row => ({ value: paidValue(row), label: paidWords(row) }))] })
          if (!id) return stopped()
          if (id.startsWith('volume:') || id.startsWith('delete:volume:')) return volumeDeleteDoor(runpodOnly(clientFor('runpod'), 'Fast-load weights disks'), id.slice(id.indexOf('volume:') + 7), question, signal)
          if (id.startsWith('vastvolume:') || id.startsWith('delete:vastvolume:')) { const client = vastClient(); if (!client) return stopped(); return vastVolumeDeleteDoor(client, id.slice(id.indexOf('vastvolume:') + 11), question, signal, emit) }
          if (id.startsWith('watch:vastvolume:')) {
            const kept = readKeptVolume(id.slice(17))
            if (!kept?.recipeRow) return { ok: false, words: 'That volume no longer names a recipe; nothing was started.' }
            const watched = await watchRoad(kept.recipeRow, ['vast'])
            return watched === 'models' ? stopped() : watched
          }
          if (id.startsWith('delete:') || id.startsWith('watch:') && !activeWatches().some(row => 'watch:' + row.id === id)) return stopped()
          if (id.startsWith('watch:')) { api = clientFor('runpod'); return cancelWatch(id.slice(6)) }
          const selected = pods.find(row => paidValue(row) === id)
          if (!selected) throw new Error('That machine could not be read. Refresh the paid-pods list before changing it.')
          vendor = selected.vendor; key = vendorKey(vendor); api = clientFor(vendor)
          pod = await getHostResource(api, selected.id, signal, selected.family)
          record = readHostRecord(selected.id)
          return finish()
        }
        api ??= clientFor(vendor)
        const stockWords = vendor === 'runpod' ? words.offersHelp : 'Live ' + api.label + ' stock and hourly prices for the whole shape. ' + vendorStorage(vendor)
        const budgetText = await question({ step: 'budget', title: words.budget, found: words.budgetHelp, willRun: 'An estimate, not a spending cap. GPU billing starts at creation; storage is additional.' })
        if (budgetText === null) return stopped()
        const budget = budgetText.trim() ? Number(budgetText) : undefined
        if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) throw new Error('Enter a positive budget, or leave it blank.')
        let offer: HostOffer | undefined
        let chosenModel: string | undefined
        let forceShapeList = false
        for (;;) {
          const offers = (await api.offers(signal)).filter(offer => vendor !== 'runpod' || volumeFitsOffer(offer))
          const clusterFailure = vendor === 'runpod' ? runpodOnly(api, 'Clusters').clusterReadError() : undefined
          if (api.offersNote()) emit({ title: api.label, words: api.offersNote() })
          if (clusterFailure) emit({ title: words.offers, words: 'Cluster stock could not be read, so multi-node shapes are not offered this time · ' + clusterFailure })
          if (!chosenModel) {
            const table = currentHostRecipes()
            const modelGroups = [...new Set(table.map(modelTitle))].map(name => {
              const recipes = table.filter(row => modelTitle(row) === name).sort((a, b) => verifiedRank(a) - verifiedRank(b) || a.id.localeCompare(b.id))
              const modelOffers = offers.filter(row => modelTitle(row.recipe) === name)
              const cheapest = [...modelOffers].sort((a, b) => a.price - b.price || stockRank(b.availability) - stockRank(a.availability))[0]
              const variants = [...new Set(recipes.map(row => row.label.split(' · ').slice(1).join(' · ')).filter(Boolean))].join(' / ')
              const lead = cheapest?.recipe ?? recipes[0]!
              const summary = [variants, lead.verification.split(' · ')[0]].filter(Boolean).join(' · ')
              const stockText = cheapest ? (heavyWeights(lead) ? shape(lead) + ' · ' : '') + price(cheapest.price) + (budget ? ' · ~' + (budget / cheapest.price).toFixed(1) + 'h for $' + budget : '') : 'no stock now'
              return { name, recipes, modelOffers, cheapest, label: name + ' · ' + summary + ' · ' + stockText + (heavyWeights(lead) ? ' · ' + hostShortStorageWords(lead) : '') }
            }).sort((a, b) => Number(!a.cheapest) - Number(!b.cheapest) || (a.cheapest?.price ?? 0) - (b.cheapest?.price ?? 0))
            const cheapestModel = modelGroups[0]?.cheapest ? modelGroups[0].name : undefined
            const selectedModel = await question({ step: 'models', title: vendor === 'runpod' ? words.offers : 'Choose a model · live ' + api.label + ' stock', found: offers.length ? stockWords : vendor === 'runpod' ? words.noStock : 'No documented shape has stock right now. Refresh or choose another vendor.', willRun: '', initial: cheapestModel, rows: [...modelGroups.map(group => ({ value: group.name, label: group.label })), { value: 'refresh', label: 'Refresh stock and prices' }, { value: 'cancel', label: words.cancel }] })
            if (!selectedModel || selectedModel === 'cancel') return stopped()
            if (selectedModel === 'refresh') continue
            if (!modelGroups.some(group => group.name === selectedModel)) throw new Error(words.inputError)
            chosenModel = selectedModel
            forceShapeList = false
          }
          const modelOffers = offers.filter(row => modelTitle(row.recipe) === chosenModel)
          if (modelOffers.length === 0 && vendor !== 'runpod') {
            const next = await question({ step: 'vendor-no-stock', title: api.label + ' · no stock', found: chosenModel + ' has no in-stock offer from ' + api.label + '.', willRun: 'Watch stock from the model screen (/llmhost → the model → Watch stock) to be told when any connected provider has it. Nothing was rented.', rows: [{ value: 'refresh', label: 'Refresh stock' }, { value: 'models', label: 'Choose another model' }, { value: 'cancel', label: words.cancel }] })
            if (!next || next === 'cancel') return stopped()
            if (next === 'models') chosenModel = undefined
            continue
          }
          if (modelOffers.length === 0 && !forceShapeList) {
            const modelRecipes = currentHostRecipes().filter(row => modelTitle(row) === chosenModel)
            const knownShape = api.shapes().filter(row => modelTitle(row.recipe) === chosenModel).sort((a, b) => a.price - b.price)[0]
            const watched = await watchRoad(knownShape?.recipe ?? modelRecipes[0]!, [vendor], budget)
            if (watched !== 'models') return watched
            chosenModel = undefined
            continue
          }
          if (selectedRental) {
            offer = modelOffers.find(row => row.recipe.id === selectedRental!.recipe.id && row.gpuId === selectedRental!.gpuId && row.dataCenter === selectedRental!.dataCenter && row.hostingType === selectedRental!.hostingType && row.price === selectedRental!.price)
            if (!offer) throw new Error('That offer changed. Open the model again for fresh stock and prices; no pod was created.')
            selectedRental = undefined
          } else if (modelOffers.length === 1 && !forceShapeList) {
            offer = modelOffers[0]!
          } else {
            const selectedShape = await question({ step: 'offers', title: vendor === 'runpod' ? words.shapes : 'Choose a GPU shape · live ' + api.label + ' stock', found: chosenModel + ' · ' + (modelOffers.length ? stockWords : 'no stock now'), willRun: '', initial: modelOffers.length ? '0' : undefined, rows: [...modelOffers.map((row, index) => ({ value: String(index), label: formatHostOfferLabel(row.recipe, shape(row.recipe) + ' · ' + price(row.price) + (heavyWeights(row.recipe) ? ' · ' + hostShortStorageWords(row.recipe) : '') + ' · ' + (vendor === 'runpod' ? 'Secure Cloud' : api!.label) + (row.dataCenter ? ' · ' + row.dataCenter : '') + (row.hostingType ? ' · ' + row.hostingType : '') + (budget ? ' · ~' + (budget / row.price).toFixed(1) + 'h for $' + budget : '') + (row.machineId ? ' · machine ' + row.machineId + (vastKeptVolumes().some(volume => volume.state === 'kept' && volume.machineId === row.machineId && volume.model === row.recipe.model && volume.include === (row.recipe.include ?? '')) ? ' · boots from your volume' : '') : '')) })), ...(modelOffers.length === 0 ? [{ value: 'watch', label: words.watchConfirm }] : []), { value: 'models', label: 'Choose another model' }, { value: 'refresh', label: 'Refresh stock and prices' }, { value: 'cancel', label: words.cancel }] })
            if (!selectedShape || selectedShape === 'cancel') return stopped()
            if (selectedShape === 'models') { chosenModel = undefined; forceShapeList = false; continue }
            if (selectedShape === 'refresh') continue
            if (selectedShape === 'watch') { forceShapeList = false; continue }
            offer = modelOffers[Number(selectedShape)]
            if (!offer) throw new Error(words.inputError)
          }
          const ctx = offer.recipe.contextPerSlot ?? offer.recipe.context
          emit({ title: 'Rental details', words: offer.recipe.verification + (ctx ? ' · ' + ctx.toLocaleString('en-US') + ' context' : '') + ' · billing starts on creation' })
          const { confirmTunedRental } = await import('./tune.js')
          const client = api
          offer = await confirmTunedRental(offer, offers, budget, question, emit, signal, async row => {
            if (client.capabilities.managed) return { willRun: vendorKeyNotice(vendor) + '. Billing starts now. If initial setup fails, Mercury deletes the endpoint and verifies it is gone.', lines: [vendorLabel(vendor) + ' · ' + price(row.price) + ' · API only — not yet booted', vendorStorage(vendor)], confirmLabel: 'Confirm ' + price(row.price) + ' · create this HF endpoint' }
            if (vendor === 'vast' && client instanceof VastClient) {
              const mount = await vastRentalVolume(client, row.recipe, row, signal)
              const kept = mount ? readKeptVolume(mount.id) : undefined
              if (kept?.state === 'kept') return { titleSuffix: ' · weights kept on this machine', willRun: 'Boots from your Vast.ai volume ' + kept.id + ' on machine ' + kept.machineId + ': the download is skipped and the engine’s compiled kernels are read from the volume, ~' + vastBootMinutes(row.recipe, kept) + ' min total · the volume bills ' + vastVolumeBilling(kept) + ' · ' + vendorStorage(vendor) + ' ' + vendorKeyNotice(vendor) + ' Billing starts now. If initial setup fails, Mercury terminates the instance and verifies it is gone; the volume stays.', lines: [vendorLabel(vendor) + ' · ' + price(row.price) + ' · machine ' + kept.machineId + ' · weights kept on this machine', 'volume ' + kept.id + ' · ' + vastVolumeBilling(kept), vendorStorage(vendor)], confirmLabel: 'Confirm ' + price(row.price) + ' + volume $' + kept.price.toFixed(2) + '/month (bills with or without an instance) · create this instance' }
              if (kept) return { titleSuffix: ' · fills your volume', willRun: hostSetupEstimate(row.recipe) + ' · this instance downloads the weights onto your Vast.ai volume ' + kept.id + ' on machine ' + kept.machineId + ' and verifies them there; later rentals on that machine skip the download · the volume bills ' + vastVolumeBilling(kept) + ' · ' + vendorStorage(vendor) + ' ' + vendorKeyNotice(vendor) + ' Billing starts now. If initial setup fails, Mercury terminates the instance and verifies it is gone; the volume stays.', lines: [vendorLabel(vendor) + ' · ' + price(row.price) + ' · machine ' + kept.machineId, 'volume ' + kept.id + ' · ' + vastVolumeBilling(kept), vendorStorage(vendor)], confirmLabel: 'Confirm ' + price(row.price) + ' + volume $' + kept.price.toFixed(2) + '/month · create this instance' }
              const elsewhere = vastKeptVolumes().find(volume => volume.state === 'kept' && volume.model === row.recipe.model && volume.include === (row.recipe.include ?? ''))
              if (elsewhere) return { titleSuffix: ' · downloads', willRun: hostSetupEstimate(row.recipe) + ' · your Vast.ai volume ' + elsewhere.id + ' lives on machine ' + elsewhere.machineId + ', not this one (' + (row.machineId ?? 'machine unknown') + '), so this instance downloads the weights · ' + vendorStorage(vendor) + ' ' + vendorKeyNotice(vendor) + ' Billing starts now. If initial setup fails, Mercury terminates the instance and verifies it is gone.', lines: [vendorLabel(vendor) + ' · ' + price(row.price) + (row.machineId ? ' · machine ' + row.machineId : '') + ' · downloads the weights', vendorStorage(vendor)], confirmLabel: 'Confirm ' + price(row.price) + ' · create this instance' }
            }
            if (vendor !== 'runpod') return { willRun: hostSetupEstimate(row.recipe) + ' · ' + vendorStorage(vendor) + ' ' + vendorKeyNotice(vendor) + ' Billing starts now. If initial setup fails, Mercury terminates the instance and verifies it is gone.', lines: [vendorLabel(vendor) + ' · ' + price(row.price), vendorStorage(vendor)], confirmLabel: 'Confirm ' + price(row.price) + ' · create this pod' }
            const kept = await rentalVolume(runpodOnly(client, 'Fast-load weights disks'), row.recipe, signal)
            return {
              titleSuffix: kept?.state === 'kept' ? ' · weights kept' : ' · cold rental',
              willRun: fastLoadEstimate(row.recipe, kept) + (heavyWeights(row.recipe) ? '' : ' · ' + hostStorageWords(row.recipe, row.price)) + (kept ? '' : ' Disk rate not supplied by catalogue.') + ' Closing this window does not stop it. Mercury tells you when it’s ready. Weights at https://huggingface.co/' + row.recipe.model,
              lines: hostPriceLines(row.recipe, row.price),
              confirmLabel: 'Confirm ' + price(row.price) + (kept ? ' + ' + volumePrice(kept) + ' disk (bills without a pod)' : ' + storage') + ' · create this ' + hostResourceKind(row.recipe),
            }
          })
          if (!offer) return stopped()
          const volume: KeptVolume | undefined = vendor === 'runpod' ? await rentalVolume(runpodOnly(api, 'Fast-load weights disks'), offer.recipe, signal) : vendor === 'vast' && api instanceof VastClient ? await vastRentalVolume(api, offer.recipe, offer, signal).then(mount => mount ? readKeptVolume(mount.id) : undefined) : undefined
          if (!options.startJob) await requireHostJobOwner()
          recipe = offer.recipe
          emit({ title: api.capabilities.managed ? 'HF endpoint' : words.publicKey, words: vendorKeyNotice(vendor) })
          const sshKey = api.capabilities.managed ? undefined : await ensureHostKey(runner, signal)
          signal.throwIfAborted()
          pendingName = 'mercury-' + randomUUID().slice(0, 12)
          emit({ title: api.capabilities.managed ? 'Creating the HF endpoint' : words.creating, words: pendingName + ' · ' + price(offer.price) + (api.capabilities.managed ? '' : ' + storage') + ' · closing does not cancel billing' })
          try {
            pod = await createHostResource(api, offer, sshKey?.publicKey ?? '', pendingName, volume)
          } catch (error) {
            const refusal = hostCreateRefusal(offer.recipe, error)
            if (!refusal) throw error
            pendingName = ''
            if (signal.aborted || ![400, 410].includes(refusal.status ?? 0)) throw error
            selectedRental = undefined
            emit({ title: words.creating, words: api.label + ' could not place ' + shape(offer.recipe) + (offer.dataCenter ? ' in ' + offer.dataCenter : '') + ' · no ' + hostResourceKind(offer.recipe) + ' was created' + (refusal.detail ? ' · ' + refusal.detail : '') })
            forceShapeList = true
            continue
          }
          record = queueHostSetup({ ...hostClusterRecord(pod), vendor, id: pod.id, name: pod.name, recipe: recipe.id, ...(api.capabilities.managed ? { recipeRow: recipe } : {}), volumeId: volume?.id, price: offer.price, startedAt: pod.startedAt ?? pod.createdAt, status: pod.status, sessionId, workspace: process.cwd(), sshKey: sshKey?.path, ...(baseFor(vendor) ? { apiBaseUrl: baseFor(vendor) } : {}) })
          break
        }
        options.startJob?.(record)
        mark()
        return finish()
      } else if (door === 'ssh') {
        const host = await question({ step: 'ssh-host', title: words.sshHost, found: sshAliases().join(' · ') || 'Use an existing SSH config alias, or a host name.', willRun: 'Read nvidia-smi through SSH; no model starts yet.' })
        if (!host) return stopped()
        const user = await question({ step: 'ssh-user', title: words.sshUser, found: host, willRun: '' }); if (user === null) return stopped()
        const port = await question({ step: 'ssh-port', title: words.sshPort, found: host, willRun: '' }); if (port === null) return stopped()
        const path = await question({ step: 'ssh-key', title: words.sshKey, found: host, willRun: '' }); if (path === null) return stopped()
        target = { host: host.trim(), ...(user.trim() ? { user: user.trim() } : {}), ...(port.trim() ? { port: Number(port) } : {}), key: localKeyPath(path.trim()) }
        const hardware = await inspectSsh(target, runner, signal)
        docker = hardware.docker
        const fits = currentHostRecipes().filter(row => fitsSsh(row, hardware.gpus) && (docker || Boolean(row.pythonInstall)))
        const selected = await question({ step: 'ssh-recipe', title: 'Recipes that fit this SSH box', found: hardware.gpus.map(gpu => gpu.name + ' ' + gpu.memory + ' GB').join(' · '), willRun: fits.length ? 'Choose a documented recipe.' : 'No documented recipe fits these GPUs and this engine installation.', rows: fits.map(row => ({ value: row.id, label: row.label + ' · ' + shape(row) + ' · ' + row.verification })) })
        if (!selected) return stopped()
        recipe = fits.find(row => row.id === selected)!
        if (!recipe) throw new Error(words.inputError)
        const folder = await question({ step: 'ssh-bank', title: words.sshBank, found: recipe.model, willRun: 'Use the selected model’s complete folder, or download its weights to /workspace.' }); if (folder === null) return stopped()
        bank = folder.trim() || undefined
        const confirm = await question({ step: 'ssh-confirm', title: words.sshConfirm, found: target.host + ' · ' + recipe.label + ' · ' + recipe.verification, willRun: 'Use /workspace (' + recipe.diskGb + ' GB free), setsid and curl. ' + (docker ? 'Run the recipe image using Docker.' : 'Install SGLang in an isolated Python environment.'), rows: [{ value: 'start', label: 'Start the engine and open a private tunnel' }, { value: 'cancel', label: words.cancel }] })
        if (confirm !== 'start' || signal.aborted) return stopped()
      } else throw new Error(words.inputError)
      emit({ title: words.engine, words: recipe.model + ' · ' + recipe.source })
      await startHostEngine(target, recipe, runner, signal, docker, Boolean(pod), bank)
      emit({ title: words.health, words: 'Model download and loading may take 20–90 min. Escape stops waiting, not the remote engine.' })
      await waitHostEngine(target, recipe, runner, signal, pauseMs, timeoutMs)
      emit({ title: words.tunnel, words: target.host + ' · engine stays on the remote loopback interface' })
      const localPort = await openHostTunnel(pod?.id ?? target.host, target, runner, signal)
      if (record) { record.localPort = localPort; record.status = 'RUNNING'; writeHostRecord(record) }
      saved = await runLlmHost(plan => plan.step === 'servers' ? Promise.resolve('__add__') : plan.step === 'address' ? Promise.resolve('http://127.0.0.1:' + localPort + '/v1') : plan.step === 'dialect' ? Promise.resolve(recipe.engine ?? 'sglang') : plan.step === 'key' && plan.found === words.keyOptional ? Promise.resolve('') : question(plan), emit, signal)
      if (record && saved.registered && saved.model) { record.provider = compatModelEndpoint(saved.model)?.endpoint.name; writeHostRecord(record) }
      emit({ title: words.done, words: saved.words })
      if (pod) return finish()
      return { ...saved, words: saved.words + ' · SSH engine keeps running; /workspace/mercury-host/' + recipe.id + '/engine.log on ' + target.host }
    } catch (error) {
      const detail = key ? String(error).split(key).join('[redacted]') : String(error)
      if (pod) { saved = { ok: false, words: detail }; mark(); emit({ title: words.manage, words: detail }); if (!lifetimeSignal.aborted) return finish() }
      return { ok: false, words: (signal.aborted ? stopped().words : pod ? detail + ' · ' + keepWords(pod, vendor) : pendingName ? pendingName + ' may exist; check Pods I’m paying for before retrying · ' + detail : detail) }
    }
  }
}

export const runHostedModel = createHostRoad()
