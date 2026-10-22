import { setTimeout as delay } from 'node:timers/promises'
import type { HostBox } from './boxes.js'
import { boxAbsolutePath, boxJoin, psQuote, runBoxScript, shQuote } from './boxExecution.js'
import { fitsBox, boxFitWords, type BoxRecipe } from './boxRecipes.js'
import { sealDownloadedBank, verifyBoxBank } from './boxBank.js'
import { boxServiceFiles, boxServiceRunning, controlBoxService, installBoxService, readBoxService, writeBoxService, type BoxServiceRecord } from './boxService.js'
import { hostRunner, type HostRunner } from './ssh.js'

interface BoxStartOptions { runner?: HostRunner; signal?: AbortSignal; timeoutMs?: number; pauseMs?: number; port?: number; bank: boolean; destination: string; confirmed: boolean; onStep?: (words: string) => void }
export function boxEngineScript(box: HostBox, recipe: BoxRecipe, executable: string, destination: string, port: number, loadModel = true): string {
  const env: Record<string, string> = recipe.engine === 'ollama' ? { OLLAMA_HOST: '127.0.0.1:' + port, OLLAMA_MODELS: destination, OLLAMA_KEEP_ALIVE: '-1', ...(recipe.contextPerSlot ? { OLLAMA_CONTEXT_LENGTH: String(recipe.contextPerSlot) } : {}) } : {}
  const args = recipe.engine === 'ollama' ? ['serve'] : ['--model', boxJoin(box, destination, recipe.files![0]!), '--alias', recipe.model, '--host', '127.0.0.1', '--port', String(port), '--jinja', '--n-gpu-layers', 'all', '--ctx-size', String(recipe.contextPerSlot! * (recipe.slots ?? 1)), '--parallel', String(recipe.slots ?? 1), '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--metrics']
  const body = JSON.stringify({ model: recipe.model, keep_alive: -1, ...(recipe.contextPerSlot ? { options: { num_ctx: recipe.contextPerSlot } } : {}) })
  if (box.os === 'windows') {
    const log = boxServiceFiles(box).log
    return "$ErrorActionPreference='Stop'\n" + Object.entries(env).map(([key, value]) => '$env:' + key + '=' + psQuote(value)).join('\n') + '\n$p=Start-Process -FilePath ' + psQuote(executable) + ' -ArgumentList ' + psQuote(args.map(arg => '"' + arg.replaceAll('"', '\\"') + '"').join(' ')) + ' -PassThru -NoNewWindow -RedirectStandardOutput ' + psQuote(log) + ' -RedirectStandardError ' + psQuote(log + '.error') + '\n$null=$p.Handle\ntry {\n' + (recipe.engine === 'ollama' && loadModel ? 'while (!$p.HasExited) { try { Invoke-RestMethod -Uri ' + psQuote('http://127.0.0.1:' + port + '/api/tags') + ' -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }; Invoke-RestMethod -Uri ' + psQuote('http://127.0.0.1:' + port + '/api/generate') + ' -Method Post -ContentType application/json -Body ' + psQuote(body) + ' | Out-Null\n' : '') + '$p.WaitForExit(); exit $p.ExitCode\n} finally { if (!$p.HasExited) { Stop-Process -Id $p.Id } }\n'
  }
  const command = [executable, ...args].map(shQuote).join(' ')
  if (recipe.engine !== 'ollama' || !loadModel) return 'set -eu\n' + Object.entries(env).map(([key, value]) => 'export ' + key + '=' + shQuote(value)).join('\n') + '\nexec ' + command + '\n'
  return 'set -eu\n' + Object.entries(env).map(([key, value]) => 'export ' + key + '=' + shQuote(value)).join('\n') + '\n' + command + ' &\npid=$!\ntrap \'kill "$pid" 2>/dev/null || true\' EXIT INT TERM\nuntil curl -fsS --max-time 2 http://127.0.0.1:' + port + '/api/tags >/dev/null; do kill -0 "$pid"; sleep 1; done\ncurl -fsS -H "Content-Type: application/json" -d ' + shQuote(body) + ' http://127.0.0.1:' + port + '/api/generate\nwait "$pid"\n'
}
async function engineBinary(box: HostBox, recipe: BoxRecipe, runner: HostRunner, signal: AbortSignal, step: (words: string) => void): Promise<string> {
  const existing = box.engines.find(engine => engine.kind === recipe.engine)
  if (existing) return existing.path
  const dir = boxJoin(box, box.home, '.local', 'share', 'mercury-host', 'runtime')
  if (recipe.engine === 'ollama') {
    step(box.os === 'darwin' ? 'installing Ollama with Homebrew' : 'downloading Ollama v0.40.6 for ' + box.os + ' ' + box.arch + ' and checking its checksum')
    if (box.os === 'darwin') return (await runBoxScript(box, 'command -v brew >/dev/null || { echo "Install Homebrew to install Ollama, or install Ollama and discover this computer again." >&2; exit 1; }; brew install ollama >&2; printf "%s/bin/ollama" "$(brew --prefix ollama)"', runner, signal, 30 * 60_000)).trim().split('\n').at(-1)!
    if (!['amd64', 'x86_64', 'arm64', 'aarch64'].includes(box.arch.toLowerCase())) throw new Error('Ollama has no selected package for this architecture: ' + box.arch)
    const arch = ['arm64', 'aarch64'].includes(box.arch.toLowerCase()) ? 'arm64' : 'amd64'
    const name = box.os === 'windows' ? 'ollama-windows-' + arch + '.zip' : 'ollama-linux-' + arch + '.tar.zst'
    const base = 'https://github.com/ollama/ollama/releases/download/v0.40.6/'
    const script = box.os === 'windows'
      ? '$dir=' + psQuote(dir) + '; New-Item -ItemType Directory -Force -Path $dir | Out-Null; $archive=Join-Path $dir ' + psQuote(name) + '; $sumsFile=Join-Path $dir ' + psQuote('sha256sum.txt') + '; Invoke-WebRequest -UseBasicParsing -Uri ' + psQuote(base + name) + ' -OutFile $archive; Invoke-WebRequest -UseBasicParsing -Uri ' + psQuote(base + 'sha256sum.txt') + ' -OutFile $sumsFile; $line=Get-Content -LiteralPath $sumsFile | Where-Object { $_ -match ' + psQuote('\\s(\\./)?' + name.replaceAll('.', '\\.') + '$') + ' } | Select-Object -First 1; if (!$line -or ($line.Trim() -split "\\s+")[0] -ne (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash) { throw "Ollama archive checksum failed" }; Expand-Archive -LiteralPath $archive -DestinationPath $dir -Force'
      : 'command -v zstd >/dev/null || { echo "Install zstd to unpack Ollama, or install Ollama and discover this computer again." >&2; exit 1; }; mkdir -p ' + shQuote(dir) + '; cd ' + shQuote(dir) + '; curl -fL ' + shQuote(base + name) + ' -o ' + shQuote(name) + '; curl -fL ' + shQuote(base + 'sha256sum.txt') + ' -o SHA256SUMS; line=$(grep -E ' + shQuote(' (\\./)?' + name.replaceAll('.', '\\.') + '$') + ' SHA256SUMS); printf "%s\\n" "$line" | sha256sum -c -; tar --zstd -xf ' + shQuote(name)
    await runBoxScript(box, script, runner, signal, 30 * 60_000)
    return boxJoin(box, dir, box.os === 'windows' ? 'ollama.exe' : 'bin/ollama')
  }
  if (box.os === 'windows') throw new Error('Install llama-server on this Windows computer, then discover it again.')
  const source = boxJoin(box, dir, 'llama.cpp')
  step('building llama.cpp from source (~10 min; up to 60 min on a slow machine)')
  const script = 'command -v git >/dev/null; command -v cmake >/dev/null; mkdir -p ' + shQuote(dir) + '; if ! test -d ' + shQuote(source) + '; then git clone https://github.com/ggml-org/llama.cpp ' + shQuote(source) + '; fi; git -C ' + shQuote(source) + ' checkout 3bb63cbcbfb62056c84fe9e521b0f3d756d29c32; cmake -S ' + shQuote(source) + ' -B ' + shQuote(source + '/build') + ' -DBUILD_SHARED_LIBS=OFF ' + (box.unifiedMemory ? '-DGGML_METAL=ON' : box.gpus.some(gpu => /NVIDIA/i.test(gpu.name)) ? '-DGGML_CUDA=ON' : '') + '; cmake --build ' + shQuote(source + '/build') + ' --config Release --parallel --target llama-server'
  await runBoxScript(box, script, runner, signal, 60 * 60_000)
  return source + '/build/bin/llama-server'
}
async function boxHttp(box: HostBox, port: number, path: string, runner: HostRunner, signal: AbortSignal): Promise<unknown> {
  const url = 'http://127.0.0.1:' + port + path
  const text = await runBoxScript(box, box.os === 'windows' ? '[Text.Encoding]::UTF8.GetString((Invoke-WebRequest -UseBasicParsing -Uri ' + psQuote(url) + ' -TimeoutSec 5).RawContentStream.ToArray())' : 'curl -fsS --max-time 5 ' + shQuote(url), runner, signal, 10_000)
  return JSON.parse(text)
}
export async function startBoxEngine(box: HostBox, recipe: BoxRecipe, options: BoxStartOptions): Promise<BoxServiceRecord> {
  if (!options.confirmed) throw new Error('Confirm the engine installation, download size and destination before starting.')
  if (!fitsBox(recipe, box)) throw new Error(boxFitWords(recipe, box))
  const destination = boxAbsolutePath(box, options.destination)
  const runner = options.runner ?? hostRunner
  const signal = options.signal ?? new AbortController().signal
  const port = options.port ?? 30000
  const step = (words: string): void => options.onStep?.(words)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a service port between 1024 and 65535.')
  if (box.os === 'windows' && recipe.engine === 'llamacpp' && !options.bank) throw new Error('Use a verified bank for a Windows GGUF service.')
  const previous = readBoxService(box.name)
  if (!previous || previous.state === 'uninstalled') {
    const files = boxServiceFiles(box)
    const present = await runBoxScript(box, box.os === 'windows' ? 'if (Test-Path -LiteralPath ' + psQuote(files.unit) + ') { "present" }' : 'if test -e ' + shQuote(files.unit) + '; then echo present; fi', runner, signal)
    if (present.trim()) throw new Error('A service file already uses this computer name; it was not written by this host record.')
    let occupied = false
    try { await boxHttp(box, port, '/v1/models', runner, signal); occupied = true } catch { signal.throwIfAborted() }
    if (occupied) throw new Error('Another engine answers on port ' + port + '; Mercury will not replace it.')
  }
  if (options.bank) { step('verifying the bank at ' + destination); await verifyBoxBank(box, recipe, destination, runner, signal) }
  const executable = await engineBinary(box, recipe, runner, signal, step)
  const record: BoxServiceRecord = { name: box.name, recipe: recipe.id, model: recipe.model, engine: recipe.engine, destination, bank: options.bank, port, localPort: previous?.localPort, baseUrl: previous?.baseUrl, ...boxServiceFiles(box), state: 'starting' }
  writeBoxService(record)
  let installed = Boolean(previous && previous.state !== 'uninstalled')
  try {
    if (previous && previous.state !== 'uninstalled') await controlBoxService(box, 'stop', runner, signal)
    if (!options.bank && recipe.engine === 'llamacpp') {
      const hf = boxJoin(box, box.home, '.local/share/mercury-host/hf/bin/hf')
      step('downloading ' + recipe.downloadGb + ' GB from https://huggingface.co/' + recipe.model + ' to ' + destination + ' (hours on a slow line; the download resumes if it stops)')
      const script = 'python3 -m venv ' + shQuote(boxJoin(box, box.home, '.local/share/mercury-host/hf')) + '; ' + shQuote(boxJoin(box, box.home, '.local/share/mercury-host/hf/bin/pip')) + ' install huggingface_hub; ' + shQuote(hf) + ' download ' + shQuote(recipe.model) + (recipe.revision ? ' --revision ' + shQuote(recipe.revision) : '') + ' --include ' + recipe.files!.map(shQuote).join(' ') + ' --local-dir ' + shQuote(destination)
      await runBoxScript(box, script, runner, signal, 12 * 3600_000)
      await sealDownloadedBank(box, recipe, destination, runner, signal)
    }
    installed = true
    step('installing the ' + recipe.engine + ' service')
    await installBoxService(box, boxEngineScript(box, recipe, executable, destination, port, options.bank), runner, signal)
    if (!options.bank && recipe.engine === 'ollama') {
      const deadline = Date.now() + (options.timeoutMs ?? 120_000)
      for (;;) { try { await boxHttp(box, port, '/api/tags', runner, signal); break } catch (error) { if (Date.now() >= deadline) throw error; await delay(options.pauseMs ?? 1000, undefined, { signal }) } }
      step('pulling ' + recipe.model + ' with Ollama (' + recipe.downloadGb + ' GB)')
      const script = box.os === 'windows' ? '$env:OLLAMA_HOST=' + psQuote('127.0.0.1:' + port) + '; & ' + psQuote(executable) + ' pull ' + psQuote(recipe.model) + '; if ($LASTEXITCODE -ne 0) { throw "Ollama pull failed" }' : 'OLLAMA_HOST=' + shQuote('127.0.0.1:' + port) + ' ' + shQuote(executable) + ' pull ' + shQuote(recipe.model)
      await runBoxScript(box, script, runner, signal, 12 * 3600_000)
      await installBoxService(box, boxEngineScript(box, recipe, executable, destination, port), runner, signal)
    }
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000)
    step('waiting for the engine to load ' + recipe.model + ' (up to ' + Math.max(1, Math.round((options.timeoutMs ?? 30 * 60_000) / 60_000)) + ' min) · mercury host logs ' + box.name + ' shows the engine output')
    let last = ''
    for (;;) {
      signal.throwIfAborted()
      let served: number | undefined
      try {
        if (!await boxServiceRunning(box, runner, signal)) throw new Error('The service is not running.')
        const list = await boxHttp(box, port, '/v1/models', runner, signal) as { data?: { id: string }[] }
        if (!list.data?.some(model => model.id === recipe.model)) throw new Error('The service has not loaded the selected model.')
        const facts = await boxHttp(box, port, recipe.engine === 'ollama' ? '/api/ps' : '/props', runner, signal) as { models?: { name: string; model: string; context_length: number }[]; default_generation_settings?: { n_ctx: number } }
        const context = recipe.engine === 'ollama' ? facts.models?.find(row => row.name === recipe.model || row.model === recipe.model)?.context_length : facts.default_generation_settings?.n_ctx
        if (!context || !Number.isSafeInteger(context) || context <= 0) throw new Error('The engine has not stated the served per-slot context.')
        served = context
      } catch (error) { last = String(error) }
      if (served !== undefined) {
        if (recipe.contextPerSlot && served !== recipe.contextPerSlot) throw new Error('The served context differs from the requested ' + recipe.contextPerSlot + ' tokens: ' + served)
        record.contextPerSlot = served; record.state = 'running'; writeBoxService(record); return record
      }
      if (Date.now() >= deadline) throw new Error('Engine not ready: ' + last)
      await delay(options.pauseMs ?? 1000, undefined, { signal })
    }
  } catch (error) {
    const stopped = installed && !signal.aborted && await controlBoxService(box, 'stop', runner, signal).then(() => true, () => false)
    record.state = 'failed'; record.error = String(error); writeBoxService(record)
    throw new Error(String(error) + (!installed ? '' : stopped ? ' · the service was stopped; mercury host logs ' + box.name + ' shows the engine output' : ' · the service may still be running; mercury host status ' + box.name + ' / stop ' + box.name))
  }
}

