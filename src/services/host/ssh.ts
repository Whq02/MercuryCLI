import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { hostDirectory } from './store.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { recipeFits, type HostRecipe } from './recipes.js'

import { downloadFailure, hostDownloadScript } from './download.js'
export interface SshTarget { host: string; user?: string; key?: string; port?: number }
export interface HostRunner {
  run(command: string, args: string[], signal: AbortSignal, timeoutMs?: number, env?: Record<string, string>): Promise<string>
  tunnel(args: string[]): { stop(): void; failed(): string | undefined }
}
const tunnels = new Map<string, ReturnType<HostRunner['tunnel']>>()
const children = new Set<ChildProcess>()
process.once('exit', () => { for (const child of children) child.kill() })
export const hostRunner: HostRunner = {
  run(command, args, signal, timeoutMs = 30_000, env) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Stopped')); return }
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: env ? { ...subprocessEnv(), ...env } : subprocessEnv() })
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
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: subprocessEnv() })
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
export async function inspectSsh(target: SshTarget, runner: HostRunner, signal: AbortSignal, boxOs?: 'darwin' | 'linux' | 'windows'): Promise<{ gpus: { name: string; memory: number }[]; docker: boolean; facts?: string }> {
  if (boxOs) {
    const facts = await inspectBoxMachine(target, boxOs, runner, signal)
    const gpus = facts.split('\n').flatMap(line => { const match = /^GPU (.+),\s*([0-9.]+)\s*$/.exec(line); return match ? [{ name: match[1]!.trim(), memory: Math.ceil(Number(match[2]) / 1024) }] : [] })
    return { facts, gpus, docker: facts.includes('DOCKER_ENGINE_PRESENT') }
  }
  const output = await runner.run('ssh', [...sshArguments(target), 'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits && if command -v docker >/dev/null && docker info >/dev/null 2>&1; then echo DOCKER_ENGINE_PRESENT; fi'], signal)
  const gpus = output.split('\n').flatMap(line => { const match = /^(.+),\s*([0-9.]+)\s*$/.exec(line); return match ? [{ name: match[1]!.trim(), memory: Math.ceil(Number(match[2]) / 1024) }] : [] })
  if (!gpus.length) throw new Error('nvidia-smi did not report a GPU. Check the SSH user and NVIDIA driver.')
  return { gpus, docker: output.includes('DOCKER_ENGINE_PRESENT') }
}
export function fitsSsh(recipe: HostRecipe, gpus: { name: string; memory: number }[]): boolean { return gpus.filter(gpu => recipeFits(recipe, gpu.name, gpu.memory, recipe.count)).length >= recipe.count }
function engineFailure(text: string, recipe: HostRecipe, exited = false): Error | undefined {
  if (/MERCURY_(STALL|PARTIAL) /.test(text)) return new Error(downloadFailure(text, recipe).words)
  const oom = /out of memory|OutOfMemoryError|\bOOM\b/i.test(text)
  if (!exited && !oom && !/failed to load (?:model|weights)|error loading model|CUDA error|CUDA_ERROR_/i.test(text)) return
  const tail = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('MERCURY_') && line !== 'launch.log:').slice(-8).join(' · ')
  return new Error('the engine died loading the weights: ' + (tail || 'the engine process exited') + (oom ? ' · the shape was too small for this quality; choose a larger GPU shape' : ''))
}
export async function startHostEngine(target: SshTarget, recipe: HostRecipe, runner: HostRunner, signal: AbortSignal, docker: boolean, pod: boolean, bank?: string, keptWeights?: string, cluster?: { nodes: number; rank: number; head: string; address: string }): Promise<void> {
  if (!pod && !docker && !recipe.pythonInstall) throw new Error('This recipe requires its preview Docker image. Install Docker with NVIDIA GPU access, or choose another recipe.')
  const dir = '/workspace/mercury-host/' + recipe.id
  const args = sshArguments(target)
  const launchLog = quote(dir + '/launch.log')
  const prepare = 'mkdir -p ' + quote(dir) + ' || exit 1; exec 2>' + launchLog + '; trap ' + quote('cat ' + launchLog) + ' EXIT; set -e; if ! command -v setsid >/dev/null || ! command -v curl >/dev/null; then if test "$(id -u)" = 0 && command -v apt-get >/dev/null; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y util-linux curl; else echo "Install setsid and curl and make /workspace writable for this SSH user." >&2; exit 1; fi; fi'
  try { await runner.run('ssh', [...args, prepare], signal, 300_000) } catch (error) { throw new Error('launch.log: ' + String(error)) }
  if (bank) {
    const local = resolve(bank)
    if (recipe.weightFile) {
      const first = join(local, recipe.weightFile)
      const parts = /-00001-of-(\d+)\.gguf$/.exec(first)
      if (!parts || !existsSync(first)) throw new Error('The bank folder must contain the selected GGUF quant and all its shards.')
      for (let part = 1; part <= Number(parts[1]); part++) if (!existsSync(first.replace('-00001-of-', '-' + String(part).padStart(5, '0') + '-of-'))) throw new Error('A GGUF shard is missing from the bank folder.')
      if (recipe.mmproj && (!existsSync(join(local, recipe.mmproj)) || statSync(join(local, recipe.mmproj)).size === 0)) throw new Error('The bank folder is missing the vision projector: ' + recipe.mmproj)
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
  const probe = 'if command -v llama-server >/dev/null 2>&1; then echo MERCURY_PREBUILT_ENGINE yes; fi'
  const prebuilt = recipe.engine === 'llamacpp' && /^MERCURY_PREBUILT_ENGINE yes$/m.test(await runner.run('ssh', [...args, docker && !pod ? 'docker run --rm --entrypoint bash ' + quote(recipe.image) + ' -c ' + quote(probe) : probe], signal, 300_000))
  const localWeights = Boolean(bank || keptWeights || recipe.weightsGb || cluster)
  const model = keptWeights ?? (localWeights ? dir + '/weights' : recipe.model)
  const distributed = cluster ? recipe.engine === 'vllm'
    ? ['--nnodes', String(cluster.nodes), '--node-rank', String(cluster.rank), '--master-addr', cluster.head, ...(cluster.rank > 0 ? ['--headless'] : [])]
    : ['--nnodes', String(cluster.nodes), '--node-rank', String(cluster.rank), '--dist-init-addr', cluster.head + ':20000'] : []
  const engine = (recipe.engine === 'llamacpp'
    ? [prebuilt ? 'llama-server' : '/workspace/mercury-host/llama.cpp/build/bin/llama-server', '--model', (keptWeights ?? dir + '/weights') + '/' + recipe.weightFile, ...(recipe.mmproj ? ['--mmproj', (keptWeights ?? dir + '/weights') + '/' + recipe.mmproj] : []), '--alias', recipe.model + ':' + posix.dirname(recipe.weightFile!), ...recipe.flags, '--host', '127.0.0.1', '--port', '30000']
    : [...(recipe.engine === 'vllm' ? ['vllm', 'serve', model] : ['sglang', 'serve', '--model-path', model]), ...(localWeights ? ['--served-model-name', recipe.model] : []), ...recipe.flags, ...distributed, '--host', '127.0.0.1', '--port', '30000']).map(quote).join(' ')
  const download = keptWeights ? "echo 'MERCURY_STEP weights kept · verified · download skipped'" : bank ? 'true' : recipe.engine === 'llamacpp' ? (prebuilt ? 'hf download ' : '/workspace/mercury-host/hf/bin/hf download ') + quote(recipe.model) + ' --include ' + [recipe.include!, ...(recipe.mmproj ? [recipe.mmproj] : [])].map(quote).join(' ') + ' --local-dir ' + quote(dir + '/weights') : 'hf download ' + quote(recipe.model) + (localWeights ? ' --local-dir ' + quote(dir + '/weights') : '')
  const guardedDownload = bank || keptWeights ? download : 'python3 -c ' + quote(hostDownloadScript(download, dir + '/weights', recipe))
  const install = prebuilt ? undefined : recipe.install?.replace(' && cmake ', " && echo 'MERCURY_STEP building llama.cpp' && cmake ")
  const imagePath = pod ? 'if test -r /proc/1/environ; then image_path="$(tr \'\\0\' \'\\n\' < /proc/1/environ | sed -n \'s/^PATH=//p\')"; if test -n "$image_path"; then export PATH="$image_path:$PATH"; fi; fi\n' : ''
  let script = 'set -e\n' + imagePath + 'export PATH=/usr/local/cuda/bin:$PATH CUDACXX=/usr/local/cuda/bin/nvcc\nexport HF_HOME=/workspace/huggingface\n' + Object.entries(recipe.environment ?? {}).map(([name, value]) => 'export ' + name + '=' + quote(value) + '\n').join('') + (prebuilt ? "echo 'MERCURY_STEP using prebuilt engine'\n" : "echo 'MERCURY_STEP installing'\n") + (install ? '( ' + install + ' )\n' : '') + "echo 'MERCURY_STEP downloading weights'\n" + guardedDownload + '\n' + "echo 'MERCURY_STEP starting engine'\n" + engine + '\nwait\n'
  if (cluster) {
    const network = 'export SGLANG_HOST_IP=' + quote(cluster.address) + '\nexport VLLM_HOST_IP=' + quote(cluster.address) + '\n' + 'export NCCL_SOCKET_IFNAME="$(ip -o -4 addr show | grep -F ' + quote(' ' + cluster.address + '/') + ' | awk ' + quote('{split($2,a,"@"); print a[1]; exit}') + ')"\ntest -n "$NCCL_SOCKET_IFNAME"\nexport GLOO_SOCKET_IFNAME="$NCCL_SOCKET_IFNAME"\n'
    script = 'set -e\n' + network + script
  }
  if (docker && !pod) script = 'docker run --rm --gpus all --ipc=host --network=host -v /workspace:/workspace -e HF_HOME=/workspace/huggingface --entrypoint bash ' + quote(recipe.image) + ' -c ' + quote(script) + '\nwait\n'
  else if (!pod) script = 'set -e\n' + recipe.pythonInstall + '\nexport PATH=/workspace/mercury-host/venv/bin:$PATH\n' + script
  const scriptPath = quote(dir + '/engine.sh')
  const pidPath = quote(dir + '/engine.pid')
  const match = quote('[b]ash ' + dir + '/engine.sh')
  const remote = 'mkdir -p ' + quote(dir) + ' || exit 1; exec 2>>' + launchLog + '; set -e; trap ' + quote('cat ' + launchLog) + ' EXIT; if test -s ' + pidPath + ' && kill -0 "$(cat ' + pidPath + ')" 2>/dev/null && pgrep -f -- ' + match + ' >/dev/null; then echo "Engine job already running"; exit 0; fi; printf %s ' + quote(script) + ' > ' + scriptPath + '; nohup setsid bash ' + scriptPath + ' > ' + quote(dir + '/engine.log') + ' 2>&1 < /dev/null & echo $! > ' + pidPath + '; sleep 5; if ! kill -0 "$(cat ' + pidPath + ')" 2>/dev/null || ! pgrep -f -- ' + match + ' >/dev/null; then echo "Engine launch failed; launch.log:"; cat ' + launchLog + '; tail -n 20 ' + quote(dir + '/engine.log') + '; exit 1; fi'
  try { await runner.run('ssh', [...args, remote], signal) } catch (error) { throw engineFailure(String(error), recipe, String(error).includes('Engine launch failed')) ?? new Error('launch.log: ' + String(error)) }
}
export async function waitHostEngine(target: SshTarget, recipe: HostRecipe, runner: HostRunner, signal: AbortSignal, pauseMs = 5000, timeoutMs = 90 * 60_000, onLog: (text: string) => void = () => {}): Promise<void> {
  const started = Date.now()
  let last = ''
  let previous: string[] = []
  const dir = '/workspace/mercury-host/' + recipe.id
  const pid = '"$(cat ' + quote(dir + '/engine.pid') + ')"'
  while (!signal.aborted && Date.now() - started < timeoutMs) {
    const log = await runner.run('ssh', [...sshArguments(target), 'tail -n 8 ' + quote(dir + '/engine.log') + '; tail -n 8 ' + quote(dir + '/launch.log') + ' 2>/dev/null; if ! kill -0 ' + pid + ' 2>/dev/null || ! ps -p ' + pid + ' -o args= | grep -F -- ' + quote(dir + '/engine.sh') + ' >/dev/null; then echo MERCURY_ENGINE_EXITED; fi'], signal)
    const rows = log.trimEnd().split('\n')
    let overlap = Math.min(previous.length, rows.length)
    while (overlap && previous.slice(-overlap).join('\n') !== rows.slice(0, overlap).join('\n')) overlap--
    if (overlap < rows.length) onLog(rows.slice(overlap).join('\n'))
    previous = rows
    const failed = engineFailure(log, recipe, log.includes('MERCURY_ENGINE_EXITED'))
    if (failed) throw failed
    try { await runner.run('ssh', [...sshArguments(target), 'curl -fsS --max-time 10 http://127.0.0.1:30000/health && curl -fsS --max-time 10 http://127.0.0.1:30000/v1/models'], signal); return } catch (error) { last = String(error) }
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

export const boxInspectionScript = `set -eu
export PATH=$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.lmstudio/bin:/Applications/Ollama.app/Contents/Resources
printf 'OS '; uname -s
printf 'ARCH '; uname -m
printf 'HOME %s\\n' "$HOME"
printf 'UID '; id -u
case "$(uname -s)" in
Darwin) printf 'MEMORY '; sysctl -n hw.memsize; printf 'DISPLAYS '; system_profiler SPDisplaysDataType -json | tr '\\n' ' '; printf '\\n' ;;
Linux) awk '/MemTotal:/ {printf "MEMORY %.0f\\n", $2 * 1024}' /proc/meminfo ;;
esac
if command -v nvidia-smi >/dev/null; then nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | sed 's/^/GPU /'; fi
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then echo DOCKER_ENGINE_PRESENT; fi
for pair in ollama:ollama:11434 llamacpp:llama-server:30000 lmstudio:lms:1234 vllm:vllm:8000 sglang:sglang:30000; do
kind=$(printf %s "$pair" | cut -d: -f1); bin=$(printf %s "$pair" | cut -d: -f2); port=$(printf %s "$pair" | cut -d: -f3)
path=$(command -v "$bin" || true)
if test -n "$path"; then out=$("$path" --version 2>&1 || true); version=$(printf '%s\\n' "$out" | grep -i -m 1 'version' || printf '%s\\n' "$out" | head -n 1); printf 'ENGINE %s|%s|%s|%s\\n' "$kind" "$path" "$(printf %s "$version" | tr '|' '/')" "$port"; fi
done
for bank in "$HOME/mercury-model-bank" "$HOME/models" /Volumes/*/mercury-model-bank /mnt/*/mercury-model-bank; do
if test -d "$bank"; then printf 'BANK %s\\n' "$bank"; fi
done`

export const windowsBoxInspectionScript = `$ErrorActionPreference = 'Stop'
'OS windows'
'ARCH ' + $env:PROCESSOR_ARCHITECTURE
'HOME ' + $HOME
'MEMORY ' + (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { & nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | ForEach-Object { 'GPU ' + $_ } } else { Get-CimInstance Win32_VideoController | ForEach-Object { 'GPU ' + $_.Name + ', ' + ([double]$_.AdapterRAM / 1MB) } }
foreach ($row in @(@('ollama','ollama',11434),@('llamacpp','llama-server',30000),@('lmstudio','lms',1234),@('vllm','vllm',8000),@('sglang','sglang',30000))) {
$cmd = Get-Command $row[1] -ErrorAction SilentlyContinue
if ($cmd) { $ErrorActionPreference = 'Continue'; $lines = @(& $cmd.Source --version 2>&1 | ForEach-Object { "$_" }); $ErrorActionPreference = 'Stop'; $version = @(@($lines | Where-Object { $_ -match 'version' }) + $lines) | Select-Object -First 1; 'ENGINE ' + $row[0] + '|' + $cmd.Source + '|' + ("$version" -replace '\\|','/') + '|' + $row[2] }
}
foreach ($path in @((Join-Path $HOME 'mercury-model-bank'),(Join-Path $HOME 'models'))) { if (Test-Path -LiteralPath $path -PathType Container) { 'BANK ' + $path } }`

export async function inspectBoxMachine(target: SshTarget | undefined, os: 'darwin' | 'linux' | 'windows' | undefined, runner: HostRunner, signal: AbortSignal): Promise<string> {
  const windows = os === 'windows' || !target && process.platform === 'win32'
  const args = windows ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsBoxInspectionScript, 'utf16le').toString('base64')] : ['-c', boxInspectionScript]
  if (target) return runner.run('ssh', [...sshArguments(target), windows ? 'powershell.exe ' + args.join(' ') : '/bin/sh -c ' + quote(boxInspectionScript)], signal, 60_000)
  return runner.run(windows ? 'powershell.exe' : '/bin/sh', args, signal, 60_000)
}

export class HostTuneUnchanged extends Error {}
const processTable = `def is_llama(argv):
    return bool(argv) and pathlib.PurePosixPath(argv[0]).name == 'llama-server'
def processes():
    rows = []
    if os.path.isdir('/proc'):
        for entry in os.listdir('/proc'):
            if not entry.isdigit():
                continue
            try:
                stat = pathlib.Path('/proc', entry, 'stat').read_text()
                argv = pathlib.Path('/proc', entry, 'cmdline').read_bytes().decode(errors='replace').split('\\0')
            except OSError:
                continue
            fields = stat[stat.rfind(')') + 2:].split()
            rows.append((int(entry), int(fields[2]), fields[0], [arg for arg in argv if arg]))
    else:
        listing = subprocess.run(['ps', '-A', '-o', 'pid=,pgid=,stat=,command='], capture_output=True, text=True).stdout
        for line in listing.splitlines():
            parts = line.split(None, 3)
            if len(parts) >= 3:
                rows.append((int(parts[0]), int(parts[1]), parts[2][:1], parts[3].split() if len(parts) > 3 else []))
    return [row for row in rows if row[2] != 'Z']
`
export async function restartHostScript(target: SshTarget, recipe: HostRecipe, runner: HostRunner, signal: AbortSignal, mode: { restore: boolean; token: string }): Promise<void> {
  const dir = '/workspace/mercury-host/' + recipe.id
  const rewrite = `import fcntl, json, os, pathlib, shlex, shutil, signal, subprocess, sys, time, urllib.request
p = pathlib.Path(${JSON.stringify(dir)})
engine_url = 'http://127.0.0.1:30000'
restore = ${mode.restore ? 'True' : 'False'}
token = ${JSON.stringify(mode.token)}
script = p / 'engine.sh'
backup = p / 'engine.pre-tune.sh'
marker = p / 'engine.pre-tune.id'
weights = str(p / 'weights')
${processTable}
def unchanged(reason):
    print('MERCURY_TUNE_UNCHANGED ' + reason)
    sys.exit(3)
def serving():
    try:
        with urllib.request.urlopen(engine_url + '/v1/models', timeout=10) as response:
            return response.status == 200
    except Exception:
        return False
lock = open(p / 'engine.lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX)
if restore and (not marker.exists() or marker.read_text() != token):
    unchanged('this reload saved no launch script, so there is nothing to undo')
try:
    text = (backup if restore else script).read_text()
except OSError as error:
    unchanged('the launch script cannot be read: ' + str(error))
engine = None
for line in text.splitlines():
    try:
        args = shlex.split(line)
    except ValueError:
        continue
    if args[:1] == ['exec']:
        args = args[1:]
    if is_llama(args):
        engine = args
        break
if engine is None:
    unchanged('the launch script has no llama-server command')
if not restore:
    flags = json.loads(${JSON.stringify(JSON.stringify(recipe.flags))})
    for name in ['--ctx-size', '--parallel', '--chat-template-kwargs']:
        if name in flags:
            value = flags[flags.index(name) + 1]
            if name in engine:
                at = engine.index(name)
                engine[at:at + 2] = [name, value]
            else:
                engine.extend([name, value])
leader = None
if (p / 'engine.pid').exists():
    try:
        pid = int((p / 'engine.pid').read_text().strip())
    except ValueError:
        unchanged('engine.pid does not hold a process id')
    leader = next((row for row in processes() if row[0] == pid), None)
group = None
if leader is not None:
    command = ' '.join(leader[3])
    if leader[0] <= 1 or str(script) not in command and not (is_llama(leader[3]) and weights in command):
        unchanged('engine.pid names a process that is not this engine')
    if leader[1] != leader[0]:
        unchanged('the engine is not its own process group')
    group = leader[0]
strays = [row[0] for row in processes() if row[1] != group and is_llama(row[3]) and weights in ' '.join(row[3])]
if strays:
    unchanged('another engine for these weights is running as process ' + str(strays[0]))
if not restore and (group is None or not serving()):
    unchanged('the engine is not serving; Tune reloads a running engine, and Resume setup starts a stopped one')
next_script = 'set -e\\n' + ''.join(line + '\\n' for line in text.splitlines() if line.startswith('export ')) + shlex.join(engine) + '\\nwait\\n'
if restore and group is not None and script.read_text() == next_script:
    unchanged('the launch script was never changed')
if not restore:
    shutil.copy2(script, backup)
    marker.write_text(token)
staged = p / 'engine.tuning.sh'
staged.write_text(next_script)
staged.chmod(0o700)
os.replace(staged, script)
def stopped(sig, seconds):
    try:
        os.killpg(group, sig)
    except ProcessLookupError:
        return True
    deadline = time.monotonic() + seconds
    while any(row[1] == group for row in processes()):
        if time.monotonic() > deadline:
            return False
        time.sleep(0.2)
    return True
if group is not None and not stopped(signal.SIGTERM, 60) and not stopped(signal.SIGKILL, 15):
    raise RuntimeError('the previous engine did not stop, so no second engine was started')
print('MERCURY_TUNE_RESTORED ' if restore else 'MERCURY_TUNE_WRITTEN ')
`
  try { await runner.run('ssh', [...sshArguments(target), 'python3 -c ' + quote(rewrite)], signal, 120_000) } catch (error) {
    const reason = /MERCURY_TUNE_UNCHANGED ([^\n]+)/.exec(String(error))?.[1]
    if (reason) throw new HostTuneUnchanged(reason.trim())
    throw error
  }
  const remote = 'set -e; nohup setsid bash ' + quote(dir + '/engine.sh') + ' >> ' + quote(dir + '/engine.log') + ' 2>&1 < /dev/null & echo $! > ' + quote(dir + '/engine.pid') + '; sleep 1; kill -0 "$(cat ' + quote(dir + '/engine.pid') + ')"'
  await runner.run('ssh', [...sshArguments(target), remote], signal)
}
export async function readHostEngine(target: SshTarget, recipe: HostRecipe, runner: HostRunner, signal: AbortSignal): Promise<{ alive: boolean; conversations?: number; contextPerConversation?: number; effort?: string }> {
  const dir = '/workspace/mercury-host/' + recipe.id
  const read = `import json, os, pathlib, subprocess, urllib.request
p = pathlib.Path(${JSON.stringify(dir)})
engine_url = 'http://127.0.0.1:30000'
${processTable}
out = {'mark': 'MERCURY_ENGINE_READ ', 'alive': False}
try:
    group = int((p / 'engine.pid').read_text().strip())
    rows = [row for row in processes() if row[1] == group]
    out['alive'] = bool(rows)
    out['argv'] = next((row[3] for row in rows if is_llama(row[3])), [])
except (OSError, ValueError):
    pass
try:
    with urllib.request.urlopen(engine_url + '/props', timeout=10) as response:
        props = json.load(response)
    out['slots'] = props.get('total_slots')
    out['n_ctx'] = (props.get('default_generation_settings') or {}).get('n_ctx')
except Exception as error:
    out['error'] = str(error)
print(json.dumps(out))
`
  const output = await runner.run('ssh', [...sshArguments(target), 'python3 -c ' + quote(read)], signal, 60_000)
  const line = output.split('\n').find(row => row.includes('MERCURY_ENGINE_READ '))
  if (!line) throw new Error('The pod did not report its engine.')
  const reading = JSON.parse(line) as { alive?: unknown; slots?: unknown; n_ctx?: unknown; argv?: unknown }
  const argv = Array.isArray(reading.argv) ? reading.argv.filter((arg): arg is string => typeof arg === 'string') : []
  const at = argv.indexOf('--chat-template-kwargs')
  let effort: string | undefined
  try { const stated: unknown = at >= 0 ? (JSON.parse(argv[at + 1] ?? '') as { reasoning_effort?: unknown }).reasoning_effort : undefined; if (typeof stated === 'string') effort = stated } catch {}
  const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  return { alive: reading.alive === true, ...(whole(reading.slots) && whole(reading.n_ctx) ? { conversations: reading.slots, contextPerConversation: reading.n_ctx } : {}), ...(effort ? { effort } : {}) }
}
