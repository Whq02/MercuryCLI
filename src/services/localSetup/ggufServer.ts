import { createServer } from 'node:net'
import { freemem } from 'node:os'
import { join } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { bankModelPath } from '../host/bank.js'
import { gibWords } from '../localServer/localServerMemory.js'
import { startService, stopService, waitForReady } from '../projectServices/serviceManager.js'
import type { ServiceSpec } from '../projectServices/contracts.js'
import { probeLlamaCpp } from '../providers/local/localDiscovery.js'
import { ggufModelName, type GgufModel } from './ggufModels.js'
import { forgetGgufServer, rememberGgufServer } from './ggufServers.js'
import { resolveSetupIo } from './setupIo.js'
import type { SetupIo } from './setupTypes.js'

export interface GgufServerIo extends SetupIo { cwd?: string; port?: number; serverCommand?: string; serverArgs?: string[]; availableMemory?: () => Promise<number> }
async function llamaBinary(seam: GgufServerIo = {}): Promise<string> {
  if (seam.serverCommand) return seam.serverCommand
  const io = resolveSetupIo(seam)
  const built = join(io.home, '.local', 'share', 'mercury-host', 'runtime', 'llama.cpp', 'build', 'bin', io.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
  if (io.exists(built)) return built
  const path = await io.which('llama-server')
  if (path) return path
  if (io.platform === 'darwin') for (const path of ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server']) if (io.exists(path)) return path
  throw new Error('Install llama.cpp, then open /localsetup again. On macOS: brew install llama.cpp.')
}
async function availableGgufMemory(seam: GgufServerIo): Promise<number> {
  if (seam.availableMemory) return seam.availableMemory()
  const io = resolveSetupIo(seam)
  if (io.platform === 'darwin') {
    const result = await io.exec('/usr/bin/vm_stat', [], { timeoutMs: 5000 })
    const page = Number(/page size of (\d+) bytes/.exec(result.stdout)?.[1])
    const counts = ['free', 'inactive', 'speculative'].map(name => Number(new RegExp('Pages ' + name + ':\\s+(\\d+)').exec(result.stdout)?.[1]))
    if (result.rc !== 0 || !page || counts.some(value => !Number.isFinite(value))) throw new Error('Cannot read available memory; try /localsetup again.')
    return counts.reduce((sum, value) => sum + value, 0) * page
  }
  return freemem()
}
export async function ggufServerPlan(model: GgufModel, folder: string, seam: GgufServerIo): Promise<ServiceSpec> {
  if (!model.fit?.fits) throw new Error(model.error ?? 'This model does not fit. Choose another file or free memory.')
  const directory = bankModelPath(folder, model.recipe)
  const port = seam.port ?? 8080
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port from 1024 to 65535.')
  return { name: 'local-gguf', command: await llamaBinary(seam), args: [...(seam.serverArgs ?? []), '--model', join(directory, model.recipe.weightFile!), ...(model.recipe.mmproj ? ['--mmproj', join(directory, model.recipe.mmproj)] : []), '--alias', ggufModelName(model.recipe), '--host', '127.0.0.1', '--port', String(port), '--jinja', ...(model.recipe.chatTemplateFile ? ['--chat-template-file', join(directory, model.recipe.chatTemplateFile)] : []), ...(model.header?.tensors.some(name => /\.nextn\.eh_proj\.weight$/.test(name)) ? ['--spec-type', 'draft-mtp'] : []), '--n-gpu-layers', 'all', '--ctx-size', String(model.fit.window), '--parallel', '1', '--flash-attn', 'on', '--cache-type-k', 'f16', '--cache-type-v', 'f16'], cwd: seam.cwd ?? getCwd(), lifecycle: 'project', readiness: [{ kind: 'http', url: 'http://127.0.0.1:' + port + '/health' }], readinessMode: 'all', restart: 'never' }
}
async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error('Port ' + port + ' is in use. Stop its server before loading this model.')))
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()))
  })
}
export async function startGgufServer(model: GgufModel, spec: ServiceSpec, seam: GgufServerIo): Promise<{ root: string; stop: () => Promise<void> }> {
  const io = resolveSetupIo(seam)
  io.signal?.throwIfAborted()
  const available = await availableGgufMemory(seam)
  if (available < model.fit!.totalBytes) throw new Error(gibWords(model.fit!.totalBytes) + ' needed · ' + gibWords(available) + ' available. Free memory, then retry.')
  const port = Number(spec.args[spec.args.indexOf('--port') + 1])
  await requireFreePort(port)
  io.signal?.throwIfAborted()
  const started = await startService({ spec, sessionId: getSessionId() })
  if ('error' in started) throw new Error(started.error)
  const root = 'http://127.0.0.1:' + port
  const stop = async (): Promise<void> => {
    const stopped = await stopService(spec.cwd, spec.name)
    if ('error' in stopped || stopped.note) throw new Error('Stop ' + spec.name + ' with Service: ' + ('error' in stopped ? stopped.error : stopped.note))
    forgetGgufServer(root)
  }
  try {
    const deadline = io.now() + (seam.startWaitMs ?? 10 * 60_000)
    for (;;) {
      io.signal?.throwIfAborted()
      const ready = await waitForReady(spec.cwd, spec.name, 500)
      if (ready.ready) break
      if (!ready.record || ['failed', 'stopped'].includes(ready.record.state)) throw new Error('llama-server exited. Open Service logs for ' + spec.name + '.')
      if (io.now() >= deadline) throw new Error('llama-server has not loaded the model. Open Service logs for ' + spec.name + '.')
    }
    const server = await probeLlamaCpp(root, { fetchImpl: io.fetchImpl, signal: io.signal })
    const served = server?.models.find(row => row.id === ggufModelName(model.recipe))
    if (served?.contextWindow?.source !== 'served' || served.contextWindow.tokens !== model.fit!.window) throw new Error('llama-server did not serve the selected model and context.')
    rememberGgufServer(root)
    return { root, stop }
  } catch (error) { await stop(); throw error }
}
