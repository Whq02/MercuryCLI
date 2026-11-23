import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { vastFixture } from './vastFixture.mjs'
import { fakeSshRunner } from './runpodFixture.mjs'
import { captureHostNotice } from './hostLinkFrames.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const vast = await vastFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
const realNow = Date.now
let skew = 0
Date.now = () => realNow() + skew
const owned = { pass: 3, hold: 0 }
const cut = { pass: 0, hold: 2 }
const plain = { pass: 0, hold: 0 }
let deadlineMs = 60_000
let instancePath = ''
let reads = 0
let wait = plain
let afterAttach = plain
let windowEnds = 0
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { escaped.push(request.url); throw new Error('Attach-key proof permits loopback only') }
  if (url.pathname === instancePath + 'ssh/') { reads = 0; wait = afterAttach; windowEnds = Date.now() + deadlineMs }
  else if (url.pathname === instancePath && request.method === 'GET') {
    reads++
    if (reads === wait.hold && Date.now() < windowEnds - 100) { reads = 0; wait = plain; return new Promise<Response>((_, reject) => { if (request.signal.aborted) reject(request.signal.reason); else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }) }) }
    if (reads === wait.pass) { reads = 0; skew += deadlineMs }
  }
  return nativeFetch(request)
}, nativeFetch)
const failures: string[] = []
let checks = 0
const attachKeyHint = 'change the SSH wait and key attach step of runHostJob in src/models/hosting/worker.ts, or VastClient.attachSshKey and VastClient.get in src/models/hosting/vendors/vast.ts'
const check = (name: string, truth: unknown, detail = '') => { if (truth) { checks++; console.log('PASS ' + name) } else { failures.push(name); console.error('FAIL ' + name + ': ' + detail + ' · ' + attachKeyHint) } }
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const { hostRunner, ensureHostKey, closeHostTunnel } = await import('../../src/models/hosting/ssh.ts')
  const { runHostJob } = await import('../../src/models/hosting/worker.ts')
  const { queueHostSetup } = await import('../../src/models/hosting/jobs.ts')
  const { readHostRecord, hostDirectory } = await import('../../src/models/hosting/store.ts')
  const { vendorClient, saveVendorKey } = await import('../../src/models/hosting/vendors/client.ts')
  saveVendorKey('vast', vast.key)
  const api = vendorClient('vast', { key: vast.key, apiBaseUrl: vast.baseUrl })
  const destroyed = await api.get('424242', new AbortController().signal).then(() => undefined, (error: unknown) => error as { status?: number; message: string })
  check('a destroyed instance (Vast answers HTTP 200 with instances: null) reads as not found, never as a shape Mercury cannot read', destroyed?.status === 404 && destroyed.message.includes('no longer lists instance 424242'), destroyed?.message)
  const offer = (await api.offers(new AbortController().signal)).find(row => row.recipe.id === 'qwen38-27b-rtx-pro-6000')!
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const key = await ensureHostKey(ssh.runner, new AbortController().signal)
  const notices = (id: string) => readdirSync(join(hostDirectory(), 'notices')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(hostDirectory(), 'notices', name), 'utf8')).words as string).filter(words => words.includes(id))
  for (const mode of ['accept', 'refuse', 'attach-failed', 'network', 'loading', 'cut-before-attach', 'cut-after-attach'] as const) {
    const pod = await api.create(offer, key.publicKey, 'key-' + mode)
    const instance = vast.state.pods.get(Number(pod.id))!
    if (mode === 'loading') instance.actual_status = 'loading'
    deadlineMs = mode === 'cut-before-attach' || mode === 'cut-after-attach' ? 1_000 : 60_000
    wait = mode === 'cut-before-attach' ? cut : owned
    afterAttach = mode === 'cut-after-attach' ? cut : owned
    instancePath = '/api/v0/instances/' + pod.id + '/'
    reads = 0
    const attachPath = instancePath + 'ssh/'
    if (mode === 'attach-failed') vast.state.failNext = { route: 'POST ' + attachPath, times: 1, status: 403 }
    let probesAfterAttach = 0
    const sshTimes: number[] = []
    const runner = {
      tunnel: ssh.runner.tunnel.bind(ssh.runner),
      async run(command: string, args: string[], signal: AbortSignal, timeoutMs?: number) {
        if (command === 'ssh' && args.at(-1) === 'true') {
          sshTimes.push(Date.now())
          if (instance.attachedKey) probesAfterAttach++
          if (mode !== 'accept' || !instance.attachedKey || probesAfterAttach < 3) throw new Error(mode === 'network' ? 'Connection refused' : 'Permission denied (publickey)')
          instancePath = ''
        }
        return ssh!.runner.run(command, args, signal, timeoutMs)
      },
    }
    const record = queueHostSetup({ id: pod.id, vendor: 'vast', name: pod.name, recipe: offer.recipe.id, price: pod.cost, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: vast.baseUrl, sshKey: key.path, sessionId: 'attach-key-session' })
    const start = Date.now()
    windowEnds = start + deadlineMs
    await runHostJob(record.id, record.generation!, { runner, pauseMs: 20, timeoutMs: deadlineMs, engineGraceMs: 100, keepAlive: false })
    instancePath = ''
    const ended = readHostRecord(pod.id)!
    const sent = vast.requests.filter((row: any) => row.method === 'POST' && row.path === attachPath)
    if (mode === 'accept' || mode === 'refuse') {
      check(mode + ': one attach uses the exact instance path and registered public key body', sent.length === 1 && Object.keys(sent[0]!.body).join(',') === 'ssh_key' && sent[0]!.body.ssh_key === key.publicKey && sent[0]!.authorization === 'Bearer ' + vast.key, JSON.stringify(sent))
      check(mode + ': attachment waits until the deadline then retries SSH on the same instance', sent.length === 1 && sent[0]!.at - start >= deadlineMs - 50 && probesAfterAttach >= 3 && vast.state.pods.has(Number(pod.id)), JSON.stringify({ sent: sent[0]?.at, start, probesAfterAttach, sshTimes }))
      if (mode === 'accept') check('attachment unblocks setup and registers a ready engine', ended.jobState === 'ready' && ended.provider !== undefined, ended.error)
      else {
        const posted = notices(pod.id)
        if (posted[0]) await captureHostNotice(posted[0], 'vast-key-attached-paused')
        check('continued refusal pauses once with attachment and retry, machine, rate and actions', ended.jobState === 'paused' && posted.length === 1 && posted[0]!.includes('Mercury attached the SSH key to this instance and retried') && posted[0]!.includes('Vast.ai instance ' + pod.id) && posted[0]!.includes('$' + pod.cost.toFixed(2) + '/hr still billing') && posted[0]!.includes('Resume or Terminate in /llmhost'), posted.join('\n'))
      }
    } else if (mode === 'attach-failed') {
      check('an attachment refusal is not retried or claimed successful, and the machine pauses', sent.length === 1 && ended.jobState === 'paused' && ended.error?.includes('could not attach the SSH key') && !ended.error.includes('attached the SSH key to this instance and retried'), ended.error)
    } else if (mode === 'cut-before-attach') {
      check('a status read the read budget ends at the deadline: the key is attached by the exact instance path and registered public key body', sent.length === 1 && Object.keys(sent[0]!.body).join(',') === 'ssh_key' && sent[0]!.body.ssh_key === key.publicKey && sent[0]!.authorization === 'Bearer ' + vast.key, JSON.stringify(sent) + ' ' + ended.error)
      check('a status read the read budget ends at the deadline: the attach comes at the deadline and SSH is retried on the same instance', sent.length === 1 && sent[0]!.at - start >= deadlineMs - 50 && probesAfterAttach >= 1 && vast.state.pods.has(Number(pod.id)), JSON.stringify({ sent: sent[0]?.at, start, probesAfterAttach, sshTimes, error: ended.error }))
    } else if (mode === 'cut-after-attach') {
      const posted = notices(pod.id)
      check('a status read the read budget ends after the attach: the pause notice says the key was attached and SSH retried, with machine, rate and actions', sent.length === 1 && probesAfterAttach >= 1 && ended.jobState === 'paused' && posted.length === 1 && posted[0]!.includes('Mercury attached the SSH key to this instance and retried') && posted[0]!.includes('Vast.ai instance ' + pod.id) && posted[0]!.includes('$' + pod.cost.toFixed(2) + '/hr still billing') && posted[0]!.includes('Resume or Terminate in /llmhost'), posted.join('\n') + ' ' + ended.error)
    } else check(mode + ': no key is attached without a running instance refusing publickey', sent.length === 0 && ended.jobState === 'paused', ended.error)
    check(mode + ': no terminate or replacement and no secrets in the notice', vast.state.deletes === 0 && !notices(pod.id).some(text => text.includes(vast.key) || text.includes(key.publicKey)), notices(pod.id).join('\n'))
    closeHostTunnel(pod.id)
  }
  check('all requests stayed on loopback', escaped.length === 0, 'escaped requests: ' + escaped.join(', '))
  if (failures.length) throw new Error(failures.length + ' attach-key checks failed: ' + failures.join('; '))
  console.log('VAST ATTACH KEY GREEN · ' + checks + ' checks')
} finally { Date.now = realNow; globalThis.fetch = nativeFetch; ssh?.close(); await vast.close(); f.close() }
