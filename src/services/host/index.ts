import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { LLM_HOST_WORDS as words } from '../../commands/llmhost/words.js'
import { runLlmHost, type LlmHostRoad, type LlmHostResult } from '../llmHost/index.js'
import { readStoredRunpodApiKey, writeStoredRunpodApiKey } from '../providers/providerSecrets.js'
import { HOST_RECIPES, type HostRecipe } from './recipes.js'
import { RunpodClient, type HostOffer, type HostPod } from './runpod.js'
import { closeHostTunnel, ensureHostKey, fitsSsh, hostRunner, inspectSsh, localKeyPath, openHostTunnel, sshAliases, sshArguments, startHostEngine, waitHostEngine, type HostRunner, type SshTarget } from './ssh.js'
import { hostRecords, removeHostRecord, writeHostRecord, type HostRecord } from './store.js'

type HostOptions = { apiBaseUrl?: string; runner?: HostRunner; pauseMs?: number; readyTimeoutMs?: number }
const price = (amount: number): string => '$' + amount.toFixed(2) + '/hr'
const shape = (recipe: HostRecipe): string => recipe.count + '× ' + recipe.gpu
const keepWords = (pod: HostPod): string => pod.id + ' · ' + (pod.status === 'EXITED' ? words.stoppedDisk : 'pod still running · /llmhost → Pods I’m paying for → Stop or Terminate')

