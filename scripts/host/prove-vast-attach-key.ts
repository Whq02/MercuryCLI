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
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  if (!['127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)) { escaped.push(request.url); throw new Error('Attach-key proof permits loopback only') }
  return nativeFetch(request)
}, nativeFetch)
const failures: string[] = []
let checks = 0
const check = (name: string, truth: unknown, detail = '') => { if (truth) { checks++; console.log('PASS ' + name) } else { failures.push(name); console.error('FAIL ' + name + ': ' + detail) } }
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const { hostRunner, ensureHostKey, closeHostTunnel } = await import('../../src/services/host/ssh.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { readHostRecord, hostDirectory } = await import('../../src/services/host/store.ts')
  const { vendorClient, saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  saveVendorKey('vast', vast.key)
  const api = vendorClient('vast', { key: vast.key, apiBaseUrl: vast.baseUrl })
  const offer = (await api.offers(new AbortController().signal)).find(row => row.recipe.id === 'qwen38-27b-rtx-pro-6000')!
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const key = await ensureHostKey(ssh.runner, new AbortController().signal)
  const notices = (id: string) => readdirSync(join(hostDirectory(), 'notices')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(hostDirectory(), 'notices', name), 'utf8')).words as string).filter(words => words.includes(id))
  for (const mode of ['accept', 'refuse', 'attach-failed', 'network', 'loading'] as const) {
    const pod = await api.create(offer, key.publicKey, 'key-' + mode)
    const instance = vast.state.pods.get(Number(pod.id))!
    if (mode === 'loading') instance.actual_status = 'loading'
    const attachPath = '/api/v0/instances/' + pod.id + '/ssh/'
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
        }
        return ssh!.runner.run(command, args, signal, timeoutMs)
      },
    }
    const record = queueHostSetup({ id: pod.id, vendor: 'vast', name: pod.name, recipe: offer.recipe.id, price: pod.cost, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: vast.baseUrl, sshKey: key.path, sessionId: 'attach-key-session' })
    const start = Date.now()
    await runHostJob(record.id, record.generation!, { runner, pauseMs: 20, timeoutMs: 400, engineGraceMs: 100, keepAlive: false })
    const ended = readHostRecord(pod.id)!
    const sent = vast.requests.filter((row: any) => row.method === 'POST' && row.path === attachPath)
    if (mode === 'accept' || mode === 'refuse') {
      check(mode + ': one attach uses the exact instance path and registered public key body', sent.length === 1 && Object.keys(sent[0]!.body).join(',') === 'ssh_key' && sent[0]!.body.ssh_key === key.publicKey && sent[0]!.authorization === 'Bearer ' + vast.key, JSON.stringify(sent))
      check(mode + ': attachment waits until the deadline then retries SSH on the same instance', sent.length === 1 && sent[0]!.at - start >= 350 && probesAfterAttach >= 3 && vast.state.pods.has(Number(pod.id)), JSON.stringify({ sent: sent[0]?.at, start, probesAfterAttach, sshTimes }))
      if (mode === 'accept') check('attachment unblocks setup and registers a ready engine', ended.jobState === 'ready' && ended.provider !== undefined, ended.error)
      else {
        const posted = notices(pod.id)
        if (posted[0]) await captureHostNotice(posted[0], 'vast-key-attached-paused')
        check('continued refusal pauses once with attachment and retry, machine, rate and actions', ended.jobState === 'paused' && posted.length === 1 && posted[0]!.includes('Mercury attached the SSH key to this instance and retried') && posted[0]!.includes('Vast.ai instance ' + pod.id) && posted[0]!.includes('$' + pod.cost.toFixed(2) + '/hr still billing') && posted[0]!.includes('Resume or Terminate in /llmhost'), posted.join('\n'))
      }
    } else if (mode === 'attach-failed') {
      check('an attachment refusal is not retried or claimed successful, and the machine pauses', sent.length === 1 && ended.jobState === 'paused' && ended.error?.includes('could not attach the SSH key') && !ended.error.includes('attached the SSH key to this instance and retried'), ended.error)
    } else check(mode + ': no key is attached without a running instance refusing publickey', sent.length === 0 && ended.jobState === 'paused', ended.error)
    check(mode + ': no terminate or replacement and no secrets in the notice', vast.state.deletes === 0 && !notices(pod.id).some(text => text.includes(vast.key) || text.includes(key.publicKey)), notices(pod.id).join('\n'))
    closeHostTunnel(pod.id)
  }
  check('all requests stayed on loopback', escaped.length === 0)
  if (failures.length) throw new Error(failures.length + ' attach-key checks failed: ' + failures.join('; '))
  console.log('VAST ATTACH KEY GREEN · ' + checks + ' checks')
} finally { globalThis.fetch = nativeFetch; ssh?.close(); await vast.close(); f.close() }
