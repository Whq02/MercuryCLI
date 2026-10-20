import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { configuredCompatEndpoints } from '../providers/openaicompat/compatAccounts.js'
import { setTimeout as delay } from 'node:timers/promises'
import { readStoredRunpodApiKey } from '../providers/providerSecrets.js'
import { runLlmHost } from '../llmHost/index.js'
import { LLM_HOST_WORDS } from '../../commands/llmhost/words.js'
import { RunpodClient } from './runpod.js'
import { HOST_RECIPES } from './recipes.js'
import { hostNotice } from './notices.js'
import { hostDirectory, patchHostRecord, readHostRecord, removeHostRecord } from './store.js'
import { queueHostSetup } from './jobs.js'
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
  const recipe = HOST_RECIPES.find(row => row.id === initial.recipe)
  patchHostRecord(id, { jobState: 'running', error: undefined })
  const timer = setInterval(() => {
    const current = readHostRecord(id)
    if (!current || current.generation !== generation || current.jobState === 'stopped') controller.abort()
    if (initial.jobKind === 'watch' || !target || !recipe || logBusy || signal.aborted || current?.jobState === 'ready') return
    logBusy = true
    void runner.run('ssh', [...sshArguments(target), 'dd if=/workspace/mercury-host/' + recipe.id + '/engine.log bs=1 skip=' + offset + ' count=8192 status=none'], signal)
      .then(async text => {
        offset += Buffer.byteLength(text); log(text)
        if (readHostRecord(id)?.step?.startsWith('downloading weights')) {
          const size = await runner.run('ssh', [...sshArguments(target!), 'du -sb /workspace/mercury-host/' + recipe.id + '/weights 2>/dev/null || true'], signal)
          const bytes = Number(/^(\d+)/.exec(size)?.[1])
          if (Number.isFinite(bytes)) mark('downloading weights ' + (bytes / 1e9).toFixed(2) + ' GB')
        }
      })
      .catch(() => {})
      .finally(() => { logBusy = false })
  }, initial.jobKind === 'watch' ? Math.min(pause, 100) : pause)
  if (initial.jobKind === 'watch') {
    try {
      if (!key) throw new Error('The saved Runpod key is unavailable.')
      if (!recipe) throw new Error('The saved host recipe is unavailable.')
      const api = new RunpodClient(key, initial.apiBaseUrl)
      const sshKey = await ensureHostKey(runner, signal)
      const pollMs = options.pauseMs ?? initial.pollIntervalMs ?? 5000
      const watchWindowMs = options.timeoutMs ?? initial.pollWindowMs ?? 12 * 3600_000
      const deadline = Date.now() + watchWindowMs
      const maxPrice = initial.maxPrice ?? initial.price
      while (!signal.aborted && Date.now() < deadline) {
        const current = readHostRecord(id)
        if (!current || current.generation !== generation || current.jobState === 'stopped') return
        patchHostRecord(id, { advancedAt: Date.now() })
        const offer = await api.watchOffer(recipe, maxPrice, signal)
        const afterPoll = readHostRecord(id)
        if (!afterPoll || afterPoll.generation !== generation || afterPoll.jobState === 'stopped') return
        if (offer) {
          const podName = 'mercury-' + randomUUID().slice(0, 12)
          const pod = await api.create(offer, sshKey.publicKey, podName)
          const rentedWords = 'Rented ' + offer.recipe.label.split(' · ')[0] + ' · ' + offer.recipe.count + '× ' + offer.recipe.gpu + ' · $' + offer.price.toFixed(2) + '/hr' + (offer.dataCenter ? ' in ' + offer.dataCenter : '') + ' · setting up'
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
            ...(afterPoll.apiBaseUrl ? { apiBaseUrl: afterPoll.apiBaseUrl } : {}),
          })
          hostNotice(setupRecord, 'rented', rentedWords)
          removeHostRecord(id)
          if (!reconcileRecord(hostDirectory(), 'host-' + id.toLowerCase())) {
            await runHostJob(setupRecord.id, setupRecord.generation!, options)
          }
          return
        }
        await delay(pollMs, undefined, { signal })
      }
      const ended = readHostRecord(id)
      if (ended && ended.generation === generation && ended.jobState !== 'stopped') {
        const stoppedRecord = patchHostRecord(id, { jobState: 'stopped', status: 'EXPIRED', step: 'watch ended after 12 hours without stock' })!
        hostNotice(stoppedRecord, 'expired', stoppedRecord.name + ' · watch ended after 12 hours without stock ≤ $' + maxPrice.toFixed(2) + '/hr · no pod was created')
      }
    } catch (error) {
      const current = readHostRecord(id)
      if (current && current.generation === generation && current.jobState !== 'stopped') {
        const detail = clean(String(error))
        const failedRecord = patchHostRecord(id, { jobState: 'failed', error: detail })!
        log(detail)
        hostNotice(failedRecord, 'failed', failedRecord.name + ' · stock watch stopped · ' + detail)
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
    mark('installing')
    await startHostEngine(target, recipe, runner, signal, false, true)
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
    const current = readHostRecord(id)
    if (current && current.generation === generation && current.jobState !== 'stopped') {
      const detail = clean(String(error))
      const record = patchHostRecord(id, { jobState: 'failed', error: detail })!
      log(detail)
      hostNotice(record, 'failed', record.name + ' · setup stalled at ' + record.step + ' · ' + detail + ' · /llmhost → Pods I’m paying for → Resume or Terminate')
    }
    closeHostTunnel(id)
  } finally { clearInterval(timer) }
}
