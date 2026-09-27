import { localProbeTargets, refreshLocalDiscovery, type LocalServerKind } from '../providers/local/localDiscovery.js'
import { LOCAL_SERVER_NAMES } from '../providers/local/localCatalogue.js'
import { detectLocalServers, ollamaRootOf, probeWords } from './setupDetect.js'
import { findOllamaInstall, planInstall, runInstall, waitForInstall, windowsAppExe } from './setupInstall.js'
import { resolveSetupIo, seconds, type ResolvedSetupIo } from './setupIo.js'
import { pickAndProve, proveRecordFor, proveRequestOf, proveTimingWords, proveWillRun, setupModelIdOf } from './setupProve.js'
import { modelListed, pullModel } from './setupPull.js'
import { planStart, readOllamaVersion, startServer } from './setupStart.js'
import {
  SETUP_KEYS_LINE,
  SETUP_MODEL_ID,
  SETUP_MODEL_LIBRARY_SIZE_WORDS,
  SETUP_MODEL_TAG,
  SETUP_PROVE_MAX_TOKENS,
  type DetectedServer,
  type InstallPlan,
  type OllamaInstallFound,
  type ProveResult,
  type PullProgress,
  type SetupConsent,
  type SetupConsentFn,
  type SetupEvent,
  type SetupIo,
  type SetupPlatform,
  type SetupStepKind,
  type SetupStepLabel,
  type SetupStepNumber,
  type SetupStepPlan,
  type SetupStepResult,
  type SetupSummary,
  type StartPlan,
  type WindowChoice,
} from './setupTypes.js'
import { chooseWindow } from './setupWindow.js'

const ORDER: readonly SetupStepLabel[] = ['1', '2', '2b', '3', '4', '5', '6']

function numberOf(label: SetupStepLabel): SetupStepNumber {
  return Number(label.replace('b', '')) as SetupStepNumber
}

function after(label: SetupStepLabel): SetupStepLabel[] {
  const rest = ORDER.slice(ORDER.indexOf(label))
  return label === '2' ? rest.filter(l => l !== '2b') : rest
}

function list(labels: SetupStepLabel[]): string {
  return labels.length > 0 ? labels.join(', ') : 'none'
}

export function summaryWords(summary: Omit<SetupSummary, 'words'>): string {
  const parts: string[] = []
  if (summary.reason === 'stopped' && summary.stoppedAt !== undefined) parts.push(`stopped at step ${summary.stoppedAt}`)
  if (summary.reason === 'ended' && summary.failed.length > 0) parts.push(`step ${summary.failed[summary.failed.length - 1]} failed`)
  parts.push(`done: ${list(summary.ran)}`)
  if (summary.skipped.length > 0) parts.push(`skipped: ${list(summary.skipped)}`)
  if (summary.notDone.length > 0) parts.push(`not done: ${list(summary.notDone)}`)
  if (summary.ready?.ok) parts.push(summary.ready.words)
  else if (summary.model !== undefined) parts.push(`model ${summary.model}`)
  return parts.join(' · ')
}

function platformOf(platform: NodeJS.Platform): SetupPlatform {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux'
}

async function proveWillRunFor(tag: string, root: string, server: LocalServerKind, seam: SetupIo): Promise<string> {
  const io = resolveSetupIo(seam)
  await refreshLocalDiscovery({ force: true, env: io.env, fetchImpl: io.fetchImpl, timeoutMs: io.timeoutMs, now: io.now, ...(io.signal !== undefined ? { signal: io.signal } : {}) })
  const record = proveRecordFor(tag, root, server)
  if (record) return proveWillRun(record)
  const id = setupModelIdOf(tag, server)
  const request = proveRequestOf({ id: tag })
  const { extra, ...core } = request
  return server === 'ollama'
    ? `/model ${id} · POST ${root}/api/chat ${JSON.stringify({ model: tag, messages: core.messages, stream: true, truncate: false, options: { num_predict: SETUP_PROVE_MAX_TOKENS } })}`
    : `/model ${id} · POST ${root}/v1/chat/completions ${JSON.stringify({ ...core, ...(extra ?? {}), stream: true })}`
}

async function findLine(io: ResolvedSetupIo): Promise<string> {
  const brew = io.platform === 'darwin' || io.platform === 'linux' ? await io.which('brew') : undefined
  const brewWords = brew ? ` · ${brew} list --formula ollama` : ''
  if (io.platform === 'darwin') return `which ollama · ls /Applications/Ollama.app ${io.home}/Applications/Ollama.app${brewWords}`
  if (io.platform === 'linux') return `which ollama · systemctl status ollama · ls /usr/local/bin/ollama /usr/bin/ollama${brewWords}`
  if (io.platform === 'win32') return `where ollama · dir "${windowsAppExe(io.env)}"`
  return 'which ollama'
}

