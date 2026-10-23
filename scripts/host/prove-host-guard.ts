import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture } from './runpodFixture.mjs'
import { vastFixture } from './vastFixture.mjs'
import { lambdaFixture } from './lambdaFixture.mjs'
import type { HostRunner } from '../../src/services/host/ssh.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const rp = await runpodFixture()
const vast = await vastFixture()
const lambda = await lambdaFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  if (!['127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)) { escaped.push(request.url); throw new Error('Guard proof permits only loopback fixtures') }
  return nativeFetch(request)
}, nativeFetch)
const { runHostJob } = await import('../../src/services/host/worker.ts')
const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
const { readHostRecord, removeHostRecord } = await import('../../src/services/host/store.ts')
const { hostRunner } = await import('../../src/services/host/ssh.ts')
const { saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const { writeKeptVolume, readKeptVolume } = await import('../../src/services/host/volumes.ts')
const recipe = HOST_RECIPES.find(row => row.id === 'nemotron35-super-gguf-rtx-pro-6000')!
const vllm = HOST_RECIPES.find(row => row.engine === 'vllm')!
const failures: string[] = []
let checks = 0
let serial = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
const trial = async (name: string, work: () => Promise<void>) => {
  try { await work() } catch (error) { failures.push(name + ': ' + String(error)); console.error('FAIL ' + name + ': ' + String(error)) }
}
const notices = (sessionId: string): string[] => {
  const dir = join(f.home, 'host/notices')
  try { return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8'))).filter(row => row.sessionId === sessionId).map(row => row.words) } catch { return [] }
}
const shell = (text: string): string[] => {
  const parsed = spawnSync('python3', ['-c', 'import json, shlex, sys; print(json.dumps(shlex.split(sys.argv[1])))', text], { encoding: 'utf8' })
  assert.equal(parsed.status, 0, parsed.stderr)
  return JSON.parse(parsed.stdout)
}
const python = (script: string, folder: string, onOutput: (text: string) => void): Promise<{ code: number | null; text: string }> => new Promise((resolve, reject) => {
  const child = spawn('python3', ['-u', '-c', script], { cwd: folder, env: { ...process.env, PYTHONPATH: folder }, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  const timer = setTimeout(() => child.kill(), 10000)
  child.stdout.on('data', chunk => { text += String(chunk); onOutput(String(chunk)) })
  child.stderr.on('data', chunk => { text += String(chunk) })
  child.on('error', reject)
  child.on('close', code => { clearTimeout(timer); resolve({ code, text }) })
})
const scaled = (script: string, folder: string): string => {
  assert.ok(script.includes('stall_seconds = 600') && script.includes('stall_bytes = 1000000000'), 'production watchdog retains the ten-minute, one-GB window')
  return script.replace('stall_seconds = 600', 'stall_seconds = 0.3').replace('stall_poll = 30', 'stall_poll = 0.03').replace(/deadline_seconds = \d+/, 'deadline_seconds = 3').replace(/net_dev = [^\n]+/, 'net_dev = ' + JSON.stringify(join(folder, 'net-dev')))
}
const seed = (vendor: 'runpod' | 'vast' | 'lambda') => {
  const id = vendor === 'vast' ? String(8100 + ++serial) : 'guard-' + ++serial
  const name = 'guard-' + vendor + '-' + serial
  if (vendor === 'runpod') rp.state.pods.set(id, { id, name, cost: 2, status: 'RUNNING', createdAt: new Date().toISOString(), ssh: { direct: { host: '127.0.0.1', port: 2222, username: 'root' } } })
  if (vendor === 'vast') vast.state.pods.set(Number(id), { id: Number(id), label: name, actual_status: 'running', start_date: 1792490400, dph_total: 2, public_ipaddr: '127.0.0.1' })
  if (vendor === 'lambda') lambda.state.pods.set(id, { id, name, status: 'active', ip: '127.0.0.1', first_healthy: '2026-10-20T09:00:00Z', instance_type: lambda.state.types[0], reads: 2 })
  return { id, name }
}
const listPath = { runpod: '/v2/pods', vast: '/api/v1/instances/', lambda: '/api/v1/instances' }
try {
  for (const [vendor, fixture] of [['runpod', rp], ['vast', vast], ['lambda', lambda]] as const) {
    saveVendorKey(vendor, fixture.key)
    for (const kind of ['oom', 'load', 'cuda', 'exited', 'key', 'key-reset', 'vanished', 'stall'] as const) await trial(vendor + '/' + kind, async () => {
      const { id, name } = seed(vendor)
      const sessionId = name
      const chosen = kind === 'cuda' ? vllm : recipe
      const record = queueHostSetup({ id, name, vendor, recipe: chosen.id, recipeRow: chosen, price: 2, startedAt: new Date().toISOString(), status: 'RUNNING', apiBaseUrl: fixture.baseUrl, sessionId })
      const before = fixture.requests.length
      const deleted = fixture.state.deletes
      const config: { modelBaseUrl: string; hold: boolean; log: string; answers: { pattern: string; replies: { stdout?: string; stderr?: string; code?: number }[] }[] } = { modelBaseUrl: f.baseUrl, hold: true, log: '', answers: [] }
      const fatal = kind === 'oom' ? 'CUDA out of memory' : kind === 'load' ? 'failed to load model: incompatible quant' : kind === 'cuda' ? 'CUDA error: invalid device function' : 'engine exited with status 137'
      if (['oom', 'load', 'cuda', 'exited'].includes(kind)) config.log = 'MERCURY_STEP starting engine\n' + fatal + '\n'
      if (kind === 'exited') config.answers.push({ pattern: '^tail -n 8', replies: [{ stdout: config.log + 'MERCURY_ENGINE_EXITED\n' }] })
      if (kind === 'key' || kind === 'key-reset') config.answers.push({ pattern: '^(true|cloud-init status)', replies: (kind === 'key-reset' ? [255, 255, 1, 255, 255, 255] : [255]).map(code => ({ code, stderr: code === 255 ? 'Permission denied (publickey).\n' : 'Connection refused\n' })) })
      config.answers.push({ pattern: '^nvidia-smi', replies: [{ stdout: 'NVIDIA RTX PRO 6000 Blackwell, 98304\nDOCKER_ENGINE_PRESENT\n' }] })
      writeFileSync(join(f.home, 'ssh-fixture-calls.jsonl'), '')
      const save = () => writeFileSync(join(f.home, 'ssh-fixture.json'), JSON.stringify(config))
      save()
      let health = 0
      let download: Promise<{ code: number | null; text: string }> | undefined
      const folder = join(f.home, name); mkdirSync(folder)
      writeFileSync(join(folder, 'net-dev'), 'eth0: 0 0 0 0 0 0 0 0\n')
      writeFileSync(join(folder, 'frozen.py'), 'import time\ntime.sleep(5)\n')
      const runner: HostRunner = { tunnel() { throw new Error('A guarded failure never opens a tunnel') }, async run(command, args, abort, timeout) {
        const remote = args.at(-1)!
        if (remote.includes('/health')) { health++; if (health > 2) throw new Error('guard did not end the engine wait promptly') }
        if (kind === 'stall' && remote.includes('nohup setsid')) {
          const tokens = shell(remote)
          const at = tokens.findIndex((token, index) => token === 'printf' && tokens[index + 1] === '%s')
          const engineScript = tokens[at + 2]!
          let nested = shell(engineScript)
          if (nested[0] === 'docker') nested = shell(nested[nested.indexOf('-c') + 1]!)
          const pythonAt = nested.findIndex((token, index) => token === 'python3' && nested[index + 1] === '-c')
          if (pythonAt < 0) throw new Error('unguarded download has no stall watchdog')
          let script = scaled(nested[pythonAt + 2]!, folder).replace(/root = pathlib.Path\([^\n]+/, 'root = pathlib.Path(' + JSON.stringify(folder) + ')')
          script = script.replace(/download_command = [^\n]+/, 'download_command = ' + JSON.stringify('python3 ' + join(folder, 'frozen.py')))
          config.log = 'MERCURY_STEP downloading weights\n'; save()
          download = python(script, folder, text => { config.log += text; save() })
          return ''
        }
        if (kind === 'stall' && remote.startsWith('tail -n 8')) {
          if (download) await download
          save()
        }
        if (kind === 'vanished' && (remote === 'true' || remote.startsWith('cloud-init status'))) {
          fixture.state.pods.delete(vendor === 'vast' ? Number(id) : id)
          throw new Error('Connection closed by vanished pod')
        }
        return hostRunner.run(process.execPath, [join(import.meta.dir, 'sshJobFixture.mjs'), ...args], abort, timeout)
      } }
      await runHostJob(id, record.generation!, { runner, pauseMs: 40, timeoutMs: 12000, keepAlive: false })
      const result = readHostRecord(id)!
      const calls = fixture.requests.slice(before)
      const terminations = calls.filter((call: any) => call.method === 'DELETE' || call.path === '/api/v1/instance-operations/terminate')
      const lastTermination = calls.findLastIndex((call: any) => call.method === 'DELETE' || call.path === '/api/v1/instance-operations/terminate')
      const words = notices(sessionId)
      try {
        check(name + ' ends in a failed terminated record', result?.jobState === 'failed' && result.status === 'TERMINATED')
        check(name + ' verifies against the vendor list after termination', calls.slice(lastTermination + 1).some((call: any) => call.method === 'GET' && call.path === listPath[vendor]))
        check(name + ' emits one plain final notice', words.length === 1 && !/<result>[^<]*\n/.test(words[0]!))
        const notice = words[0]!
        if (kind === 'vanished') {
          check(name + ' does not send termination for an already absent pod', terminations.length === 0 && fixture.state.deletes === deleted)
          check(name + ' says the vendor no longer lists it and where to check billing', notice.includes('the vendor no longer lists pod ' + id) && notice.includes('nothing to terminate') && notice.includes('if it still bills, Machines I’m paying for shows it'))
        } else {
          check(name + ' sends one terminate and states verified absence', terminations.length === 1 && fixture.state.deletes === deleted + 1 && notice.includes('pod terminated and verified absent') && notice.includes('nothing more bills'))
          if (kind === 'key' || kind === 'key-reset') {
            const sshCalls = readFileSync(join(f.home, 'ssh-fixture-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
            check(name + ' counts consecutive publickey denials only', sshCalls.filter(args => /^(true|cloud-init status)/.test(args.at(-1))).length === (kind === 'key' ? 3 : 6))
            check(name + ' names the key road and next step', notice.includes('the pod did not accept Mercury') && notice.includes(vendor === 'vast' ? 'https://cloud.vast.ai/manage-keys/' : vendor === 'lambda' ? 'Lambda account keys' : 'added to this pod only') && notice.includes('/llmhost'))
          } else if (kind === 'stall') {
            check(name + ' reports the watchdog verdict', notice.includes('Download stalled') && notice.includes('under 1 GB in 10 min'))
            check(name + ' publishes partial bytes, total and stalled time before failing', result.steps?.some(row => /downloading weights.*GB of .*GB.*stalled/.test(row.step)))
            check(name + ' executes the window, not a fabricated verdict', (await download)?.code === 75)
          } else {
            check(name + ' reports the engine fatal line without a timeout', notice.includes('the engine died loading the weights') && notice.includes(fatal) && !notice.includes('Engine not ready') && health <= 1)
            if (kind === 'oom') check(name + ' names the too-small shape', notice.includes('shape was too small for this quality'))
          }
        }
        check(name + ' never puts the vendor key in a notice', !notice.includes(fixture.key))
      } finally { removeHostRecord(id); fixture.state.pods.delete(vendor === 'vast' ? Number(id) : id); await download; rmSync(folder, { recursive: true, force: true }) }
    })
  }
  for (const mode of ['rental', 'preparation', 'unverified'] as const) await trial('kept-stall/' + mode, async () => {
    const prepareOnly = mode !== 'rental'
    const { id, name } = seed('runpod')
    const folder = join(f.home, name); mkdirSync(folder)
    const manifest = { model: recipe.model, include: recipe.include ?? '', revision: 'e'.repeat(40), files: [{ path: 'weights.gguf', size: Math.round(recipe.weightsGb * 1e9), sha256: '0'.repeat(64) }] }
    const manifests = join(folder, 'manifests.json'); writeFileSync(manifests, JSON.stringify([manifest])); process.env.MERCURY_HOST_WEIGHTS_FILE = manifests
    writeFileSync(join(folder, 'huggingface_hub.py'), 'import time\ndef snapshot_download(**kwargs):\n    time.sleep(5)\n')
    writeFileSync(join(folder, 'net-dev'), 'eth0: 0 0 0 0 0 0 0 0\n')
    const volumeId = name + '-volume'
    writeKeptVolume({ id: volumeId, name: volumeId, model: recipe.model, include: recipe.include ?? '', kind: 'network', dataCenter: 'EU-NL-1', size: 200, price: 14, createdAt: new Date().toISOString(), state: 'preparing' })
    const record = queueHostSetup({ id, name, vendor: 'runpod', recipe: recipe.id, recipeRow: recipe, price: 2, startedAt: new Date().toISOString(), status: 'RUNNING', apiBaseUrl: rp.baseUrl, sessionId: name, volumeId, prepareWeightsOnly: prepareOnly })
    const before = rp.requests.length
    const deleted = rp.state.deletes
    let progress = ''
    let exit: number | null = null
    let sawProgress = false
    const runner: HostRunner = { tunnel() { throw new Error('No tunnel on a stalled download') }, async run(_command, args) {
      const remote = args.at(-1)!
      if (remote.includes('MERCURY_WEIGHTS ')) {
        if (!remote.includes('snapshot_download(repo_id=')) throw new Error('Missing pinned download')
        if (!remote.includes('if True:\n    progress(')) throw new Error('Kept weights failed pinned SHA256/sizes verification')
        const tokens = shell(remote)
        const code = tokens[tokens.lastIndexOf('-c') + 1]!
        const script = scaled(code, folder).replace(/root = pathlib.Path\([^\n]+/, 'root = pathlib.Path(' + JSON.stringify(folder) + ')').replace(/progress_path = [^\n]+/, 'progress_path = ""')
        const outcome = await python(script, folder, text => { progress += text })
        exit = outcome.code
        throw new Error('ssh exited ' + outcome.code + '. ' + outcome.text)
      }
      if (remote.startsWith('tail -n 1')) {
        const step = progress.split('\n').filter(row => row.startsWith('MERCURY_STEP ')).at(-1) ?? ''
        if (step.includes('stalled')) sawProgress = true
        return step
      }
      return ''
    } }
    rp.state.failDelete = mode === 'unverified'
    try {
      await runHostJob(id, record.generation!, { runner, pauseMs: 20, timeoutMs: 5000, keepAlive: false })
      const words = notices(name)
      const calls = rp.requests.slice(before)
      check(name + ' kept watchdog executes its window', exit === 75 && sawProgress)
      check(name + ' sends only one terminate even when cleanup fails', calls.filter((row: any) => row.method === 'DELETE').length === 1)
      if (mode === 'unverified') {
        check(name + ' warns about both compute and storage with no false absence', words.length === 1 && words[0]!.includes('could not verify') && words[0]!.includes('check your account') && words[0]!.includes('$14.00/month') && !words[0]!.includes('nothing more bills') && readHostRecord(id)?.status !== 'TERMINATED')
      } else {
        check(name + ' kept pod is terminated exactly once and verified', rp.state.deletes === deleted + 1 && calls.some((row: any) => row.method === 'GET' && row.path === listPath.runpod))
        check(name + ' kept failure has one notice with its bill and next step', words.length === 1 && words[0]!.includes('Download stalled') && words[0]!.includes('terminated') && words[0]!.includes('$14.00/month') && words[0]!.includes('/llmhost → Bank') && !words[0]!.includes('Fast-load') && !words[0]!.includes('nothing more bills'))
        check(name + ' final record truth matches temporary or rental ownership', prepareOnly ? !readHostRecord(id) : readHostRecord(id)?.status === 'TERMINATED')
        check(name + ' ended pod no longer owns disk preparation', !readKeptVolume(volumeId)?.preparingPod)
      }
      check(name + ' disk remains failed with partial bytes', readKeptVolume(volumeId)?.state === 'failed' && readKeptVolume(volumeId)?.partialBytes !== undefined)
    } finally { rp.state.failDelete = false; rp.state.pods.delete(id); removeHostRecord(id); delete process.env.MERCURY_HOST_WEIGHTS_FILE; rmSync(folder, { recursive: true, force: true }) }
  })
  await trial('vanished-kept-disk', async () => {
    const { id, name } = seed('runpod')
    const volumeId = name + '-volume'
    writeKeptVolume({ id: volumeId, name: volumeId, model: recipe.model, include: recipe.include ?? '', kind: 'network', dataCenter: 'EU-NL-1', size: 200, price: 14, createdAt: new Date().toISOString(), state: 'kept' })
    const record = queueHostSetup({ id, name, recipe: recipe.id, recipeRow: recipe, price: 2, startedAt: new Date().toISOString(), status: 'RUNNING', apiBaseUrl: rp.baseUrl, sessionId: name, volumeId })
    rp.state.pods.delete(id)
    const before = rp.requests.length
    await runHostJob(id, record.generation!, { runner: { tunnel() { throw new Error('No tunnel') }, async run() { throw new Error('No SSH for an absent pod') } }, pauseMs: 1, timeoutMs: 1000, keepAlive: false })
    const words = notices(name)
    check('a vanished pod never sends DELETE and never erases kept-disk billing', !rp.requests.slice(before).some((row: any) => row.method === 'DELETE') && words.length === 1 && words[0]!.includes('nothing to terminate') && words[0]!.includes('$14.00/month') && words[0]!.includes('/llmhost → Bank') && !words[0]!.includes('Fast-load') && readHostRecord(id)?.status === 'TERMINATED' && readKeptVolume(volumeId)?.state === 'kept')
    removeHostRecord(id)
  })
  await trial('cleanup-unverified', async () => {
    const { id, name } = seed('runpod')
    const record = queueHostSetup({ id, name, recipe: recipe.id, recipeRow: recipe, price: 2, startedAt: new Date().toISOString(), status: 'RUNNING', apiBaseUrl: rp.baseUrl, sessionId: name })
    rp.state.failDelete = true
    try {
      await runHostJob(id, record.generation!, { runner: { tunnel() { throw new Error('No tunnel') }, async run() { throw new Error('Permission denied (publickey)') } }, pauseMs: 1, timeoutMs: 1000, keepAlive: false })
      const words = notices(name)
      check('a failed terminate does not claim absence or no bills', words.length === 1 && words[0]!.includes('could not verify') && words[0]!.includes('check your account') && !words[0]!.includes('nothing more bills') && readHostRecord(id)?.status !== 'TERMINATED')
    } finally { rp.state.failDelete = false; rp.state.pods.delete(id); removeHostRecord(id) }
  })
  check('guard proof makes no public network calls', escaped.length === 0)
  if (failures.length) throw new Error(failures.length + ' guard cases failed\n' + failures.join('\n'))
  console.log('HOST GUARD GREEN · ' + checks + ' checks; three vendor fixtures, SSH process fixture, executed watchdog windows; zero billable calls')
} finally { globalThis.fetch = nativeFetch; await rp.close(); await vast.close(); await lambda.close(); f.close() }
