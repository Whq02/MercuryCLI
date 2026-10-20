import type { LlmHostRoad } from '../llmHost/index.js'
import { BOX_RECIPES, boxFitWords, boxWeightsWords, fitsBox } from './boxRecipes.js'
import { boxAbsolutePath, boxJoin } from './boxExecution.js'
import { boxEngineLogs, boxEngineStatus, restartBoxEngine, startBoxEngine, stopBoxEngine } from './boxEngine.js'
import { boxServiceLifetimeWords, readBoxService } from './boxService.js'
import { registerBoxServer, stopBoxTunnel } from './boxRegistration.js'
import { boxHardwareWords, discoverBox, listBoxes, readBox, type HostBox } from './boxes.js'
import { hostRunner, localKeyPath, type HostRunner } from './ssh.js'

export function createBoxRoad(runner: HostRunner = hostRunner): LlmHostRoad {
  return async (ask, emit, signal) => {
    const stopped = { ok: false, words: 'No computer changed.' }
    const question: Parameters<LlmHostRoad>[0] = plan => signal.aborted ? Promise.resolve(null) : ask(plan)
    try {
      const selected = await question({ step: 'boxes', title: 'One of my computers', found: 'Saved computers share their model with every Mercury session.', willRun: 'Read hardware, installed engines and model bank folders. No service starts yet.', rows: [{ value: 'this-computer', label: 'This computer' }, ...listBoxes().filter(box => box.name !== 'this-computer').map(box => ({ value: box.name, label: box.name + ' · ' + boxHardwareWords(box) })), { value: '__add__', label: 'Add a box over SSH' }] })
      if (!selected) return stopped
      let box: HostBox
      if (selected === '__add__') {
        const name = await question({ step: 'box-name', title: 'Name this computer', found: '1–28 lowercase letters, digits or hyphens', willRun: 'Save as a reusable computer.' }); if (!name) return stopped
        const host = await question({ step: 'ssh-host', title: 'SSH host or config alias', found: 'Use a host or an existing SSH config alias.', willRun: '' }); if (!host) return stopped
        const user = await question({ step: 'ssh-user', title: 'SSH user (blank uses SSH config)', found: host, willRun: '' }); if (user === null) return stopped
        const port = await question({ step: 'ssh-port', title: 'SSH port (blank uses SSH config)', found: host, willRun: '' }); if (port === null) return stopped
        const key = await question({ step: 'ssh-key', title: 'Private key path (blank uses SSH config or agent)', found: 'The private key stays here.', willRun: '' }); if (key === null) return stopped
        const os = await question({ step: 'box-os', title: 'Operating system on this computer', found: host, willRun: 'Windows uses PowerShell over SSH.', rows: [{ value: 'darwin', label: 'macOS' }, { value: 'linux', label: 'Linux' }, { value: 'windows', label: 'Windows' }] }); if (!os) return stopped
        if (!['darwin', 'linux', 'windows'].includes(os)) throw new Error('Choose a listed operating system.')
        box = await discoverBox({ name: name.trim(), kind: 'ssh', os: os as HostBox['os'], target: { host: host.trim(), ...(user.trim() ? { user: user.trim() } : {}), ...(port.trim() ? { port: Number(port) } : {}), key: localKeyPath(key.trim()) } }, runner, signal)
      } else {
        const saved = readBox(selected)
        if (!saved && selected !== 'this-computer') throw new Error('That computer is no longer saved.')
        box = await discoverBox(saved ?? { name: 'this-computer', kind: 'this-computer' }, runner, signal)
      }
      emit({ title: box.name, words: boxHardwareWords(box) })
      for (;;) {
        const status = await boxEngineStatus(box, runner, signal)
        const installed = status.record && status.record.state !== 'uninstalled'
        const action = await question({ step: 'box-controls', title: 'Computer · ' + box.name, found: status.words, willRun: 'Your engine is private to this box. Closing keeps the service running.', rows: [...(installed ? [{ value: 'restart', label: status.record!.state === 'stopped' ? 'Start the saved service' : 'Restart the service' }, ...(status.record!.state === 'stopped' ? [] : [{ value: 'stop', label: 'Stop the service' }]), { value: 'logs', label: 'Read engine logs' }, { value: 'uninstall', label: 'Uninstall the service · keep weights' }] : []), { value: 'model', label: installed ? 'Choose another model' : 'Choose a model' }, { value: 'refresh', label: 'Refresh engine status' }, { value: 'close', label: 'Close' }] })
        if (!action || action === 'close') return { ok: true, words: status.words }
        if (action === 'refresh') continue
        if (action === 'logs') { const log = await boxEngineLogs(box, runner, signal); await question({ step: 'box-logs', title: 'Engine logs · ' + box.name, found: log.split('\n').filter(Boolean).slice(-3).join(' · ') || 'No log output yet.', willRun: 'mercury host logs ' + box.name + ' prints the last 100 lines.', rows: [{ value: 'back', label: 'Back to this computer' }] }); continue }
        if (['stop', 'restart', 'uninstall'].includes(action)) {
          const confirm = await question({ step: 'box-action-confirm', title: 'Confirm ' + action, found: box.name + ' · ' + status.record?.model, willRun: action === 'uninstall' ? 'Remove only Mercury’s service files. Model weights and the computer record remain.' : action === 'stop' ? 'Stop the engine and its tunnel. Sessions using it cannot send until it starts again.' : 'Restart the engine and verify its model before reconnecting.', rows: [{ value: action, label: 'Confirm ' + action }, { value: 'cancel', label: 'Keep things as they are' }] })
          if (confirm !== action) continue
          if (action === 'restart') { await restartBoxEngine(box, runner, signal); await registerBoxServer(box, runner, signal) }
          else { await stopBoxEngine(box, runner, signal, action === 'uninstall'); await stopBoxTunnel(box, runner, signal, action === 'uninstall') }
          continue
        }
        if (action !== 'model') throw new Error('Choose one of the listed computer controls.')
        let selectedRecipe: string | null
        for (;;) {
          selectedRecipe = await question({ step: 'box-recipes', title: 'Choose a model for ' + box.name, found: boxHardwareWords(box), willRun: 'Weights fit is not a speed or context guarantee. The engine must load and report its served window.', rows: [...BOX_RECIPES.map(recipe => ({ value: recipe.id, label: recipe.label + ' · ' + recipe.verified.by + ' · ' + boxFitWords(recipe, box) })), { value: 'back', label: 'Back to this computer' }] })
          if (!selectedRecipe || selectedRecipe === 'back') break
          const recipe = BOX_RECIPES.find(row => row.id === selectedRecipe)
          if (!recipe) throw new Error('Choose a listed recipe.')
          if (fitsBox(recipe, box)) break
          emit({ title: recipe.label, words: boxFitWords(recipe, box) })
        }
        if (!selectedRecipe || selectedRecipe === 'back') continue
        const recipe = BOX_RECIPES.find(row => row.id === selectedRecipe)!
        const source = await question({ step: 'box-weights', title: 'Where are the weights?', found: recipe.label + ' · ~' + recipe.downloadGb + ' GB', willRun: 'Paths belong to ' + box.name + ', not the screen running Mercury.', rows: [{ value: 'bank', label: 'Use a verified bank folder · no download' }, { value: 'download', label: 'Download to a folder I choose' }, { value: 'back', label: 'Back to this computer' }] })
        if (!source || source === 'back') continue
        if (!['bank', 'download'].includes(source)) throw new Error('Choose bank or download.')
        const path = await question({ step: 'box-bank', title: source === 'bank' ? 'Verified bank folder on ' + box.name : 'Download folder on ' + box.name, found: box.bankPaths.join(' · ') || 'No bank folder discovered.', willRun: source === 'bank' ? 'SHA256SUMS must cover the selected model; every required file is checked.' : '~' + recipe.downloadGb + ' GB of weights; the next screen confirms before downloading.', initial: box.bankPaths[0] ?? boxJoin(box, box.home, 'mercury-model-bank', recipe.id) })
        if (!path) continue
        const destination = boxAbsolutePath(box, path.trim())
        const confirm = await question({ step: 'box-start-confirm', fullDetails: true, title: 'Confirm model service', found: boxWeightsWords(recipe, destination, source === 'bank'), willRun: 'Install/start ' + recipe.engine + ' · ' + boxServiceLifetimeWords(box) + ' · ' + recipe.verified.by + ' · ' + (recipe.verified.note ?? '') + ' · ' + recipe.verified.source, rows: [{ value: 'start', label: 'Confirm installation and start' }, { value: 'cancel', label: 'Keep things as they are' }] })
        if (confirm !== 'start') continue
        emit({ title: 'Preparing ' + box.name, words: 'Installing engine, checking weights and starting service · closing stops waiting, not an installed service.' })
        await startBoxEngine(box, recipe, { destination, bank: source === 'bank', confirmed: true, runner, signal, port: readBoxService(box.name)?.port })
        const model = await registerBoxServer(box, runner, signal)
        emit({ title: 'Model ready', words: model + ' · available in /model in every session' })
      }
    } catch (error) { return { ok: false, words: signal.aborted ? 'Setup closed; an installed service may still run. mercury host status lists it.' : String(error) } }
  }
}