async function* streamed<T, R>(run: (emit: (item: T) => void) => Promise<R>): AsyncGenerator<T, R, void> {
  const queue: T[] = []
  let wake: (() => void) | undefined
  let settled = false
  let outcome: R | undefined
  let failure: unknown
  let failed = false
  const done = run(item => {
    queue.push(item)
    wake?.()
  })
    .then(
      value => {
        outcome = value
      },
      error => {
        failed = true
        failure = error
      },
    )
    .finally(() => {
      settled = true
      wake?.()
    })
  for (;;) {
    while (queue.length > 0) yield queue.shift()!
    if (settled) break
    await new Promise<void>(resolve => {
      wake = resolve
    })
  }
  await done
  if (failed) throw failure
  return outcome as R
}

export async function* runSetupRoad(consent: SetupConsentFn, seam: SetupIo = {}): AsyncGenerator<SetupEvent, SetupSummary, void> {
  const io = resolveSetupIo(seam)
  const ran: SetupStepLabel[] = []
  const skipped: SetupStepLabel[] = []
  const failed: SetupStepLabel[] = []
  let model: string | undefined
  let ready: ProveResult | undefined
  const summarize = (reason: SetupSummary['reason'], stoppedAt?: SetupStepLabel, extra?: string): SetupSummary => {
    const seen = new Set<SetupStepLabel>([...ran, ...skipped, ...failed])
    const notDone = (stoppedAt !== undefined ? after(stoppedAt) : []).filter(l => !seen.has(l))
    const base: Omit<SetupSummary, 'words'> = {
      ran: [...ran],
      skipped: [...skipped],
      failed: [...failed],
      notDone,
      ...(stoppedAt !== undefined ? { stoppedAt } : {}),
      reason,
      ...(model !== undefined ? { model } : {}),
      ...(ready !== undefined ? { ready } : {}),
    }
    const words = summaryWords(base)
    return { ...base, words: extra !== undefined ? `${words} · ${extra}` : words }
  }
  const plan = (label: SetupStepLabel, kind: SetupStepKind, title: string, found: string, willRun: string, needsSudo = false, skippable = true): SetupStepPlan => ({
    step: numberOf(label),
    label,
    kind,
    title,
    found,
    willRun,
    needsSudo,
    keys: SETUP_KEYS_LINE,
    skippable,
  })
  const result = (p: SetupStepPlan, outcome: SetupStepResult['outcome'], lastLine: string, detail?: SetupStepResult['detail'], rc?: number): SetupEvent => {
    ;(outcome === 'ran' ? ran : outcome === 'skipped' ? skipped : failed).push(p.label)
    return { type: 'result', result: { step: p.step, label: p.label, kind: p.kind, outcome, ...(rc !== undefined ? { rc } : {}), lastLine, ...(detail !== undefined ? { detail } : {}) } }
  }
  const progress = (p: SetupStepPlan, line: string, extra?: PullProgress): SetupEvent => ({ type: 'progress', step: p.step, label: p.label, line, ...(extra !== undefined ? { progress: extra } : {}) })
  const ask = async (p: SetupStepPlan): Promise<SetupConsent> => consent(p)
  const stop = (label: SetupStepLabel): SetupSummary => summarize('stopped', label)

  let ollamaRoot = ollamaRootOf(io.env)
  const targets = localProbeTargets(io.env)

  const step1 = plan('1', 'find-server', 'Find a server', targets.length === 0 ? 'probing is off (MERCURY_LOCAL_PROBE_TARGETS=none): nothing to find' : `probing ${targets.length} server${targets.length === 1 ? '' : 's'}: ${targets.map(t => `${LOCAL_SERVER_NAMES[t.kind]} ${t.root}`).join(', ')}`, probeWords(io.env))
  yield { type: 'step', plan: step1 }
  const c1 = await ask(step1)
  if (c1 === 'stop') {
    const summary = stop('1')
    yield { type: 'done', summary }
    return summary
  }
  let server: DetectedServer | undefined
  if (c1 === 'skip') {
    yield result(step1, 'skipped', 'skipped: assuming no local server answers')
  } else {
    server = await detectLocalServers(seam)
    yield result(step1, 'ran', server.words, server)
    if (server.kind !== 'none' && server.kind !== 'ollama' && server.models.length > 0) {
      const other = server
      const otherKind = server.kind
      const first = other.models[0]!
      const step6 = plan('6', 'prove', 'Pick and prove', `${other.label} at ${other.root} serves ${first}; nothing is installed or started`, await proveWillRunFor(first, other.root, otherKind, seam))
      yield { type: 'step', plan: step6 }
      const c6 = await ask(step6)
      if (c6 === 'stop') {
        const summary = stop('6')
        yield { type: 'done', summary }
        return summary
      }
      if (c6 === 'skip') {
        yield result(step6, 'skipped', `skipped: ${first} stays unpicked`)
      } else {
        ready = await pickAndProve(first, { ...seam, root: other.root, server: otherKind })
        model = ready.model
        yield result(step6, ready.ok ? 'ran' : 'failed', ready.ok ? proveTimingWords(ready.timings) : ready.words, ready)
      }
      const summary = summarize(ready?.ok === false ? 'ended' : 'finished')
      yield { type: 'done', summary }
      return summary
    }
    if (server.kind === 'ollama') ollamaRoot = server.root
  }
  if (ollamaRoot === undefined) {
    const summary = summarize('ended', '2', 'no Ollama target: MERCURY_LOCAL_PROBE_TARGETS names none')
    yield { type: 'done', summary }
    return summary
  }
  const root = ollamaRoot
  const ollamaUp = server?.kind === 'ollama'
  const hasTag = server?.hasTestedModel === true

  if (!ollamaUp) {
    let found: OllamaInstallFound | undefined
    const step2 = plan('2', 'find-ollama', 'Find Ollama on this machine', server === undefined ? 'no local server assumed' : server.words, await findLine(io))
    yield { type: 'step', plan: step2 }
    const c2 = await ask(step2)
    if (c2 === 'stop') {
      const summary = stop('2')
      yield { type: 'done', summary }
      return summary
    }
    if (c2 === 'skip') {
      yield result(step2, 'skipped', 'skipped: assuming ollama is not installed')
    } else {
      found = await findOllamaInstall(seam)
      yield result(step2, 'ran', found.words, found)
    }
    if (found === undefined || found.found === 'none') {
      const install: InstallPlan = await planInstall(platformOf(io.platform), seam)
      const step2b = plan('2b', 'install', 'Install Ollama', `${found?.words ?? 'ollama not looked for'} · ${install.says.join(' · ')}`, install.command, install.needsSudo)
      yield { type: 'step', plan: step2b }
      const c2b = await ask(step2b)
      if (c2b === 'stop') {
        const summary = stop('2b')
        yield { type: 'done', summary }
        return summary
      }
      if (c2b === 'skip') {
        found = await findOllamaInstall(seam)
        yield result(step2b, 'skipped', `skipped: ${found.words}`, found)
      } else {
        const installed = await runInstall(install, seam)
        if (installed.rc !== 0) {
          yield result(step2b, 'failed', `rc ${installed.rc}${installed.lastLine ? ` · ${installed.lastLine}` : ''}`, installed, installed.rc)
          const summary = summarize('ended', '3')
          yield { type: 'done', summary }
          return summary
        }
        found = yield* streamed<SetupEvent, OllamaInstallFound>(emit => waitForInstall(install, seam, line => emit(progress(step2b, line))))
        yield result(step2b, found.found === 'none' ? 'failed' : 'ran', found.found === 'none' ? `rc 0 · ${found.words} after ${seconds(io.installWaitMs)}` : `rc 0${installed.lastLine ? ` · ${installed.lastLine}` : ''} · ${found.words}`, found, 0)
      }
      if (found.found === 'none') {
        const summary = summarize('ended', '3', 'ollama is still not installed; run /localsetup again once it is')
        yield { type: 'done', summary }
        return summary
      }
    }
    const start: StartPlan = await planStart(found, seam)
    const step3 = plan('3', 'start', 'Start the server', `${found.words}${start.alreadyUp ? ` · ${start.alreadyUp} already answers at ${root} (s skips)` : ''} · ${start.says.join(' · ')}`, start.command, start.needsSudo)
    yield { type: 'step', plan: step3 }
    const c3 = await ask(step3)
    if (c3 === 'stop') {
      const summary = stop('3')
      yield { type: 'done', summary }
      return summary
    }
    if (c3 === 'skip') {
      const version = await readOllamaVersion(root, seam)
      yield result(step3, 'skipped', version !== undefined ? `skipped: Ollama ${version} answers at ${root}` : `skipped: nothing answers at ${root}/api/version yet`)
    } else {
      const started = yield* streamed<SetupEvent, Awaited<ReturnType<typeof startServer>>>(emit => startServer(start, seam, line => emit(progress(step3, line))))
      yield result(step3, started.up ? 'ran' : 'failed', `rc ${started.rc} · ${started.words}${started.up || !started.lastLine ? '' : ` · ${started.lastLine}`}`, started, started.rc)
      if (!started.up) {
        const summary = summarize('ended', '4')
        yield { type: 'done', summary }
        return summary
      }
    }
  }

  if (!hasTag) {
    const listed = await modelListed(root, SETUP_MODEL_TAG, seam)
    const who = server?.kind === 'ollama' ? server.label : `Ollama at ${root}`
    const step4 = plan('4', 'pull', 'Pull the tested model', listed ? `${SETUP_MODEL_TAG} is already listed at ${root} (s skips)` : `${who} does not list ${SETUP_MODEL_TAG} · about ${SETUP_MODEL_LIBRARY_SIZE_WORDS} to download (ollama.com/library/qwen3.5 lists the tag at ${SETUP_MODEL_LIBRARY_SIZE_WORDS}); the exact size shows with the first row`, `POST ${root}/api/pull {"model":${JSON.stringify(SETUP_MODEL_TAG)},"stream":true}`)
    yield { type: 'step', plan: step4 }
    const c4 = await ask(step4)
    if (c4 === 'stop') {
      const summary = stop('4')
      yield { type: 'done', summary }
      return summary
    }
    if (c4 === 'skip') {
      yield result(step4, 'skipped', listed ? `skipped: ${SETUP_MODEL_TAG} is already listed` : `skipped: ${SETUP_MODEL_TAG} was not pulled`)
    } else {
      const pulled = yield* streamed<SetupEvent, Awaited<ReturnType<typeof pullModel>>>(emit => pullModel(root, SETUP_MODEL_TAG, p => emit(progress(step4, p.line, p)), seam))
      yield result(step4, pulled.success ? 'ran' : 'failed', pulled.words, pulled)
      if (!pulled.success) {
        const summary = summarize('ended', '5')
        yield { type: 'done', summary }
        return summary
      }
    }
  }

  const step5 = plan('5', 'window', "Set the window from this machine's memory", `${SETUP_MODEL_TAG} at ${root} · this box has ${(io.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB · the largest of 32k · 64k · 128k · 256k whose projected load (weights + the KV cache at the server's cache type and slots) fits the memory usable for models (the server's own gpu memory line when it states one), never above the trained maximum — the same rule auto uses at every send`, `GET ${root}/api/tags · POST ${root}/api/show {"model":${JSON.stringify(SETUP_MODEL_TAG)}} → localModelWindows[${JSON.stringify(SETUP_MODEL_ID)}] in the config home (nothing is written to the server's environment)`)
  yield { type: 'step', plan: step5 }
  const c5 = await ask(step5)
  if (c5 === 'stop') {
    const summary = stop('5')
    yield { type: 'done', summary }
    return summary
  }
  let window: WindowChoice | undefined
  if (c5 === 'skip') {
    yield result(step5, 'skipped', 'skipped: the window setting is left as it is')
  } else {
    try {
      window = await chooseWindow(root, SETUP_MODEL_TAG, seam)
      yield result(step5, 'ran', window.words, window)
    } catch (error) {
      yield result(step5, 'failed', error instanceof Error ? error.message : String(error))
      const summary = summarize('ended', '6')
      yield { type: 'done', summary }
      return summary
    }
  }

  const step6 = plan('6', 'prove', 'Pick and prove', window !== undefined ? `window ${window.words}` : `${SETUP_MODEL_TAG} at ${root}, the window setting as it is`, await proveWillRunFor(SETUP_MODEL_TAG, root, 'ollama', seam))
  yield { type: 'step', plan: step6 }
  const c6 = await ask(step6)
  if (c6 === 'stop') {
    const summary = stop('6')
    yield { type: 'done', summary }
    return summary
  }
  if (c6 === 'skip') {
    yield result(step6, 'skipped', `skipped: ${SETUP_MODEL_ID} is not picked`)
  } else {
    ready = await pickAndProve(SETUP_MODEL_TAG, { ...seam, root, server: 'ollama' })
    model = ready.model
    yield result(step6, ready.ok ? 'ran' : 'failed', ready.ok ? proveTimingWords(ready.timings) : ready.words, ready)
  }
  const summary = summarize(ready?.ok === false ? 'ended' : 'finished')
  yield { type: 'done', summary }
  return summary
}
