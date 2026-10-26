import { join } from 'node:path'
import { bankedHostRecipes, bankFolder, bankFree, bankModelPath, bankState, bytesWords, rememberBankFolder, verifyBank } from '../host/bank.js'
import { pullIntoBank } from '../host/bankPull.js'
import { huggingFaceHubBase, huggingFaceToken } from '../host/hfRecipes.js'
import type { HostRunner } from '../host/ssh.js'
import { shQuote } from '../host/boxExecution.js'
import { bankGgufModel, ggufModelName, ggufModelRow, listGgufModels, withProjector, type GgufModel } from './ggufModels.js'
import { ggufServerPlan, startGgufServer, type GgufServerIo } from './ggufServer.js'
import { resolveSetupIo } from './setupIo.js'
import { pickAndProve } from './setupProve.js'
import { pickOf, runSetupRoad, streamed } from './setupRoad.js'
import type { SetupConsentFn, SetupEvent, SetupStepLabel, SetupStepPlan, SetupSummary } from './setupTypes.js'

export interface GgufSetupIo extends GgufServerIo { repo?: string; hubBase?: string; bankRunner?: HostRunner }
const choiceKeys = '↑↓ choose · ↵ pick · esc keeps your model'
export async function* runLocalSetupRoad(consent: SetupConsentFn, seam: GgufSetupIo = {}): AsyncGenerator<SetupEvent> {
  const io = resolveSetupIo(seam)
  const signal = io.signal ?? new AbortController().signal
  const ran: SetupStepLabel[] = []
  let current: SetupStepLabel = '1'
  let started: Awaited<ReturnType<typeof startGgufServer>> | undefined
  let keptServer = false
  const plan = (label: SetupStepLabel, title: string, found = '', willRun = ''): SetupStepPlan => ({ step: Number(label[0]) as SetupStepPlan['step'], label, kind: 'choose', title, found, willRun, needsSudo: false, keys: '↵ run · esc stop', skippable: false })
  const ask = async (row: SetupStepPlan): Promise<Awaited<ReturnType<SetupConsentFn>>> => { current = row.label; signal.throwIfAborted(); return consent(row) }
  const done = (reason: SetupSummary['reason'], words: string, ready?: SetupSummary['ready']): SetupEvent => ({ type: 'done', summary: { ran, skipped: [], failed: reason === 'ended' ? [current] : [], notDone: [], reason, words, ...(ready ? { ready, model: ready.model } : { kept: io.currentModel() ?? undefined }) } })
  const result = (label: SetupStepLabel, words: string): SetupEvent => { ran.push(label); return { type: 'result', result: { step: Number(label[0]) as SetupStepPlan['step'], label, kind: 'choose', outcome: 'ran', lastLine: words } } }
  try {
    let source = 'Hugging Face'
    if (!seam.repo) {
      const row = { ...plan('1', 'Local models', 'Choose where to get the model'), keys: choiceKeys, rows: [{ tag: 'Hugging Face', on: 'pull' as const, words: 'pull a GGUF by repository id' }, { tag: 'Bank', on: 'server' as const, words: 'use downloaded GGUF weights' }, { tag: 'Ollama / running server', on: 'server' as const, words: 'choose a server model or install Ollama' }] }
      yield { type: 'step', plan: row }
      const picked = pickOf(await ask(row))
      if (!picked) { yield done('stopped', ''); return }
      if (!row.rows.some(row => row.tag === picked)) throw new Error('Choose a model source from the list.')
      source = picked
      yield result('1', source)
      if (source === 'Ollama / running server') { yield* runSetupRoad(consent, seam); return }
    }
    let folder = bankFolder() ?? join(io.home, 'mercury-model-bank')
    let model: GgufModel
    if (source === 'Bank') {
      const recipes = bankedHostRecipes(folder).filter(row => row.engine === 'llamacpp' && row.weightFile && bankState(row, folder).banked)
      if (!recipes.length) throw new Error('No GGUF models in the Bank. Choose Hugging Face to pull one.')
      const models: GgufModel[] = []
      for (const recipe of recipes) models.push(await bankGgufModel(recipe, folder, io.totalMemoryBytes, io.platform, signal))
      const row = { ...plan('4', 'Bank', folder), keys: choiceKeys, rows: models.map(model => ({ tag: model.recipe.model + '/' + model.recipe.weightFile, on: 'server' as const, words: model.words })) }
      yield { type: 'step', plan: row }
      const picked = pickOf(await ask(row))
      if (!picked) { yield done('stopped', ''); return }
      const selected = models.find(model => model.recipe.model + '/' + model.recipe.weightFile === picked)
      if (!selected) throw new Error('Choose a model from the Bank list.')
      model = selected
      yield result('4', model.recipe.label)
    } else {
      let repo = seam.repo
      if (!repo) {
        const row = { ...plan('2', 'Hugging Face', 'Repository id'), input: 'author/model-GGUF', keys: 'type repository id · ↵ list files · esc keeps your model' }
        yield { type: 'step', plan: row }
        repo = pickOf(await ask(row))
        if (!repo) { yield done('stopped', ''); return }
        yield result('2', repo)
      }
      const listing = await listGgufModels(repo, { base: seam.hubBase ?? huggingFaceHubBase(), token: huggingFaceToken(), signal, machineBytes: io.totalMemoryBytes, platform: io.platform })
      const row = { ...plan('4', 'GGUF files', repo), keys: choiceKeys, rows: listing.models.map(model => ({ tag: model.recipe.weightFile!, on: 'pull' as const, words: model.words })) }
      yield { type: 'step', plan: row }
      const picked = pickOf(await ask(row))
      if (!picked) { yield done('stopped', ''); return }
      const selected = listing.models.find(model => model.recipe.weightFile === picked)
      if (!selected) throw new Error('Choose a GGUF file from the list.')
      model = selected
      yield result('4', model.recipe.weightFile!)
      if (listing.projectors.length > 1) {
        const row = { ...plan('4', 'Vision projector', repo), keys: choiceKeys, rows: listing.projectors.map(file => ({ tag: file.path, on: 'pull' as const, words: bytesWords(file.size) })) }
        yield { type: 'step', plan: row }
        const picked = pickOf(await ask(row))
        if (!picked) { yield done('stopped', ''); return }
        const file = listing.projectors.find(file => file.path === picked)
        if (!file) throw new Error('Choose a vision projector from the list.')
        model = ggufModelRow(withProjector(model.recipe, file), model.header, io.totalMemoryBytes, io.platform)
        yield result('4', file.path)
      }
    }
    if (model.error || !model.fit?.fits) throw new Error(model.error ?? 'This file does not fit in memory.')
    const spec = await ggufServerPlan(model, folder, seam)
    const banked = bankState(model.recipe, folder).banked
    if (!banked) {
      const free = bankFree(folder)
      if (free !== undefined && free < model.recipe.weightsGb * 1e9) throw new Error(bytesWords(free) + ' free in the Bank · ' + bytesWords(model.recipe.weightsGb * 1e9) + ' needed.')
      const row = plan('4b', 'Pull into the Bank', bytesWords(model.recipe.weightsGb * 1e9) + ' · ' + (model.recipe.mmproj ? 'model + vision projector · ' : '') + folder, 'download ' + model.recipe.model + ' → ' + bankModelPath(folder, model.recipe))
      yield { type: 'step', plan: row }
      if (await ask(row) !== 'run') { yield done('stopped', ''); return }
      signal.throwIfAborted()
      folder = rememberBankFolder(folder)
      yield* streamed<SetupEvent, unknown>(emit => pullIntoBank(model.recipe, folder, { signal, token: huggingFaceToken(), runner: seam.bankRunner, hashProgress: () => {}, progress: line => emit({ type: 'progress', step: 4, label: '4b', line }) }))
      yield result('4b', bytesWords(model.recipe.weightsGb * 1e9) + ' · ' + folder)
    }
    const row = plan('5', 'Start llama-server', model.fit.words, [spec.command, ...spec.args].map(shQuote).join(' '))
    yield { type: 'step', plan: row }
    if (await ask(row) !== 'run') { yield done('stopped', ''); return }
    await verifyBank(model.recipe, folder, signal)
    model = await bankGgufModel(model.recipe, folder, io.totalMemoryBytes, io.platform, signal)
    if (!model.fit?.fits) throw new Error(model.error ?? 'This file does not fit in memory.')
    started = await startGgufServer(model, spec, seam)
    yield result('5', 'local/' + ggufModelName(model.recipe) + ' · ' + started.root)
    const use = plan('6', 'Use this model', 'local/' + ggufModelName(model.recipe), 'reply with the single word ready')
    yield { type: 'step', plan: use }
    if (await ask(use) !== 'run') { yield done('stopped', ''); return }
    const ready = await pickAndProve(ggufModelName(model.recipe), { ...seam, signal, pickAfterReply: true, env: { ...io.env, MERCURY_LOCAL_PROBE_TARGETS: 'llamacpp=' + started.root }, root: started.root, server: 'llamacpp' })
    if (!ready.ok || ['refused', 'unavailable'].includes(ready.settled)) throw new Error(ready.fault ?? ready.settledDetail ?? ready.words)
    io.writeWindow(ready.wireId, model.fit.window)
    keptServer = true
    yield result('6', ready.firstLine)
    yield done('finished', ready.words, { ...ready, window: model.fit.window })
  } catch (error) {
    if (signal.aborted) yield done('stopped', '')
    else yield done('ended', error instanceof Error ? error.message : String(error))
  } finally { if (started && !keptServer) await started.stop() }
}
