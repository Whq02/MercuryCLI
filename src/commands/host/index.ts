import { parseArgs } from 'node:util'
import { registerBoxServer, stopBoxTunnel } from '../../services/host/boxRegistration.js'
import { discoverBox, listBoxes, readBox, type HostBox } from '../../services/host/boxes.js'
import { BOX_RECIPES, boxFitWords, boxWeightsWords, fitsBox } from '../../services/host/boxRecipes.js'
import { boxEngineLogs, boxEngineStatus, restartBoxEngine, startBoxEngine, stopBoxEngine } from '../../services/host/boxEngine.js'
import { boxServiceLifetimeWords } from '../../services/host/boxService.js'
import { hostRunner, localKeyPath, type HostRunner } from '../../services/host/ssh.js'

export const HOST_HELP = 'Usage: mercury host start <box|this-computer> <recipe> (--bank <folder> | --download <folder>) [--yes]\n       mercury host add <name> --ssh <host> --os darwin|linux|windows [--user <user>] [--port <port>] [--key <path>]\n       mercury host status [box]\n       mercury host stop|restart|logs|uninstall <box>\n       mercury host recipes [box]\n\nBank paths belong to the selected computer. Without --yes, start prints the size and destination only. Uninstall removes the service, never weights. A service runs while you are logged in on that computer and returns at login after a reboot; on Linux, loginctl enable-linger keeps it running without a login.\n'
export async function hostCommand(args: string[], options: { runner?: HostRunner; signal?: AbortSignal; print?: (text: string) => void } = {}): Promise<number> {
  const print = options.print ?? console.log
  const runner = options.runner ?? hostRunner
  const signal = options.signal ?? new AbortController().signal
  try {
    const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { bank: { type: 'string' }, download: { type: 'string' }, yes: { type: 'boolean' }, ssh: { type: 'string' }, user: { type: 'string' }, port: { type: 'string' }, key: { type: 'string' }, os: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
    const [action, name, recipeId, ...extra] = parsed.positionals
    const value = parsed.values
    if (!action || value.help) { print(HOST_HELP); return 0 }
    if (extra.length || !['start', 'add', 'status', 'stop', 'restart', 'logs', 'uninstall', 'recipes'].includes(action)) throw new Error(HOST_HELP)
    if (action !== 'start' && recipeId) throw new Error('Unexpected argument: ' + recipeId)
    if (action === 'add') {
      if (!name || !value.ssh || !['darwin', 'linux', 'windows'].includes(value.os ?? '')) throw new Error('host add needs a name, --ssh host and --os darwin|linux|windows.')
      const box = await discoverBox({ name, kind: 'ssh', os: value.os as HostBox['os'], target: { host: value.ssh, user: value.user, key: value.key ? localKeyPath(value.key) : undefined, port: value.port ? Number(value.port) : undefined } }, runner, signal)
      print('Saved computer ' + box.name); return 0
    }
    if (action === 'recipes') {
      const box = name ? readBox(name) : undefined
      if (name && !box) throw new Error('Unknown computer: ' + name)
      for (const recipe of BOX_RECIPES) print(recipe.id + ' · ' + recipe.label + ' · ' + recipe.verified.by + (box ? ' · ' + boxFitWords(recipe, box) : ' · needs ' + recipe.memoryGb + ' GB'))
      return 0
    }
    if (action === 'status' && !name) { for (const box of listBoxes()) { try { print((await boxEngineStatus(box, runner, signal)).words) } catch (error) { print(box.name + ' · status unavailable · ' + String(error)) } } return 0 }
    if (!name) throw new Error('Name a saved computer or this-computer.')
    const box = readBox(name) ?? (name === 'this-computer' ? await discoverBox({ name, kind: 'this-computer' }, runner, signal) : undefined)
    if (!box) throw new Error('Unknown computer: ' + name + ' · mercury host add or /llmhost → One of my computers')
    if (action === 'start') {
      const recipe = BOX_RECIPES.find(row => row.id === recipeId)
      if (!recipe) throw new Error('Choose a recipe from mercury host recipes ' + name)
      if (!fitsBox(recipe, box)) throw new Error(boxFitWords(recipe, box))
      if (Boolean(value.bank) === Boolean(value.download)) throw new Error('Choose exactly one of --bank <verified folder> or --download <destination>.')
      const destination = (value.bank ?? value.download)!
      print(boxWeightsWords(recipe, destination, Boolean(value.bank)))
      print('Install/start ' + recipe.engine + ' as a private loopback service; it ' + boxServiceLifetimeWords(box) + '.')
      if (!value.yes) { print('Add --yes to confirm this plan. No service changed.'); return 0 }
      await startBoxEngine(box, recipe, { destination, bank: Boolean(value.bank), confirmed: true, runner, signal })
    } else if (action === 'stop' || action === 'uninstall') {
      await stopBoxEngine(box, runner, signal, action === 'uninstall')
      await stopBoxTunnel(box, runner, signal, action === 'uninstall')
      print(action === 'uninstall' ? 'Service uninstalled; weights kept.' : 'Engine stopped.'); return 0
    } else if (action === 'restart') await restartBoxEngine(box, runner, signal)
    else if (action === 'logs') { print(await boxEngineLogs(box, runner, signal)); return 0 }
    if (action === 'start' || action === 'restart') print(await registerBoxServer(box, runner, signal) + ' · available in /model in every session')
    print((await boxEngineStatus(box, runner, signal)).words)
    return 0
  } catch (error) { print(error instanceof Error ? error.message : String(error)); return 1 }
}
