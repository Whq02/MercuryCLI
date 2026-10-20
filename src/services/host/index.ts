import { randomUUID } from 'node:crypto'
import { createBoxRoad } from './boxRoad.js'
import { setTimeout as delay } from 'node:timers/promises'
import { LLM_HOST_WORDS as words } from '../../commands/llmhost/words.js'
import { runLlmHost, type LlmHostRoad, type LlmHostResult } from '../llmHost/index.js'
import { readStoredRunpodApiKey, writeStoredRunpodApiKey } from '../providers/providerSecrets.js'
import { formatHostOfferLabel, hostRecipeVerificationWord, prebuiltEngine, type HostRecipe } from './recipes.js'
import { currentHostRecipes } from './recipesFile.js'
import { compatModelEndpoint } from '../providers/openaicompat/compatAccounts.js'
import { createHostResource, getHostResource, listHostResources, terminateHostResource, hostClusterRecord, hostCreateRefusal, hostResourceKind, hostResourceLabel, hostShape } from './cluster.js'
import { heavyWeights, hostPriceLines, hostStorageWords } from './costs.js'
import { RunpodClient, cents, createRefusal, type HostOffer, type HostPod } from './runpod.js'
import { closeHostTunnel, ensureHostKey, fitsSsh, hostRunner, inspectSsh, localKeyPath, openHostTunnel, sshAliases, sshArguments, startHostEngine, waitHostEngine, type HostRunner, type SshTarget } from './ssh.js'
import { hostRecords, readHostRecord, removeHostRecord, writeHostRecord, type HostRecord } from './store.js'
import { activeHostWatches as activeWatches, hostJobRunning, hostLogTail, queueHostSetup, queueHostWatch, requireHostJobOwner, stopHostSetup, watchModel, watchRateWords } from './jobs.js'
import { getFocusedSessionConnector } from '../engine-connector/focusedConnector.js'
import { getSessionId } from '../../bootstrap/state.js'
import { FAST_LOAD_DOOR, fastLoadDoor, keptDiskForPod, terminateVolumeChoice, volumeDeleteDoor, volumeFitsOffer } from './fastLoad.js'
import { deleteKeptVolume, fastLoadEstimate, rentalVolume, reconcileVolumes, volumeLabel, volumePrice } from './volumes.js'

type HostOptions = { apiBaseUrl?: string; runner?: HostRunner; pauseMs?: number; readyTimeoutMs?: number; startJob?: (record: HostRecord) => void; sessionId?: string }
const price = (amount: number): string => '$' + amount.toFixed(2) + '/hr'
const shape = hostShape
const modelTitle = (recipe: HostRecipe): string => recipe.label.split(' · ')[0]!
const stockRank = (value?: string): number => value === 'HIGH' ? 3 : value === 'MEDIUM' ? 2 : value === 'LOW' ? 1 : 0
const verifiedRank = (recipe: HostRecipe): number => ['measured', 'documented', 'community', 'unverified'].indexOf(hostRecipeVerificationWord(recipe))
const keepWords = (pod: HostPod): string => pod.id + ' · ' + (pod.family ? 'cluster still billable · /llmhost → Pods I’m paying for → Terminate' : pod.status === 'EXITED' ? words.stoppedDisk : 'pod still running · /llmhost → Pods I’m paying for → Stop or Terminate')

