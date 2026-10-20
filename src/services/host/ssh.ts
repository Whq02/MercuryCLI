import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { hostDirectory } from './store.js'
import { recipeFits, type HostRecipe } from './recipes.js'

export interface SshTarget { host: string; user?: string; key?: string; port?: number }
export interface HostRunner {
  run(command: string, args: string[], signal: AbortSignal, timeoutMs?: number): Promise<string>
  tunnel(args: string[]): { stop(): void; failed(): string | undefined }
}
const tunnels = new Map<string, ReturnType<HostRunner['tunnel']>>()
const children = new Set<ChildProcess>()
process.once('exit', () => { for (const child of children) child.kill() })
export const hostRunner: HostRunner = {
  run(command, args, signal, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Stopped')); return }
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      children.add(child)
      let output = ''
      let settled = false
      const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); children.delete(child); if (error) reject(error); else resolve(output) }
      const abort = (): void => { child.kill(); finish(new Error('Stopped')) }
      const timer = setTimeout(() => { child.kill(); finish(new Error(command + ' timed out. ' + output.slice(-2000))) }, timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', data => { output = (output + String(data)).slice(-12000) })
      child.stderr.on('data', data => { output = (output + String(data)).slice(-12000) })
      child.on('error', error => finish(error))
      child.on('exit', code => finish(code === 0 ? undefined : new Error(command + ' exited ' + code + '. ' + output.slice(-2000))))
    })
  },
  tunnel(args) {
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    children.add(child)
    let failure: string | undefined
    let tail = ''
    child.stderr.on('data', data => { tail = (tail + String(data)).slice(-2000) })
    child.on('error', error => { failure = error.message; children.delete(child) })
    child.on('exit', code => { failure = 'SSH tunnel exited ' + code + '. ' + tail; children.delete(child) })
    return { stop: () => { child.kill(); children.delete(child) }, failed: () => failure }
  },
}
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
export function sshArguments(target: SshTarget): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]*$/.test(target.host) || target.user && !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(target.user)) throw new Error('Give a host or SSH config alias, and a separate user; not a command or URL.')
  if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) throw new Error('SSH port must be 1–65535.')
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + join(hostDirectory(), 'known_hosts'), ...(target.key ? ['-i', target.key] : []), ...(target.port ? ['-p', String(target.port)] : []), ...(target.user ? ['-l', target.user] : []), target.host]
}
export function sshAliases(): string[] {
  try { return [...readFileSync(join(homedir(), '.ssh/config'), 'utf8').matchAll(/^\s*Host\s+([^#\n]+)/gmi)].flatMap(match => match[1]!.trim().split(/\s+/)).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) } catch { return [] }
}
export function localKeyPath(value: string): string | undefined {
  if (!value.trim()) return undefined
  const path = value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(value)
  if (!existsSync(path)) throw new Error('SSH key not found: ' + path)
  return path
}
export async function ensureHostKey(runner: HostRunner, signal: AbortSignal): Promise<{ path: string; publicKey: string }> {
  const dir = join(hostDirectory(), 'keys')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'id_ed25519')
  if (!existsSync(path)) await runner.run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'mercury-host', '-f', path], signal)
  chmodSync(path, 0o600)
  const publicKey = (await runner.run('ssh-keygen', ['-y', '-f', path], signal)).trim()
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: |$)/.test(publicKey)) throw new Error('Could not read the host SSH public key.')
  return { path, publicKey }
}
export async function inspectSsh(target: SshTarget, runner: HostRunner, signal: AbortSignal): Promise<{ gpus: { name: string; memory: number }[]; docker: boolean }> {
  const output = await runner.run('ssh', [...sshArguments(target), 'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits && if command -v docker >/dev/null && docker info >/dev/null 2>&1; then echo MERCURY_DOCKER; fi'], signal)
  const gpus = output.split('\n').flatMap(line => { const match = /^(.+),\s*([0-9.]+)\s*$/.exec(line); return match ? [{ name: match[1]!.trim(), memory: Math.ceil(Number(match[2]) / 1024) }] : [] })
  if (!gpus.length) throw new Error('nvidia-smi did not report a GPU. Check the SSH user and NVIDIA driver.')
  return { gpus, docker: output.includes('MERCURY_DOCKER') }
}
export function fitsSsh(recipe: HostRecipe, gpus: { name: string; memory: number }[]): boolean { return gpus.filter(gpu => recipeFits(recipe, gpu.name, gpu.memory, recipe.count)).length >= recipe.count }
export async function startHostEngine(target: SshTarget, recipe: HostRecipe, runner: HostRunner, signal: AbortSignal, docker: boolean, pod: boolean, bank?: string): Promise<void> {
  if (!pod && !docker && !recipe.pythonInstall) throw new Error('This recipe requires its preview Docker image. Install Docker with NVIDIA GPU access, or choose another recipe.')
  const dir = '/workspace/mercury-host/' + recipe.id
  const args = sshArguments(target)
  await runner.run('ssh', [...args, 'set -e; mkdir -p ' + quote(dir) + '; if ! command -v tmux >/dev/null || ! command -v curl >/dev/null; then if test "$(id -u)" = 0 && command -v apt-get >/dev/null; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y tmux curl; else echo "Install tmux and curl and make /workspace writable for this SSH user." >&2; exit 1; fi; fi'], signal, 300_000)
  if (bank) {
    const local = resolve(bank)
    if (recipe.weightFile) {
      const first = join(local, recipe.weightFile)
      const parts = /-00001-of-(\d+)\.gguf$/.exec(first)
      if (!parts || !existsSync(first)) throw new Error('The bank folder must contain the selected GGUF quant and all its shards.')
      for (let part = 1; part <= Number(parts[1]); part++) if (!existsSync(first.replace('-00001-of-', '-' + String(part).padStart(5, '0') + '-of-'))) throw new Error('A GGUF shard is missing from the bank folder.')
    } else {
      const config = JSON.parse(readFileSync(join(local, 'config.json'), 'utf8')) as { _name_or_path?: string }
      if (config._name_or_path?.includes('/') && config._name_or_path !== recipe.model) throw new Error('The bank config names another model: ' + config._name_or_path)
      const index = JSON.parse(readFileSync(join(local, 'model.safetensors.index.json'), 'utf8')) as { weight_map: Record<string, string> }
      for (const file of new Set(Object.values(index.weight_map))) if (!/^[a-zA-Z0-9_.-]+$/.test(file) || !existsSync(join(local, file)) || statSync(join(local, file)).size === 0) throw new Error('A weight shard is missing from the bank folder.')
    }
    await runner.run('ssh', [...args, 'mkdir -p ' + quote(dir + '/weights')], signal)
    const remote = (target.user ? target.user + '@' : '') + target.host + ':' + dir + '/weights/'
    const transport = ['ssh', ...args.slice(0, -1)].map(quote).join(' ')
    await runner.run('rsync', ['-a', '-e', transport, '--', local + '/', remote], signal, 12 * 3600_000)
  }
  for (const [file, content] of Object.entries(recipe.files ?? {})) await runner.run('ssh', [...args, 'printf %s ' + quote(content) + ' > ' + quote(dir + '/' + file)], signal)
  const engine = (recipe.engine === 'llamacpp'
    ? ['/workspace/mercury-host/llama.cpp/build/bin/llama-server', '--model', dir + '/weights/' + recipe.weightFile, '--alias', recipe.model + ':' + recipe.weightFile!.split('/')[0], ...recipe.flags, '--host', '127.0.0.1', '--port', '30000']
    : ['sglang', 'serve', '--model-path', bank ? dir + '/weights' : recipe.model, ...recipe.flags, '--host', '127.0.0.1', '--port', '30000']).map(quote).join(' ')
  const download = bank ? 'true' : recipe.engine === 'llamacpp' ? '/workspace/mercury-host/hf/bin/hf download ' + quote(recipe.model) + ' --include ' + quote(recipe.include!) + ' --local-dir ' + quote(dir + '/weights') : 'hf download ' + quote(recipe.model)
  let script = 'set -e; export HF_HOME=/workspace/huggingface; ' + Object.entries(recipe.environment ?? {}).map(([name, value]) => 'export ' + name + '=' + quote(value) + '; ').join('') + (recipe.install ? recipe.install + ' && ' : '') + download + ' && exec ' + engine
  if (docker && !pod) script = 'exec docker run --rm --gpus all --ipc=host --network=host -v /workspace:/workspace -e HF_HOME=/workspace/huggingface --entrypoint bash ' + quote(recipe.image) + ' -lc ' + quote(script)
  else if (!pod) script = 'set -e; ' + recipe.pythonInstall + ' && export PATH=/workspace/mercury-host/venv/bin:$PATH && ' + script
  const job = 'mercury-' + recipe.id
  const remote = 'set -e; if tmux has-session -t ' + quote(job) + ' 2>/dev/null; then echo "An engine job already exists: ' + job + '"; exit 1; fi; tmux new-session -d -s ' + quote(job) + ' ' + quote('bash -lc ' + quote(script + ' > ' + quote(dir + '/engine.log') + ' 2>&1'))
  await runner.run('ssh', [...args, remote], signal)
}
export async function waitHostEngine(target: SshTarget, recipe: HostRecipe, runner: HostRunner, signal: AbortSignal, pauseMs = 5000, timeoutMs = 90 * 60_000): Promise<void> {
  const started = Date.now()
  let last = ''
  while (!signal.aborted && Date.now() - started < timeoutMs) {
    try { await runner.run('ssh', [...sshArguments(target), 'curl -fsS --max-time 10 http://127.0.0.1:30000/health && curl -fsS --max-time 10 http://127.0.0.1:30000/v1/models'], signal); return } catch (error) { last = String(error) }
    const log = await runner.run('ssh', [...sshArguments(target), 'tail -n 8 ' + quote('/workspace/mercury-host/' + recipe.id + '/engine.log') + '; tmux has-session -t ' + quote('mercury-' + recipe.id)], signal).catch(error => { throw new Error('The engine stopped. ' + String(error)) })
    last = log || last
    await delay(pauseMs, undefined, { signal })
  }
  throw new Error('Engine not ready. ' + last)
}
export async function openHostTunnel(id: string, target: SshTarget, runner: HostRunner, signal: AbortSignal): Promise<number> {
  const port = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; server.close(() => resolve(port)) }) })
  const args = sshArguments(target)
  const tunnel = runner.tunnel(['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-L', '127.0.0.1:' + port + ':127.0.0.1:30000', ...args])
  try {
    for (let n = 0; n < 100; n++) {
      signal.throwIfAborted()
      const failed = tunnel.failed(); if (failed) throw new Error(failed)
      try { const response = await fetch('http://127.0.0.1:' + port + '/v1/models', { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: 'error' }); if (response.ok) { tunnels.get(id)?.stop(); tunnels.set(id, tunnel); return port } } catch {}
      await delay(100, undefined, { signal })
    }
    throw new Error('The SSH tunnel did not answer on local port ' + port)
  } catch (error) { tunnel.stop(); throw error }
}
export function closeHostTunnel(id: string): void { tunnels.get(id)?.stop(); tunnels.delete(id) }
