import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import { hfFixture } from './hfFixture.mjs'
import { hfEndpointsFixture } from './hfEndpointsFixture.mjs'
import { gridToPng } from '../ui/gridToPng.ts'
import type { LlmHostQuestion } from '../../src/services/llmHost/index.ts'

pinSourceRef()
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const option = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const frames = option('--frames')
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
process.env.HOME = f.home
if (process.platform === 'win32') process.env.USERPROFILE = f.home
const rp = await runpodFixture()
const data = Buffer.from('fixture weights for the source choice proof')
const digest = createHash('sha256').update(data).digest('hex')
const MIRROR = 'fixture-owner/source-mirror'
const WRONG = 'fixture-owner/wrong-copy'
const repoRow = (id: string, files: { path: string; size: number; sha256?: string }[]) => ({ id, downloads: 0, gated: false, private: true, library_name: 'transformers', pipeline_tag: 'text-generation', tags: ['transformers'], cardData: { license: 'mit' }, gguf: null, safetensors: null, config: {}, files, rawConfig: undefined })
const hub = await hfFixture({ extra: [repoRow(MIRROR, [{ path: 'README.md', size: 12 }, { path: 'weights.bin', size: data.length, sha256: digest }]), repoRow(WRONG, [{ path: 'weights.bin', size: data.length + 1, sha256: digest }])] })
const endpoints = await hfEndpointsFixture()
process.env.MERCURY_HOST_HF_API_BASE = hub.baseUrl
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const base = ({ 'https://api.endpoints.huggingface.cloud': endpoints.origin, 'https://huggingface.co': endpoints.origin } as Record<string, string>)[url.origin]
  if (base) return nativeFetch(new Request(base + url.pathname + url.search, request))
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') { escaped.push(url.origin); throw new Error('Only loopback fixtures are allowed') }
  return nativeFetch(input, init)
}, nativeFetch)
let checks = 0
const check = (name: string, truth: unknown): void => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
let mounted: Mounted | undefined
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const shipped = JSON.parse(readFileSync(join(f.root, 'assets/host/recipes.json'), 'utf8'))
  const recipe = { ...shipped.recipes.find((row: any) => row.id === 'qwen38-27b-rtx-pro-6000'), id: 'source-fixture', label: 'Source fixture · FP8', model: 'fixture/source-model', weightsGb: data.length / 1e9, weightManifest: { model: 'fixture/source-model', include: '', revision: 'a'.repeat(40), files: [{ path: 'weights.bin', size: data.length, sha256: digest }] } }
  const recipesFile = join(f.home, 'recipes.json')
  writeFileSync(recipesFile, JSON.stringify({ version: shipped.version, publishedAt: shipped.publishedAt, recipes: [recipe] }))
  process.env.MERCURY_HOST_RECIPES_FILE = recipesFile
  f.state.dialect = 'sglang'; f.state.window = 524288
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { hostRecords, readHostRecord } = await import('../../src/services/host/store.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { writeStoredHuggingfaceApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { keptWeightsPath } = await import('../../src/services/host/keptWeights.ts')
  const bank = await import('../../src/services/host/bank.ts')
  const safe = await import('../../src/services/host/keepSafe.ts')
  const volumes = await import('../../src/services/host/volumes.ts')
  const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const sources = await import('../../src/services/host/weightsSource.ts')
  saveVendorKey('runpod', rp.key)
  writeStoredHuggingfaceApiKey(endpoints.key)
  const folder = bank.rememberBankFolder(join(f.home, "model bank 'kept'"))
  const bankPath = bank.bankModelFolder(folder, recipe)
  mkdirSync(bankPath)
  writeFileSync(join(bankPath, 'weights.bin'), data)
  writeFileSync(join(bankPath, 'SHA256SUMS'), digest + '  weights.bin\n')
  check('the fixture bank is banked and pinned by the recipe manifest', bank.bankState(recipe).banked && bank.bankState(recipe).pinned)
  check('the base inference would have sent this Runpod rental to Hugging Face: no upload preference is saved', safe.bankUploadPreference(recipe) === undefined)
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const privateDownloads: string[] = []
  const runner = { ...ssh.runner, run: async (command: string, args: string[], signal: AbortSignal, timeoutMs?: number, env?: Record<string, string>) => {
    const remote = args.at(-1) ?? ''
    if (command === 'ssh' && remote.includes('MERCURY_PRIVATE_WEIGHTS ')) {
      ssh!.commands.push({ command, args })
      const parse = spawnSync('bash', ['-n', '-c', remote], { encoding: 'utf8' })
      assert.equal(parse.status, 0, parse.stderr)
      const tokens = JSON.parse(spawnSync('python3', ['-c', 'import json, shlex, sys; print(json.dumps(shlex.split(sys.argv[1])))', remote], { encoding: 'utf8' }).stdout) as string[]
      const script = tokens.find(token => token.includes('MERCURY_PRIVATE_WEIGHTS '))!
      const python = spawnSync('python3', ['-c', 'import ast, sys; ast.parse(sys.argv[1])', script], { encoding: 'utf8' })
      assert.equal(python.status, 0, python.stderr)
      privateDownloads.push(script)
      return 'MERCURY_STEP downloading weights · 0.00 GB of 0.00 GB\nMERCURY_PRIVATE_WEIGHTS {"repo":"' + MIRROR + '"}\n'
    }
    return ssh!.runner.run(command, args, signal, timeoutMs, env)
  } }
  const jobs: Promise<void>[] = []
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, vendorApiBaseUrls: { huggingface: endpoints.baseUrl }, runner, pauseMs: 5, readyTimeoutMs: 3000, sessionId: 'weights-source-proof', startJob: record => { jobs.push(runHostJob(record.id, record.generation!, { runner, pauseMs: 20, timeoutMs: 8000, keepAlive: false })) } })
  type Answer = [step: string, answer: (question: LlmHostQuestion) => string | null]
  const drive = async (answers: Answer[]): Promise<{ result: { ok: boolean; words: string }; questions: LlmHostQuestion[]; emitted: string[] }> => {
    const queue = [...answers]
    const questions: LlmHostQuestion[] = []
    const emitted: string[] = []
    let failure: unknown
    const ask = async (question: LlmHostQuestion): Promise<string | null> => {
      questions.push(question)
      try {
        const at = queue.findIndex(([step]) => step === question.step)
        if (at < 0) {
          if (question.step === 'pod-controls' || question.step === 'watch-controls') return 'close'
          throw new Error('Unexpected question ' + question.step + ' · ' + question.title + '\n' + (question.rows ?? []).map(row => row.value + ' · ' + row.label).join('\n'))
        }
        const [, answer] = queue.splice(at, 1)[0]!
        const value = answer(question)
        if (value !== null && question.rows && !question.rows.some(row => row.value === value)) throw new Error('Answer ' + value + ' is not a row of ' + question.step + ':\n' + question.rows.map(row => row.value + ' · ' + row.label).join('\n'))
        return value
      } catch (error) { failure ??= error; throw error }
    }
    const result = await road(ask, event => { emitted.push(event.title + ' · ' + event.words) }, new AbortController().signal)
    if (failure) throw failure
    assert.equal(queue.length, 0, 'every scripted answer was used: ' + queue.map(([step]) => step).join(', '))
    return { result, questions, emitted }
  }
  const rentRow = (question: LlmHostQuestion, vendor: string): string => { const row = question.rows!.find(row => row.label.startsWith('Rent · ' + vendor)); assert.ok(row, 'rental row for ' + vendor + '\n' + question.rows!.map(row => row.label).join('\n')); return row.value }
  const weightsRow = (question: LlmHostQuestion): { value: string; label: string } => { const row = question.rows!.find(row => row.label.startsWith('Weights: ')); assert.ok(row, 'the price confirmation carries the Weights row\n' + question.rows!.map(row => row.label).join('\n')); return row }
  const engineScript = (from: number): string => { const launch = ssh!.commands.slice(from).find(row => row.command === 'ssh' && row.args.at(-1)?.includes('nohup setsid')); assert.ok(launch, 'the engine was launched'); return launch.args.at(-1) }
  const sshText = (from: number): string => JSON.stringify(ssh!.commands.slice(from).filter(row => row.command === 'ssh').map(row => row.args))
  const rsyncs = (from: number) => ssh!.commands.slice(from).filter(row => row.command === 'rsync')
  const hubWrites = (): number => hub.requests.filter(row => row.method !== 'GET').length

  let from = ssh.commands.length
  let outcome = await drive([
    ['door-models', () => 'Source fixture'], ['door-model', question => rentRow(question, 'Runpod')],
    ['rent-confirm', question => { const row = weightsRow(question); check('confirmation names Hugging Face and its time estimate', row.label.includes('Hugging Face') && /~\d+ min/.test(row.label) && !question.title.includes('cold rental')); return 'rent' }],
  ])
  await Promise.all(jobs.splice(0))
  check('the Hugging Face rental reaches ready', outcome.result.ok && readHostRecord('fixture-pod-1')?.jobState === 'ready')
  check('the record carries the explicit Hugging Face choice', readHostRecord('fixture-pod-1')?.weightsSource?.kind === 'huggingface')
  check('the setup downloads on the machine from the recipe repository only: no bank upload, no private download, no volume', engineScript(from).includes('hf download ') && engineScript(from).includes(recipe.model) && !engineScript(from).includes('download skipped') && rsyncs(from).length === 0 && privateDownloads.length === 0 && rp.state.createBodies[0].mounts.persistent)

  from = ssh.commands.length
  outcome = await drive([
    ['door-models', () => 'Source fixture'], ['door-model', question => rentRow(question, 'Runpod')],
    ['rent-confirm', question => weightsRow(question).value],
    ['weights-source', question => {
      const rows = question.rows!
      check('the chooser retains all four source actions and their availability', rows.some(row => row.value === 'huggingface' && row.label.includes(recipe.model)) && rows.some(row => row.value === 'private-repo' && /private repository/i.test(row.label)) && rows.some(row => row.value === 'bank' && row.label.includes('upload')) && rows.some(row => row.value === 'volume' && row.label.includes('unavailable')))
      return 'bank'
    }],
    ['rent-confirm', question => { const row = weightsRow(question); check('confirmation names the Bank upload and ongoing billing', row.label.includes('Bank') && row.label.includes('upload') && question.willRun.includes('Billing starts now')); return 'rent' }],
  ])
  await Promise.all(jobs.splice(0))
  const bankRecord = readHostRecord('fixture-pod-2')!
  check('the bank rental reaches ready with the choice recorded', outcome.result.ok && bankRecord.jobState === 'ready' && bankRecord.weightsSource?.kind === 'bank' && (bankRecord.weightsSource as { folder: string }).folder === folder)
  const upload = rsyncs(from)
  check('the setup uploads the bank from the quoted folder and verifies it on the pod; the engine loads the uploaded copy and skips the download', upload.length === 1 && upload[0]!.args.some(arg => arg.includes("model bank 'kept'") && arg.endsWith('/')) && sshText(from).includes('sha256sum -c SHA256SUMS') && engineScript(from).includes('/bank-weights') && engineScript(from).includes('download skipped') && !engineScript(from).includes('hf download'))
  check('no upload preference existed before; the measured transfer is remembered for the next estimate without changing keep-safe choices', safe.bankUploadPreference(recipe)?.source === 'transfer')
  from = ssh.commands.length
  const resumed = queueHostSetup({ ...bankRecord, status: 'RUNNING' })
  await runHostJob(resumed.id, resumed.generation!, { runner, pauseMs: 20, timeoutMs: 8000, keepAlive: false })
  check('resume retains the bank source', readHostRecord('fixture-pod-2')?.jobState === 'ready' && readHostRecord('fixture-pod-2')?.weightsSource?.kind === 'bank' && rsyncs(from).length === 1 && !engineScript(from).includes('hf download'))

  from = ssh.commands.length
  const createsBefore = rp.state.creates
  outcome = await drive([
    ['door-models', () => 'Source fixture'], ['door-model', question => rentRow(question, 'Runpod')],
    ['rent-confirm', question => weightsRow(question).value],
    ['weights-source', () => 'private-repo'], ['weights-private-repo', () => 'nobody/missing-repo'],
    ['weights-source', () => 'private-repo'], ['weights-private-repo', () => WRONG],
    ['weights-source', () => 'private-repo'], ['weights-private-repo', () => hub.repos.gated.id],
    ['weights-source', () => 'private-repo'], ['weights-private-repo', question => { check('the repository question names the files the recipe needs', question.found.includes('weights.bin') || question.found.includes('pinned manifest')); return MIRROR }],
    ['rent-confirm', question => { const row = weightsRow(question); check('confirmation names the private source and credential use', row.label.includes(MIRROR) && question.willRun.includes('downloads ' + MIRROR + ' with your Hugging Face sign-in')); return 'rent' }],
  ])
  check('an unreachable repository, a copy of another size and a gated repository the sign-in cannot read are refused with their reasons and rent nothing', outcome.emitted.some(words => words.includes('nobody/missing-repo') && words.includes('unreachable')) && outcome.emitted.some(words => words.includes(WRONG) && words.includes('not the same copy')) && outcome.emitted.some(words => words.includes(hub.repos.gated.id) && words.includes('no access')) && rp.state.creates === createsBefore + 1)
  check('the preflight read the file list with the saved sign-in and published nothing to the hub', hub.requests.some(row => row.path.includes(encodeURIComponent('source-mirror')) && row.authorization === 'Bearer ' + endpoints.key) && hubWrites() === 0)
  await Promise.all(jobs.splice(0))
  const privateRecord = readHostRecord('fixture-pod-3')!
  check('the private-repository rental reaches ready with the choice recorded', outcome.result.ok && privateRecord.jobState === 'ready' && privateRecord.weightsSource?.kind === 'private-repo' && (privateRecord.weightsSource as { repo: string }).repo === MIRROR)
  const tokenTransfer = rsyncs(from).find(row => row.args.at(-1)?.endsWith('/hf-token'))
  check('the sign-in reaches the pod as a file transfer, never on a command line, and the local copy is gone', Boolean(tokenTransfer) && !sshText(from).includes(endpoints.key) && !readdirSync(join(f.home, 'host')).some(name => name.startsWith('hf-token-')))
  check('the pod downloads the recipe files from the private repository and removes the token afterwards', privateDownloads.length === 1 && privateDownloads[0]!.includes('repo_id="' + MIRROR + '"') && privateDownloads[0]!.includes('allow_patterns=["weights.bin"]') && sshText(from).includes("rm -f '/workspace/mercury-host/source-fixture/hf-token'"))
  check('the engine serves the recipe model name from the private copy with the download skipped', engineScript(from).includes('/private-weights') && new RegExp('--served-model-name\\W+' + recipe.model.replace('/', '\\/')).test(engineScript(from)) && !engineScript(from).includes(MIRROR) && engineScript(from).includes('download skipped') && !engineScript(from).includes('hf download'))
  const lambdaCommand = sources.privateRepoDownloadCommand({ kind: 'private-repo', repo: MIRROR, patterns: ['weights.bin'], bytes: data.length }, recipe, '/workspace/mercury-host/source-fixture/private-weights', '/workspace/mercury-host/source-fixture/hf-token', { docker: true, pod: false })
  check('the Lambda road wraps the same download in the recipe image', lambdaCommand.startsWith('docker run --rm -v /workspace:/workspace') && spawnSync('bash', ['-n', '-c', lambdaCommand]).status === 0)

  const privateSource = { kind: 'private-repo' as const, repo: MIRROR, patterns: ['weights.bin'], bytes: data.length }
  const secret = 'hf_fixture_secret_value_never_on_a_command_line'
  const tokenPath = '/workspace/mercury-host/source-fixture/hf-token'
  type Call = { command: string; remote: string; aborted: boolean }
  const attempt = async (script: { rsync?: 'abort' | 'fail' | 'echo'; download?: 'abort' | 'fail' | 'echo'; cleanup?: 'fail' }) => {
    const calls: Call[] = []
    const controller = new AbortController()
    const hubBefore = hub.requests.length
    const run = async (command: string, args: string[], signal: AbortSignal): Promise<string> => {
      const remote = args.at(-1) ?? ''
      calls.push({ command, remote, aborted: signal.aborted })
      if (command === 'ssh') assert.equal(spawnSync('bash', ['-n', '-c', remote]).status, 0, remote)
      if (command === 'ssh' && remote.startsWith('rm -f ')) { if (script.cleanup === 'fail') throw new Error('ssh exited 255. Connection closed by remote host'); return '' }
      if (command === 'rsync') {
        if (script.rsync === 'abort') { controller.abort(); throw new Error('Stopped') }
        if (script.rsync === 'fail') throw new Error('rsync exited 12. Connection unexpectedly closed')
        if (script.rsync === 'echo') throw new Error('rsync exited 12. rejected ' + secret)
        return ''
      }
      if (command === 'ssh' && remote.includes('MERCURY_PRIVATE_WEIGHTS ')) {
        if (script.download === 'abort') { controller.abort(); throw new Error('Stopped') }
        if (script.download === 'fail') throw new Error('ssh exited 1. MERCURY_PARTIAL {"bytes":0}')
        if (script.download === 'echo') throw new Error('ssh exited 1. denied ' + secret)
        return 'MERCURY_PRIVATE_WEIGHTS {"repo":"' + MIRROR + '"}\n'
      }
      return ''
    }
    const steps: string[] = []
    let error: unknown
    let directory: string | undefined
    try { directory = await sources.downloadPrivateRepoForRental(privateSource, recipe, secret, { host: '127.0.0.1', port: 2222, user: 'root' }, { run, tunnel: () => { throw new Error('No tunnel is needed') } }, controller.signal, step => { steps.push(step) }, { docker: false, pod: true }) } catch (caught) { error = caught }
    const message = error instanceof Error ? error.message : String(error)
    const cleanup = calls.find(call => call.command === 'ssh' && call.remote === "rm -f '" + tokenPath + "' && test ! -e '" + tokenPath + "'")
    const download = calls.find(call => call.command === 'ssh' && call.remote.includes('MERCURY_PRIVATE_WEIGHTS '))
    assert.ok(calls.filter(call => call.command === 'ssh').every(call => !call.remote.includes(secret)) && !message.includes(secret), 'the token value never travels on a command line or in words')
    if (error instanceof Error && error.cause instanceof Error) assert.ok(!error.cause.message.includes(secret), 'the failure cause also redacts the token')
    assert.equal(hub.requests.length, hubBefore, 'the machine road never touches the hub')
    assert.ok(!readdirSync(join(f.home, 'host')).some(name => name.startsWith('hf-token-')), 'the local copy of the token is gone')
    return { calls, steps, error, message, directory, cleanup, download }
  }
  let run = await attempt({ rsync: 'abort' })
  check('a job cancelled during the transfer still gets its one removal attempt on a live signal, and nothing downloads', run.message === 'Stopped' && run.cleanup !== undefined && !run.cleanup.aborted && run.download === undefined)
  run = await attempt({ rsync: 'fail' })
  check('a transfer that fails after the remote folder exists removes the file and keeps the transfer error', run.cleanup !== undefined && run.message.includes('rsync exited 12') && !run.message.includes('could not be confirmed'))
  run = await attempt({ download: 'abort' })
  check('a job cancelled during the download still gets its removal attempt on a live signal', run.message === 'Stopped' && run.cleanup !== undefined && !run.cleanup.aborted)
  run = await attempt({ rsync: 'fail', cleanup: 'fail' })
  check('an unconfirmed removal after a failed transfer keeps the transfer error and says the file may remain', run.message.includes('rsync exited 12') && run.message.includes('could not be confirmed removed') && run.message.includes(tokenPath) && run.message.includes(sources.TOKEN_REVOKE_WORDS) && (run.error as { cause?: Error }).cause?.message.includes('rsync exited 12'))
  run = await attempt({ download: 'fail', cleanup: 'fail' })
  check('an unconfirmed removal after a failed download keeps the download words and says the file may remain', run.message.includes('Download failed') && run.message.includes(MIRROR) && run.message.includes('could not be confirmed removed'))
  run = await attempt({ cleanup: 'fail' })
  check('a finished download with an unconfirmed removal is not reported as clean: no directory, no started engine, the uncertainty named', run.directory === undefined && run.message.includes('finished, but') && run.message.includes('could not be confirmed removed') && run.message.includes(tokenPath) && !run.steps.some(step => step.includes('removed from the machine')))
  run = await attempt({ rsync: 'echo' })
  check('an echoed token in a failed transfer is redacted after successful cleanup', run.message.includes('[redacted]') && run.message.includes('rsync exited 12'))
  run = await attempt({ download: 'echo' })
  check('an echoed token in a failed download is redacted after successful cleanup', run.message.includes('[redacted]') && run.message.includes('Download failed'))
  run = await attempt({ rsync: 'echo', cleanup: 'fail' })
  check('a cleanup failure keeps a redacted cause for a transfer that echoed the token', run.message.includes('[redacted]') && run.message.includes('could not be confirmed removed'))
  run = await attempt({})
  check('the ordinary road removes the file, confirms it, and the script unlinks the token before it downloads', run.directory === '/workspace/mercury-host/source-fixture/private-weights' && run.cleanup !== undefined && run.steps.at(-1)?.includes('sign-in file removed from the machine') && run.download !== undefined && run.download.remote.includes('token_path.unlink()') && run.download.remote.includes('snapshot_download(') && run.download.remote.indexOf('token_path.unlink()') < run.download.remote.indexOf('snapshot_download('))
  check('none of the cleanup roads published or mutated anything on Hugging Face', hubWrites() === 0 && endpoints.state.creates === 0)

  rp.state.volumes.set('fixture-volume-1', { id: 'fixture-volume-1', name: 'mercury-weights-fixture', kind: 'global', createdAt: new Date().toISOString(), createdByUserId: 'fixture-user' })
  volumes.writeKeptVolume({ id: 'fixture-volume-1', name: 'mercury-weights-fixture', model: recipe.model, include: '', recipeRow: recipe, kind: 'global', dataCenter: 'any DC', size: recipe.diskGb, price: 1, createdAt: new Date().toISOString(), state: 'kept', verifiedSums: { sha256: digest, sampleManifestSha256: digest, check: 'full', files: 1, bytes: data.length, at: new Date().toISOString() } })
  ssh.state.weights.set(keptWeightsPath(recipe), recipe.weightManifest)
  from = ssh.commands.length
  outcome = await drive([
    ['door-models', () => 'Source fixture'], ['door-model', question => rentRow(question, 'Runpod')],
    ['rent-confirm', question => { const row = weightsRow(question); check('the kept volume default retains its id and estimate', row.label.includes('fixture-volume-1') && /~\d+ min/.test(row.label)); return row.value }],
    ['weights-source', question => { check('the volume row is available and Hugging Face stays offered', question.rows!.some(row => row.value === 'volume' && !row.label.includes('unavailable')) && question.rows!.some(row => row.value === 'huggingface')); return 'huggingface' }],
    ['rent-confirm', question => { check('switching source updates the Weights row', weightsRow(question).label.includes('Hugging Face')); return weightsRow(question).value }],
    ['weights-source', () => 'volume'],
    ['rent-confirm', question => { check('switching back names the kept volume', weightsRow(question).label.includes('fixture-volume-1')); return 'rent' }],
  ])
  await Promise.all(jobs.splice(0))
  const volumeRecord = readHostRecord('fixture-pod-4')!
  check('the volume rental mounts the chosen disk and reaches ready with the choice recorded', outcome.result.ok && volumeRecord.jobState === 'ready' && volumeRecord.weightsSource?.kind === 'volume' && volumeRecord.volumeId === 'fixture-volume-1' && rp.state.createBodies[3].mounts.global?.[0]?.volumeId === 'fixture-volume-1')
  check('the engine loads the kept weights and nothing is uploaded or downloaded', engineScript(from).includes(keptWeightsPath(recipe)) && rsyncs(from).length === 0 && !engineScript(from).includes('hf download') && privateDownloads.length === 1)
  from = ssh.commands.length
  outcome = await drive([
    ['door-models', () => 'Source fixture'], ['door-model', question => rentRow(question, 'Runpod')],
    ['rent-confirm', question => weightsRow(question).value], ['weights-source', () => 'huggingface'],
    ['rent-confirm', () => 'rent'],
  ])
  await Promise.all(jobs.splice(0))
  check('choosing Hugging Face beside a kept volume rents without the mount and downloads', readHostRecord('fixture-pod-5')?.weightsSource?.kind === 'huggingface' && readHostRecord('fixture-pod-5')?.volumeId === undefined && rp.state.createBodies[4].mounts.persistent && engineScript(from).includes('hf download'))

  const creates = rp.state.creates
  outcome = await drive([
    ['door-models', () => 'Source fixture'], ['door-model', question => rentRow(question, 'Runpod')],
    ['rent-confirm', question => weightsRow(question).value], ['weights-source', () => null],
    ['rent-confirm', question => { check('escaping the chooser keeps the previous choice', weightsRow(question).label.includes('fixture-volume-1')); return weightsRow(question).value }],
    ['weights-source', () => 'back'],
    ['rent-confirm', () => 'cancel'],
  ])
  check('cancel after the choice creates no pod', !outcome.result.ok && rp.state.creates === creates)
  outcome = await drive([
    ['door-models', () => 'Source fixture'], ['door-model', question => rentRow(question, 'Hugging Face')],
    ['rent-confirm', question => weightsRow(question).value],
    ['weights-source', question => { check('HF endpoints retain unavailable source actions with reasons', ['bank', 'private-repo', 'volume'].every(value => question.rows!.find(row => row.value === value)?.label.includes('unavailable'))); return 'bank' }],
    ['weights-source', () => 'private-repo'],
    ['weights-source', () => 'back'],
    ['rent-confirm', () => 'cancel'],
  ])
  check('unsupported managed sources explain the refusal before any charge', outcome.emitted.filter(words => words.includes('cannot be used')).length === 2 && endpoints.state.creates === 0 && rp.state.creates === creates && hubWrites() === 0)

  volumes.writeKeptVolume({ ...volumes.readKeptVolume('fixture-volume-1')!, state: 'gone' })
  rp.state.noStock = true
  from = ssh.commands.length
  outcome = await drive([
    ['door-models', () => 'Source fixture'], ['door-model', question => { assert.ok(question.rows!.some(row => row.value === 'watch')); return 'watch' }],
    ['rent-confirm', question => { assert.ok(question.rows!.some(row => row.value === 'watch'), 'the catalogue price gives the watch its ceiling'); return weightsRow(question).value }],
    ['weights-source', () => 'private-repo'], ['weights-private-repo', () => MIRROR],
    ['rent-confirm', question => { check('the watch confirmation discloses the private repository', weightsRow(question).label.includes(MIRROR)); return 'watch' }],
  ])
  const watch = hostRecords().find(row => row.jobKind === 'watch')!
  check('the watch record carries the chosen source', Boolean(watch) && watch.weightsSource?.kind === 'private-repo')
  rp.state.noStock = false
  await Promise.all(jobs.splice(0))
  const rented = hostRecords().find(row => row.watchedFrom === watch.id)!
  check('the rental the watch makes inherits the private repository and sets up from it', Boolean(rented) && rented.weightsSource?.kind === 'private-repo' && rented.jobState === 'ready' && privateDownloads.length === 2 && engineScript(from).includes('/private-weights'))

  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  let question: LlmHostQuestion | undefined
  const width = 120, height = 44
  mounted = await mountOffscreen(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width, height }, React.createElement(SettingsPopupSlot)))), width, height)
  const screen = () => mounted!.screen()
  const step = async (name: string) => assert.ok(await waitFor(() => question?.step === name && screen().includes(question.title.slice(0, 20)), 15000), name + '\n' + screen())
  const selected = () => mounted!.lines().find(line => line.includes('› ')) ?? ''
  const choose = async (value: string) => {
    const row = question!.rows!.find(row => row.value === value)
    assert.ok(row, value)
    const title = row.label.split('\n').at(-1)!.slice(0, 22)
    for (const key of [KEY.down, KEY.up]) for (let i = 0; i < 30 && !selected().includes(title); i++) { const before = selected(); mounted!.push(key); if (!await waitFor(() => selected() !== before, 500)) break }
    assert.ok(selected().includes(title), value + '\n' + screen())
    mounted!.push(KEY.enter)
  }
  const capture = async (name: string) => {
    check(name + ' paints without errors or a key', !screen().includes('RENDER ERROR') && !screen().includes(rp.key) && !screen().includes(endpoints.key))
    if (!frames) return
    writeFileSync(join(frames, name + '.txt'), screen())
    const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(width)).map((c, x) => { const style = mounted!.styleAt(x, y); return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false } }))
    const path = join(frames, name + '.json')
    writeFileSync(path, JSON.stringify({ grid, cols: width, rows: height }))
    await gridToPng(path, join(frames, name + '.png'))
  }
  const popupCreates = rp.state.creates
  popup.openSettingsPopup(llmHostPopupRequest((ask, emit, signal) => road(plan => { question = plan; return ask(plan) }, emit, signal)))
  await step('door-models'); await choose('Source fixture'); await step('door-model'); await choose(rentRow(question!, 'Runpod')); await step('rent-confirm')
  check('the popup confirmation shows the Weights row', screen().includes('Weights:'))
  await capture('01-confirm-default')
  await choose(weightsRow(question!).value); await step('weights-source')
  check('the popup chooser lists the four sources', ['Hugging Face', 'Private repository', 'Bank', 'Kept volume'].every(words => screen().includes(words)))
  await capture('02-weights-chooser')
  await choose('private-repo'); await step('weights-private-repo'); await capture('03-private-repository')
  mounted.push(MIRROR); assert.ok(await waitFor(() => screen().includes(MIRROR), 3000)); mounted.push(KEY.enter)
  await step('rent-confirm')
  check('the popup confirmation names the chosen repository and private source', screen().includes(MIRROR) && weightsRow(question!).label.includes('private'))
  await capture('04-confirm-private-repository')
  await choose('cancel'); assert.ok(await waitFor(() => screen().includes('Cancelled') || !popup.isSettingsPopupOpen(), 5000), screen())
  mounted.push(KEY.esc); if (!await waitFor(() => !popup.isSettingsPopupOpen(), 1000)) mounted.push(KEY.esc)
  assert.ok(await waitFor(() => !popup.isSettingsPopupOpen(), 5000))
  check('the popup walk rents nothing', rp.state.creates === popupCreates && endpoints.state.creates === 0)
  check('every request stayed on loopback fixtures', escaped.length === 0)
  console.log('WEIGHTS SOURCE PROOF GREEN — ' + checks + ' checks; real rental question flow on Runpod and HF endpoint fixtures, SSH shim; Hugging Face, Bank, private repository and kept volume each set up exactly as chosen; zero billable calls')
} finally { mounted?.unmount(); ssh?.close(); await rp.close(); await hub.close(); await endpoints.close(); f.close(); globalThis.fetch = nativeFetch; delete process.env.MERCURY_HOST_RECIPES_FILE; delete process.env.MERCURY_HOST_HF_API_BASE }