export function createHostRoad(options: HostOptions = {}): LlmHostRoad {
  return async (ask, emit, lifetimeSignal) => {
    const signal = lifetimeSignal
    const sessionId = options.sessionId ?? (getFocusedSessionConnector().sessionId() || getSessionId())
    const runner = options.runner ?? hostRunner
    const pauseMs = options.pauseMs ?? 5000
    const timeoutMs = options.readyTimeoutMs ?? 90 * 60_000
    let key = readStoredRunpodApiKey()
    let api: RunpodClient | undefined
    let pod: HostPod | undefined
    let record: HostRecord | undefined
    let saved: LlmHostResult | undefined
    let pendingName = ''
    const stopped = (): LlmHostResult => ({ ok: false, words: pod ? keepWords(pod) : pendingName ? pendingName + ' · creation may still be running. /llmhost → Pods I’m paying for; no retry was sent.' : words.stopped })
    const question: Parameters<LlmHostRoad>[0] = plan => lifetimeSignal.aborted ? Promise.resolve(null) : ask(plan)
    const mark = (): void => {
      if (!pod) return
      emit({ title: words.manage, words: [record?.weightsCheck, record?.step, record?.error, record ? hostLogTail(record) : ''].filter(Boolean).join(' · ') || keepWords(pod), host: { id: pod.id, price: pod.cost, startedAt: pod.startedAt ?? pod.createdAt, status: record?.status ?? pod.status, canResume: Boolean(record && !hostJobRunning(record) && record.status === 'RUNNING'), step: record?.step === 'building llama.cpp' ? record.step + ' ' + Math.floor((Date.now() - (record.advancedAt ?? Date.now())) / 60_000) + ' min' : record?.step } })
    }
    const finish = async (): Promise<LlmHostResult> => {
      if (!pod || !api) return saved ?? stopped()
      for (;;) {
        record = readHostRecord(pod.id)
        if (record?.retuning) { const { reconcileHostTune } = await import('./tune.js'); record = await reconcileHostTune(pod.id, runner, signal) }
        mark()
        const refresh = setInterval(() => { if (pod) { record = readHostRecord(pod.id); mark() } }, 1000)
        let action: string | null
        try { action = await question({ step: 'pod-controls', title: words.manage, found: pod.name + ' · ' + pod.id + ' · ' + price(pod.cost), willRun: pod.family ? 'Cluster nodes and disks bill until termination; Runpod has no cluster Stop action.' : words.rentalStorage, rows: [...(record?.provider && record.target && pod.status === 'RUNNING' && !pod.family ? [{ value: 'tune', label: 'Tune · quality, conversations × context, thinking' }] : []), ...(record && !hostJobRunning(record) && pod.status === 'RUNNING' ? [{ value: 'resume', label: 'Resume setup' }] : []), ...(pod.family || pod.status === 'EXITED' ? [] : [{ value: 'stop', label: words.stopPod }]), { value: 'terminate', label: words.terminatePod }, { value: 'close', label: pod.status === 'EXITED' ? words.closePod : words.keepPod }] }) } finally { clearInterval(refresh) }
        if (!action || action === 'close') return { ...(saved ?? { ok: true }), words: keepWords(pod) }
        if (action === 'tune' && record) {
          const { runTune } = await import('./tune.js')
          const recipe = currentHostRecipes().find(row => row.id === record!.recipe)
          if (recipe) await runTune(modelTitle(recipe), { recipes: currentHostRecipes(), pod: record, runner, signal, pauseMs, timeoutMs: options.readyTimeoutMs }, question, emit)
          continue
        }
        if (action === 'resume' && record) {
          if (!options.startJob) await requireHostJobOwner()
          record = queueHostSetup(record)
          options.startJob?.(record)
          continue
        }
        if (!['stop', 'terminate'].includes(action) || action === 'stop' && pod.family) continue
        const confirm = await question({ step: 'pod-confirm', title: action === 'stop' ? words.stopPod : words.terminatePod, found: pod.name + ' · ' + pod.id, willRun: action === 'stop' ? words.stoppedDisk : pod.family ? 'Permanently delete this cluster, all ' + pod.family.compute.podCount + ' nodes and everything on their disks.' : pod.mounts?.network?.length || pod.mounts?.global?.length ? 'Delete this pod. Attached weights disks bill separately; choose keep or delete next.' : 'Permanently delete this pod and everything on its volume disk.', rows: [{ value: action, label: 'Confirm ' + action }, { value: 'cancel', label: words.cancel }] })
        if (confirm !== action || lifetimeSignal.aborted) continue
        const volumeId = keptDiskForPod(pod, record)
        const weightsChoice = action === 'terminate' ? await terminateVolumeChoice(volumeId, question, signal) : 'keep'
        if (!weightsChoice) continue
        if (record) { await stopHostSetup(pod.id); record = readHostRecord(pod.id) }
        if (action === 'terminate') {
          await terminateHostResource(api, pod)
          closeHostTunnel(pod.id)
          removeHostRecord(pod.id)
          if (weightsChoice === 'delete' && volumeId) {
            try { await deleteKeptVolume(api, volumeId) } catch (error) {
              const detail = words.terminatedPod + ' · weights disk ' + volumeId + ' deletion is not verified and it may still bill. Pods I’m paying for → Delete. ' + String(error)
              emit({ title: words.manage, words: detail, host: { id: pod.id, price: 0, startedAt: pod.createdAt, status: 'TERMINATED' } })
              return { ok: false, words: detail }
            }
          }
          emit({ title: words.manage, words: words.terminatedPod, host: { id: pod.id, price: 0, startedAt: pod.createdAt, status: 'TERMINATED' } })
          return { ...(saved ?? { ok: true }), words: words.terminatedPod }
        }
        await api.stop(pod.id)
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) { pod = await api.get(pod.id); if (pod.status === 'EXITED') break; await delay(pauseMs) }
        if (pod.status !== 'EXITED') throw new Error('Stop requested but the pod has not stopped yet. It may still be billing compute.')
        closeHostTunnel(pod.id)
        if (record) { record.status = pod.status; writeHostRecord(record) }
      }
    }
    const cancelWatch = async (watchId: string): Promise<LlmHostResult> => {
      const rentedBy = (): HostRecord | undefined => hostRecords().find(row => row.watchedFrom === watchId)
      let rented = rentedBy()
      if (!rented) { await stopHostSetup(watchId); rented = rentedBy() }
      if (rented) {
        emit({ title: words.paid, words: 'The stock watch already rented ' + rented.id + ' · billing has started' })
        if (!api) return { ok: true, words: rented.id + ' · rented by the stock watch · /llmhost → Pods I’m paying for' }
        pod = await getHostResource(api, rented.id, signal); record = rented
        return finish()
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
        if (rented && api) { pod = await getHostResource(api, rented.id, signal); record = rented; return finish() }
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
        if (rentedAfter && api) { pod = await getHostResource(api, rentedAfter.id, signal); record = rentedAfter; return finish() }
        if (!action || action === 'close') return { ok: true, words: watch.id + ' · watching for stock ≤ ' + price(watch.maxPrice ?? watch.price) + ' · /llmhost → Pods I’m paying for → Cancel' }
        if (action === 'cancel') return cancelWatch(watchId)
      }
    }
    try {
      let pods: HostPod[] = []
      if (key) { api = new RunpodClient(key, options.apiBaseUrl); try { pods = await listHostResources(api, signal, detail => emit({ title: words.paid, words: detail })) } catch (error) { emit({ title: words.paid, words: String(error) }); if (/HTTP 401|HTTP 403/.test(String(error))) { key = undefined; api = undefined } } }
      let volumes: Awaited<ReturnType<RunpodClient['volumes']>> = []
      let volumeListError = ''
      if (api) try { volumes = await reconcileVolumes(api, signal) } catch (error) { volumeListError = ' + volumes unread'; emit({ title: words.paid, words: 'Volume list unavailable; billed count is incomplete. ' + String(error) }) }
      const watches = activeWatches()
      const door = await question({ step: 'where', title: words.where, found: 'Choose a road. No GPU is rented without a separate price confirmation.', willRun: '', rows: [{ value: 'rent', label: words.rent }, { value: 'ssh', label: words.ssh }, { value: 'existing', label: words.existing }, { value: 'boxes', label: 'One of my computers' }, { value: 'fast-load', label: FAST_LOAD_DOOR }, ...(key ? [{ value: 'pods', label: words.paid + ' · ' + (pods.length + watches.length + volumes.length) + volumeListError }] : []), ...watches.map(row => ({ value: 'watch:' + row.id, label: row.name + ' · ' + row.id + ' · WATCHING ≤ ' + price(row.maxPrice ?? row.price) + ' · Cancel' })), ...pods.map(row => ({ value: 'pod:' + row.id, label: hostResourceLabel(row) + ' · ' + row.id + ' · ' + row.status + ' · ' + price(row.cost) }))] })
      if (!door) return stopped()
      if (door === 'existing') return runLlmHost(ask, emit, signal)
      if (door === 'boxes') return createBoxRoad(runner)(ask, emit, signal)
      let target: SshTarget
      let recipe: HostRecipe
      let docker = false
      let bank: string | undefined
      if (door === 'rent' || door === 'fast-load' || door === 'pods' || door.startsWith('pod:') || door.startsWith('watch:')) {
        if (!key) {
          const entered = await question({ step: 'runpod-key', title: words.runpodKey, found: words.runpodKeyHelp, willRun: words.runpodKeySave, secret: true })
          if (!entered?.trim()) return stopped()
          key = entered.trim()
          api = new RunpodClient(key, options.apiBaseUrl)
          pods = await listHostResources(api, signal, detail => emit({ title: words.paid, words: detail }))
          writeStoredRunpodApiKey(key)
        }
        api ??= new RunpodClient(key, options.apiBaseUrl)
        if (door === 'fast-load') return fastLoadDoor(api, question, emit, signal, { runner, sessionId, apiBaseUrl: options.apiBaseUrl, startJob: options.startJob })
        if (door === 'pods' || door.startsWith('pod:') || door.startsWith('watch:')) {
          if (door.startsWith('watch:')) return cancelWatch(door.slice(6))
          pods = await listHostResources(api, signal, detail => emit({ title: words.paid, words: detail }))
          volumes = await reconcileVolumes(api, signal).catch(error => { emit({ title: words.paid, words: 'Volume list unavailable; weights disks are not shown and may still bill. ' + String(error) }); return [] })
          const liveWatches = activeWatches()
          const id = door.startsWith('pod:') ? door.slice(4) : await question({ step: 'paid-pods', title: words.paid, found: 'Live account list, including pods created outside Mercury, volumes and stock watches. Disks bill without a pod; external volumes are read-only.', willRun: '', rows: [...volumes.map(row => ({ value: 'volume:' + row.id, label: volumeLabel(row) })), ...liveWatches.map(row => ({ value: 'watch:' + row.id, label: row.name + ' · ' + row.id + ' · WATCHING ≤ ' + price(row.maxPrice ?? row.price) + ' · Cancel' })), ...pods.map(row => ({ value: row.id, label: hostResourceLabel(row) + ' · ' + row.id + ' · ' + row.status + ' · ' + price(row.cost) }))] })
          if (!id) return stopped()
          if (id.startsWith('volume:')) return volumeDeleteDoor(api, id.slice(7), question, signal)
          if (id.startsWith('watch:')) return cancelWatch(id.slice(6))
          pod = await getHostResource(api, id, signal, pods.find(row => row.id === id)?.family)
          record = hostRecords().find(row => row.id === id)
          return finish()
        }
        const budgetText = await question({ step: 'budget', title: words.budget, found: words.budgetHelp, willRun: 'An estimate, not a spending cap. GPU billing starts at creation; storage is additional.' })
        if (budgetText === null) return stopped()
        const budget = budgetText.trim() ? Number(budgetText) : undefined
        if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) throw new Error('Enter a positive budget, or leave it blank.')
        let offer: HostOffer | undefined
        let chosenModel: string | undefined
        let forceShapeList = false
        for (;;) {
          const offers = (await api.offers(signal)).filter(volumeFitsOffer)
          const clusterFailure = api.clusterReadError()
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
              return { name, recipes, modelOffers, cheapest, label: name + ' · ' + summary + ' · ' + stockText + (heavyWeights(lead) ? ' · ' + hostStorageWords(lead, cheapest?.price) : '') }
            }).sort((a, b) => Number(!a.cheapest) - Number(!b.cheapest) || (a.cheapest?.price ?? 0) - (b.cheapest?.price ?? 0))
            const cheapestModel = modelGroups[0]?.cheapest ? modelGroups[0].name : undefined
            const selectedModel = await question({ step: 'models', title: words.offers, found: offers.length ? words.offersHelp : words.noStock, willRun: '', initial: cheapestModel, rows: [...modelGroups.map(group => ({ value: group.name, label: group.label })), { value: 'refresh', label: 'Refresh stock and prices' }, { value: 'cancel', label: words.cancel }] })
            if (!selectedModel || selectedModel === 'cancel') return stopped()
            if (selectedModel === 'refresh') continue
            if (!modelGroups.some(group => group.name === selectedModel)) throw new Error(words.inputError)
            chosenModel = selectedModel
            forceShapeList = false
          }
          const modelOffers = offers.filter(row => modelTitle(row.recipe) === chosenModel)
          if (modelOffers.length === 0 && !forceShapeList) {
            const watching = activeWatches().find(row => watchModel(row) === chosenModel)
            if (watching) { emit({ title: words.paid, words: 'A stock watch for ' + chosenModel + ' is already running · ' + watching.id }); return finishWatch(watching.id) }
            const modelRecipes = currentHostRecipes().filter(row => modelTitle(row) === chosenModel)
            const knownShape = api.shapes().filter(row => modelTitle(row.recipe) === chosenModel).sort((a, b) => a.price - b.price)[0]
            const watchRecipe = knownShape?.recipe ?? modelRecipes[0]!
            const cataloguePrice = knownShape?.price
            const catalogueWords = cataloguePrice === undefined ? 'no catalogue price now' : 'catalogue ' + price(cataloguePrice)
            let ceiling = cataloguePrice
            let backToModels = false
            for (;;) {
              const ctx = (watchRecipe as HostRecipe & { contextPerSlot?: number }).contextPerSlot ?? watchRecipe.context
              const confirmWatch = await question({ step: 'rent-confirm', lines: hostPriceLines(watchRecipe, ceiling), title: words.rentalConfirm, found: watchRecipe.label + ' · ' + shape(watchRecipe) + ' · no stock now · ' + (ceiling === undefined ? catalogueWords + ' · set a price ceiling' : 'ceiling ' + price(ceiling) + ' (' + catalogueWords + ')' + (budget ? ' · ~' + (budget / ceiling).toFixed(1) + 'h for $' + budget : '')), willRun: watchRecipe.verification + ' · ' + (ctx ? ctx.toLocaleString('en-US') + ' context · ' : '') + (watchRecipe.weightsGb ? hostStorageWords(watchRecipe, ceiling) + ' ' : watchRecipe.diskGb + ' GB disk (extra). ') + watchRateWords(options.pauseMs ?? 5000) + '; stops after 12 hours or on Cancel.', rows: [...(ceiling === undefined ? [] : [{ value: 'watch', label: words.watchConfirm + ' (' + price(ceiling) + ')' }]), { value: 'ceiling', label: cataloguePrice === undefined ? 'Set a price ceiling' : 'Set a lower price ceiling (catalogue ' + price(cataloguePrice) + ')' }, { value: 'models', label: 'Choose another model' }, { value: 'cancel', label: words.cancel }] })
              if (!confirmWatch || confirmWatch === 'cancel' || signal.aborted) return stopped()
              if (confirmWatch === 'models') { chosenModel = undefined; backToModels = true; break }
              if (confirmWatch === 'ceiling') {
                const entered = await question({ step: 'watch-ceiling', title: 'Price ceiling in USD/hr', found: watchRecipe.label + ' · ' + shape(watchRecipe) + ' · ' + (cataloguePrice === undefined ? catalogueWords : 'last known catalogue price ' + price(cataloguePrice)), willRun: 'Rent only when a fitting shape has stock at or under this hourly price' + (watchRecipe.count > 1 ? ' for all ' + watchRecipe.count * (watchRecipe.nodes ?? 1) + ' GPUs' : '') + '.', initial: ceiling?.toFixed(2) ?? '' })
                if (entered === null) return stopped()
                const next = entered.trim() ? Number(entered) : cataloguePrice
                if (next === undefined || !Number.isFinite(next) || next <= 0 || cataloguePrice !== undefined && cents(next) > cents(cataloguePrice)) { emit({ title: words.rentalConfirm, words: cataloguePrice === undefined ? 'Enter a positive hourly ceiling.' : 'Enter a positive hourly ceiling at or under ' + price(cataloguePrice) + '.' }); continue }
                ceiling = next
                continue
              }
              if (confirmWatch === 'watch' && ceiling !== undefined) {
                if (!options.startJob) await requireHostJobOwner()
                emit({ title: words.publicKey, words: 'ed25519 · private key stays in Mercury; public key is injected when stock appears.' })
                const sshKey = await ensureHostKey(runner, signal)
                signal.throwIfAborted()
                const id = 'watch-' + randomUUID().slice(0, 12)
                record = queueHostWatch({ id, name: watchRecipe.label, recipe: watchRecipe.id, price: ceiling, maxPrice: ceiling, ...(options.pauseMs ? { pollIntervalMs: options.pauseMs } : {}), startedAt: new Date().toISOString(), status: 'WATCHING', sessionId, workspace: process.cwd(), sshKey: sshKey.path, ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}) })
                if (record.id !== id) emit({ title: words.paid, words: 'A stock watch for ' + chosenModel + ' is already running · ' + record.id })
                else options.startJob?.(record)
                return finishWatch(record.id)
              }
            }
            if (backToModels) continue
          }
          if (modelOffers.length === 1 && !forceShapeList) {
            offer = modelOffers[0]!
          } else {
            const selectedShape = await question({ step: 'offers', title: words.shapes, found: chosenModel + ' · ' + (modelOffers.length ? words.offersHelp : 'no stock now'), willRun: '', initial: modelOffers.length ? '0' : undefined, rows: [...modelOffers.map((row, index) => ({ value: String(index), label: formatHostOfferLabel(row.recipe, shape(row.recipe) + ' · ' + price(row.price) + (heavyWeights(row.recipe) ? ' · ' + hostStorageWords(row.recipe, row.price) : '') + ' · Secure Cloud' + (row.dataCenter ? ' · ' + row.dataCenter : '') + (budget ? ' · ~' + (budget / row.price).toFixed(1) + 'h for $' + budget : '')) })), ...(modelOffers.length === 0 ? [{ value: 'watch', label: words.watchConfirm }] : []), { value: 'models', label: 'Choose another model' }, { value: 'refresh', label: 'Refresh stock and prices' }, { value: 'cancel', label: words.cancel }] })
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
            const kept = await rentalVolume(client, row.recipe, signal)
            return {
              titleSuffix: kept?.state === 'kept' ? ' · weights kept · ~5 min' + (row.recipe.install && !prebuiltEngine(row.recipe) ? ' + engine build' : '') : ' · cold rental ~45 min',
              willRun: fastLoadEstimate(row.recipe, kept) + ' · ' + hostStorageWords(row.recipe, row.price),
              lines: hostPriceLines(row.recipe, row.price),
              confirmLabel: 'Confirm ' + price(row.price) + (kept ? ' + ' + volumePrice(kept) + ' disk (bills without a pod)' : ' + storage') + ' · create this ' + hostResourceKind(row.recipe),
            }
          })
          if (!offer) return stopped()
          const volume = await rentalVolume(api, offer.recipe, signal)
          if (!options.startJob) await requireHostJobOwner()
          recipe = offer.recipe
          emit({ title: words.publicKey, words: 'ed25519 · private key stays in Mercury; public key is injected into this pod only.' })
          const sshKey = await ensureHostKey(runner, signal)
          signal.throwIfAborted()
          pendingName = 'mercury-' + randomUUID().slice(0, 12)
          emit({ title: words.creating, words: pendingName + ' · ' + price(offer.price) + ' + storage · closing does not cancel billing' })
          try {
            pod = await createHostResource(api, offer, sshKey.publicKey, pendingName, volume)
          } catch (error) {
            const refusal = hostCreateRefusal(offer.recipe, error)
            if (!refusal) throw error
            pendingName = ''
            if (signal.aborted || refusal.status !== 400) throw error
            emit({ title: words.creating, words: 'Runpod could not place ' + shape(offer.recipe) + (offer.dataCenter ? ' in ' + offer.dataCenter : '') + ' · no ' + hostResourceKind(offer.recipe) + ' was created' + (refusal.detail ? ' · ' + refusal.detail : '') })
            forceShapeList = true
            continue
          }
          record = queueHostSetup({ ...hostClusterRecord(pod), id: pod.id, name: pod.name, recipe: recipe.id, volumeId: volume?.id, price: offer.price, startedAt: pod.startedAt ?? pod.createdAt, status: pod.status, sessionId, workspace: process.cwd(), sshKey: sshKey.path, ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}) })
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
        const path = await question({ step: 'ssh-key', title: words.sshKey, found: 'The key remains on your computer.', willRun: '' }); if (path === null) return stopped()
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
      if (pod) { saved = { ok: false, words: detail }; mark(); emit({ title: 'Set-up stopped', words: detail }); if (!lifetimeSignal.aborted) return finish() }
      return { ok: false, words: (signal.aborted ? stopped().words : pod ? detail + ' · ' + keepWords(pod) : pendingName ? pendingName + ' may exist; check Pods I’m paying for before retrying · ' + detail : detail) }
    }
  }
}

export const runHostedModel = createHostRoad()