export async function boxEngineStatus(box: HostBox, runner: HostRunner = hostRunner, signal: AbortSignal = new AbortController().signal): Promise<{ record?: BoxServiceRecord; words: string; busy?: number; slots?: number; tokensPerSecond?: number }> {
  const record = readBoxService(box.name)
  if (!record || record.state === 'uninstalled') return { record, words: 'box ' + box.name + ' · no service installed' }
  const running = await boxServiceRunning(box, runner, signal)
  if (!running) { record.state = 'stopped'; writeBoxService(record); return { record, words: 'box ' + box.name + ' · engine stopped — /llmhost starts it' } }
  try {
    const list = await boxHttp(box, record.port, '/v1/models', runner, signal) as { data?: { id: string }[] }
    if (!list.data?.some(row => row.id === record.model)) return { record, words: 'box ' + box.name + ' · service running · selected model not loaded yet' }
  } catch (error) { return { record, words: 'box ' + box.name + ' · service running · model endpoint not answering · mercury host logs ' + box.name } }
  if (record.engine === 'llamacpp') {
    const slots = await boxHttp(box, record.port, '/slots', runner, signal).catch(() => undefined) as { is_processing?: boolean; timings?: { predicted_per_second?: number } }[] | undefined
    const rates = Array.isArray(slots) ? slots.map(slot => slot.timings?.predicted_per_second).filter((rate): rate is number => typeof rate === 'number' && Number.isFinite(rate) && rate > 0) : []
    if (rates.length && record.rateKind !== 'whole-turn') { record.tokensPerSecond = rates.at(-1); record.rateKind = 'generation'; writeBoxService(record) }
    const busy = Array.isArray(slots) ? slots.filter(slot => slot.is_processing).length : undefined
    return { record, ...(busy === undefined ? {} : { busy, slots: slots!.length }), tokensPerSecond: record.tokensPerSecond, words: 'box ' + box.name + ' · ' + record.engine + ' · ' + record.model + ' · ' + (busy === undefined ? 'slots not reported' : busy + '/' + slots!.length + ' slots busy') + ' · ' + (record.tokensPerSecond === undefined ? 'tokens/s not reported yet' : record.tokensPerSecond.toFixed(1) + ' tokens/s · last ' + (record.rateKind === 'whole-turn' ? 'whole turn' : 'generation')) }
  }
  return { record, words: 'box ' + box.name + ' · Ollama · ' + record.model + ' · slots not reported by Ollama · ' + (record.tokensPerSecond === undefined ? 'tokens/s not reported yet' : record.tokensPerSecond.toFixed(1) + ' tokens/s · last ' + (record.rateKind === 'whole-turn' ? 'whole turn' : 'generation')) }
}
export async function stopBoxEngine(box: HostBox, runner: HostRunner = hostRunner, signal: AbortSignal = new AbortController().signal, uninstall = false): Promise<void> {
  const record = readBoxService(box.name)
  if (!record || record.state === 'uninstalled') return
  await controlBoxService(box, uninstall ? 'uninstall' : 'stop', runner, signal)
  if (await boxServiceRunning(box, runner, signal)) throw new Error('The service manager still reports the engine running.')
  record.state = uninstall ? 'uninstalled' : 'stopped'; writeBoxService(record)
}
export async function restartBoxEngine(box: HostBox, runner: HostRunner = hostRunner, signal: AbortSignal = new AbortController().signal): Promise<BoxServiceRecord> {
  const record = readBoxService(box.name)
  if (!record || record.state === 'uninstalled') throw new Error('Choose a recipe and install the service first.')
  await controlBoxService(box, 'start', runner, signal)
  const deadline = Date.now() + 30 * 60_000
  for (;;) {
    try {
      const list = await boxHttp(box, record.port, '/v1/models', runner, signal) as { data?: { id: string }[] }
      if (await boxServiceRunning(box, runner, signal) && list.data?.some(model => model.id === record.model)) { record.state = 'running'; record.error = undefined; writeBoxService(record); return record }
    } catch { signal.throwIfAborted() }
    if (Date.now() > deadline) throw new Error('The restarted engine has not loaded its model; mercury host logs ' + box.name)
    await delay(1000, undefined, { signal })
  }
}
export async function boxEngineLogs(box: HostBox, runner: HostRunner = hostRunner, signal: AbortSignal = new AbortController().signal): Promise<string> {
  const log = boxServiceFiles(box).log
  return runBoxScript(box, box.os === 'windows' ? 'Get-Content -LiteralPath ' + psQuote(log) + ' -Tail 100' : 'tail -n 100 ' + shQuote(log), runner, signal)
}