export function createHostRoad(options: HostOptions = {}): LlmHostRoad {
  return async (ask, emit, lifetimeSignal) => {
    const setupController = new AbortController()
    const signal = AbortSignal.any([lifetimeSignal, setupController.signal])
    let settingUp = true
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
      emit({ title: words.manage, words: keepWords(pod), host: { id: pod.id, price: pod.cost, startedAt: pod.startedAt ?? pod.createdAt, status: pod.status, ...(settingUp ? { pause: () => setupController.abort() } : {}) } })
    }
    const finish = async (): Promise<LlmHostResult> => {
      if (!pod || !api) return saved ?? stopped()
      settingUp = false
      for (;;) {
        mark()
        const action = await question({ step: 'pod-controls', title: words.manage, found: pod.name + ' · ' + pod.id + ' · ' + price(pod.cost), willRun: words.rentalStorage, rows: [...(record?.target && pod.status === 'RUNNING' ? [{ value: 'connect', label: 'Reconnect the tunnel and check this model' }] : []), ...(pod.status === 'EXITED' ? [] : [{ value: 'stop', label: words.stopPod }]), { value: 'terminate', label: words.terminatePod }, { value: 'close', label: pod.status === 'EXITED' ? words.closePod : words.keepPod }] })
        if (!action || action === 'close') return { ...(saved ?? { ok: true }), words: keepWords(pod) }
        if (action === 'connect' && record?.target) {
          pod = await api.get(pod.id, lifetimeSignal)
          const direct = pod.ssh?.direct
          if (!direct) { emit({ title: words.tunnel, words: 'Runpod has not reported a direct SSH address yet.' }); continue }
          const target = { host: direct.host, port: direct.port, user: direct.username, key: record.target.key }
          const recipe = HOST_RECIPES.find(row => row.id === record!.recipe)
          if (!recipe) throw new Error('The saved host recipe is unavailable. Use the existing-server door after opening an SSH tunnel.')
          try {
            await waitHostEngine(target, recipe, runner, lifetimeSignal, pauseMs, timeoutMs)
            const port = await openHostTunnel(pod.id, target, runner, lifetimeSignal)
            record.target = target; record.localPort = port; writeHostRecord(record)
            saved = await runLlmHost(plan => plan.step === 'servers' ? Promise.resolve(record?.provider ?? '__add__') : plan.step === 'action' ? Promise.resolve('repoint') : plan.step === 'address' ? Promise.resolve('http://127.0.0.1:' + port + '/v1') : plan.step === 'dialect' ? Promise.resolve(recipe.engine ?? 'sglang') : plan.step === 'key' && plan.found === words.keyOptional ? Promise.resolve('') : question(plan), emit, lifetimeSignal)
            if (saved.registered && saved.model) { record.provider = saved.model.split('/')[1]; writeHostRecord(record) }
            emit({ title: words.done, words: saved.words })
          } catch (error) { emit({ title: words.tunnel, words: String(error) }) }
          continue
        }
        if (!['stop', 'terminate'].includes(action)) continue
        const confirm = await question({ step: 'pod-confirm', title: action === 'stop' ? words.stopPod : words.terminatePod, found: pod.name + ' · ' + pod.id, willRun: action === 'stop' ? words.stoppedDisk : 'Permanently delete this pod and everything on its volume disk.', rows: [{ value: action, label: 'Confirm ' + action }, { value: 'cancel', label: words.cancel }] })
        if (confirm !== action || lifetimeSignal.aborted) continue
        if (action === 'terminate') {
          await api.terminate(pod.id)
          if ((await api.pods()).some(row => row.id === pod!.id)) throw new Error('Runpod accepted termination but still lists this pod. Check it again; deletion is not yet verified.')
          closeHostTunnel(pod.id)
          removeHostRecord(pod.id)
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
    try {
      let pods: HostPod[] = []
      if (key) { api = new RunpodClient(key, options.apiBaseUrl); try { pods = await api.pods(signal) } catch (error) { emit({ title: words.paid, words: String(error) }); if (/HTTP 401|HTTP 403/.test(String(error))) { key = undefined; api = undefined } } }
      const door = await question({ step: 'where', title: words.where, found: 'Choose a road. No GPU is rented without a separate price confirmation.', willRun: '', rows: [{ value: 'rent', label: words.rent }, { value: 'ssh', label: words.ssh }, { value: 'existing', label: words.existing }, ...(key ? [{ value: 'pods', label: words.paid + ' · ' + pods.length }] : []), ...pods.map(row => ({ value: 'pod:' + row.id, label: row.name + ' · ' + row.id + ' · ' + row.status + ' · ' + price(row.cost) }))] })
      if (!door) return stopped()
      if (door === 'existing') return runLlmHost(ask, emit, signal)
      let target: SshTarget
      let recipe: HostRecipe
      let docker = false
      let bank: string | undefined
      if (door === 'rent' || door === 'pods' || door.startsWith('pod:')) {
        if (!key) {
          const entered = await question({ step: 'runpod-key', title: words.runpodKey, found: words.runpodKeyHelp, willRun: words.runpodKeySave, secret: true })
          if (!entered?.trim()) return stopped()
          key = entered.trim()
          api = new RunpodClient(key, options.apiBaseUrl)
          pods = await api.pods(signal)
          writeStoredRunpodApiKey(key)
        }
        api ??= new RunpodClient(key, options.apiBaseUrl)
        if (door === 'pods' || door.startsWith('pod:')) {
          pods = await api.pods(signal)
          const id = door.startsWith('pod:') ? door.slice(4) : await question({ step: 'paid-pods', title: words.paid, found: 'Live account list, including pods created outside Mercury. Stopped disks still bill.', willRun: '', rows: pods.map(row => ({ value: row.id, label: row.name + ' · ' + row.id + ' · ' + row.status + ' · ' + price(row.cost) })) })
          if (!id) return stopped()
          pod = await api.get(id, signal)
          record = hostRecords().find(row => row.id === id)
          return finish()
        }
        const budgetText = await question({ step: 'budget', title: words.budget, found: words.budgetHelp, willRun: 'An estimate, not a spending cap. GPU billing starts at creation; storage is additional.' })
        if (budgetText === null) return stopped()
        const budget = budgetText.trim() ? Number(budgetText) : undefined
        if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) throw new Error('Enter a positive budget, or leave it blank.')
        let offer: HostOffer | undefined
        for (;;) {
          const offers = await api.offers(signal)
          const selected = await question({ step: 'offers', title: words.offers, found: offers.length ? 'GLM Flash first; smaller models below. Prices are for all GPUs, plus storage.' : words.noStock, willRun: '', rows: [...offers.map((row, index) => ({ value: String(index), label: row.recipe.label + ' · ' + shape(row.recipe) + ' · ' + price(row.price) + ' · Secure Cloud' + (budget ? ' · ~' + (budget / row.price).toFixed(1) + 'h for $' + budget : '') })), { value: 'refresh', label: 'Refresh stock and prices' }, { value: 'cancel', label: words.cancel }] })
          if (!selected || selected === 'cancel') return stopped()
          if (selected === 'refresh') continue
          offer = offers[Number(selected)]
          if (!offer) throw new Error(words.inputError)
          const confirm = await question({ step: 'rent-confirm', title: words.rentalConfirm, found: offer.recipe.label + ' · ' + shape(offer.recipe) + ' · ' + price(offer.price) + (budget ? ' · ~' + (budget / offer.price).toFixed(1) + 'h for $' + budget : ''), willRun: offer.recipe.verification + ' · ' + (offer.recipe.context ? offer.recipe.context.toLocaleString('en-US') + ' context · ' : '') + offer.recipe.diskGb + ' GB disk (extra). Ready may take 20–90 min; billing starts now.', rows: [{ value: 'rent', label: 'Confirm ' + price(offer.price) + ' + storage · create this pod' }, { value: 'cancel', label: words.cancel }] })
          if (confirm !== 'rent' || signal.aborted) return stopped()
          const fresh = (await api.offers(signal)).find(row => row.recipe.id === offer!.recipe.id && row.gpuId === offer!.gpuId && row.dataCenter === offer!.dataCenter)
          if (!fresh || fresh.price !== offer.price) { emit({ title: words.offers, words: 'Stock or price changed. Choose and confirm the next fitting shape; no pod was created.' }); continue }
          offer = fresh
          break
        }
        recipe = offer.recipe
        emit({ title: words.publicKey, words: 'ed25519 · private key stays in Mercury; public key is injected into this pod only.' })
        const sshKey = await ensureHostKey(runner, signal)
        signal.throwIfAborted()
        pendingName = 'mercury-' + randomUUID().slice(0, 12)
        emit({ title: words.creating, words: pendingName + ' · ' + price(offer.price) + ' + storage · closing does not cancel billing' })
        pod = await api.create(offer, sshKey.publicKey, pendingName)
        record = { id: pod.id, name: pod.name, recipe: recipe.id, price: offer.price, startedAt: pod.startedAt ?? pod.createdAt, status: pod.status }
        writeHostRecord(record)
        mark()
        emit({ title: words.podWait, words: pod.id + ' · key ' + sshKey.path })
        const started = Date.now()
        let last = 'SSH address not yet assigned'
        let connected: SshTarget | undefined
        while (!signal.aborted && Date.now() - started < timeoutMs) {
          pod = await api.get(pod.id, signal)
          const direct = pod.ssh?.direct
          if (pod.status === 'ERROR' || pod.status === 'EXITED') throw new Error('Pod is ' + pod.status + '. ' + await api.logs(pod.id))
          if (direct && pod.status === 'RUNNING') {
            const candidate = { host: direct.host, port: direct.port, user: direct.username, key: sshKey.path }
            try { await runner.run('ssh', [...sshArguments(candidate), 'true'], signal); connected = candidate; break } catch (error) { last = 'SSH refused ' + candidate.host + ':' + candidate.port + ' with key ' + sshKey.path + '. ' + String(error) }
          }
          await delay(pauseMs, undefined, { signal })
        }
        if (!connected) throw new Error(last + '. ' + await api.logs(pod.id))
        target = connected
        record.target = target
        writeHostRecord(record)
      } else if (door === 'ssh') {
        const host = await question({ step: 'ssh-host', title: words.sshHost, found: sshAliases().join(' · ') || 'Use an existing SSH config alias, or a host name.', willRun: 'Read nvidia-smi through SSH; no model starts yet.' })
        if (!host) return stopped()
        const user = await question({ step: 'ssh-user', title: words.sshUser, found: host, willRun: '' }); if (user === null) return stopped()
        const port = await question({ step: 'ssh-port', title: words.sshPort, found: host, willRun: '' }); if (port === null) return stopped()
        const path = await question({ step: 'ssh-key', title: words.sshKey, found: 'The key remains on your computer.', willRun: '' }); if (path === null) return stopped()
        target = { host: host.trim(), ...(user.trim() ? { user: user.trim() } : {}), ...(port.trim() ? { port: Number(port) } : {}), key: localKeyPath(path.trim()) }
        const hardware = await inspectSsh(target, runner, signal)
        docker = hardware.docker
        const fits = HOST_RECIPES.filter(row => fitsSsh(row, hardware.gpus) && (docker || Boolean(row.pythonInstall)))
        const selected = await question({ step: 'ssh-recipe', title: 'Recipes that fit this SSH box', found: hardware.gpus.map(gpu => gpu.name + ' ' + gpu.memory + ' GB').join(' · '), willRun: fits.length ? 'Choose a documented recipe.' : 'No documented recipe fits these GPUs and this engine installation.', rows: fits.map(row => ({ value: row.id, label: row.label + ' · ' + shape(row) + ' · ' + row.verification })) })
        if (!selected) return stopped()
        recipe = fits.find(row => row.id === selected)!
        if (!recipe) throw new Error(words.inputError)
        const folder = await question({ step: 'ssh-bank', title: words.sshBank, found: recipe.model, willRun: 'Use the selected model’s complete folder, or download its weights to /workspace.' }); if (folder === null) return stopped()
        bank = folder.trim() || undefined
        const confirm = await question({ step: 'ssh-confirm', title: words.sshConfirm, found: target.host + ' · ' + recipe.label + ' · ' + recipe.verification, willRun: 'Use /workspace (' + recipe.diskGb + ' GB free), tmux and curl. ' + (docker ? 'Run the recipe image using Docker.' : 'Install SGLang in an isolated Python environment.'), rows: [{ value: 'start', label: 'Start the engine and open a private tunnel' }, { value: 'cancel', label: words.cancel }] })
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
      if (record && saved.registered && saved.model) { record.provider = saved.model.split('/')[1]; writeHostRecord(record) }
      emit({ title: words.done, words: saved.words })
      if (pod) return finish()
      return { ...saved, words: saved.words + ' · SSH engine keeps running; tmux session mercury-' + recipe.id + ' on ' + target.host }
    } catch (error) {
      const detail = key ? String(error).split(key).join('[redacted]') : String(error)
      if (pod) { saved = { ok: false, words: detail }; mark(); emit({ title: 'Set-up stopped', words: detail }); if (!lifetimeSignal.aborted) return finish() }
      return { ok: false, words: (signal.aborted ? stopped().words : detail + (pod ? ' · ' + keepWords(pod) : pendingName ? ' · ' + pendingName + ' may exist; check Pods I’m paying for before retrying.' : '')) }
    }
  }
}

export const runHostedModel = createHostRoad()
