import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import { captureHostNotice } from './hostLinkFrames.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const rp = await runpodFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  if (!['127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)) { escaped.push(request.url); throw new Error('Link proof permits loopback only') }
  return nativeFetch(request)
}, nativeFetch)
const failures: string[] = []
let checks = 0
const check = (name: string, truth: unknown, detail = '') => { if (truth) { checks++; console.log('PASS ' + name) } else { failures.push(name); console.error('FAIL ' + name + ': ' + detail) } }
const until = async (test: () => boolean) => { const end = Date.now() + 20_000; while (!test()) { assert.ok(Date.now() < end, 'worker settles'); await new Promise(resolve => setTimeout(resolve, 20)) } }
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const { hostRunner, closeHostTunnel } = await import('../../src/services/host/ssh.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { readHostRecord, hostDirectory } = await import('../../src/services/host/store.ts')
  const { vendorClient, saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { HOST_IDLE_LIMIT_MS, sweepHostIdle } = await import('../../src/services/host/idle.ts')
  saveVendorKey('runpod', rp.key)
  const api = vendorClient('runpod', { key: rp.key, apiBaseUrl: rp.baseUrl })
  const offer = (await api.offers(new AbortController().signal)).find(row => row.recipe.id === 'qwen38-27b-rtx-pro-6000')!
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  let down = false
  let unread = false
  const runner = { run: (...args: Parameters<typeof ssh.runner.run>) => unread && args[1].at(-1)?.startsWith('tail -n 8 ') ? Promise.reject(new Error('fixture log read refused')) : ssh!.runner.run(...args), tunnel: (args: string[]) => down ? { stop() {}, failed: () => 'fixture: connection refused' } : ssh!.runner.tunnel(args) }
  const notices = (id: string) => readdirSync(join(hostDirectory(), 'notices')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(hostDirectory(), 'notices', name), 'utf8')).words as string).filter(words => words.includes(id))
  const rent = async (name: string) => {
    const pod = await api.create(offer, 'ssh-ed25519 fixture', name)
    const record = queueHostSetup({ id: pod.id, vendor: 'runpod', name: pod.name, recipe: offer.recipe.id, price: pod.cost, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: rp.baseUrl, sessionId: 'link-pause-session' })
    const job = runHostJob(record.id, record.generation!, { runner, pauseMs: 20, timeoutMs: 10000 })
    await until(() => readHostRecord(pod.id)?.jobState === 'ready')
    return { pod, job }
  }
  const first = await rent('link-pause-resume')
  const ready = readHostRecord(first.pod.id)!
  ssh.state.log += 'engine still serving requests\nlast request finished\n'
  down = true; closeHostTunnel(first.pod.id); await first.job
  const paused = readHostRecord(first.pod.id)!
  const posted = notices(first.pod.id).filter(words => !words.includes('is ready'))
  check('B: a lost ready tunnel pauses with no terminate and the machine still running', paused.jobState === 'paused' && paused.status === 'RUNNING' && rp.state.deletes === 0 && rp.state.pods.has(first.pod.id), JSON.stringify(paused))
  check('B: one pause names the machine, five reconnects, rate and actions', posted.length === 1 && posted[0]!.includes('<status>stopped') && posted[0]!.includes('Runpod pod ' + first.pod.id) && posted[0]!.includes('5 reconnects') && posted[0]!.includes('stays up and bills $' + first.pod.cost.toFixed(2) + '/hr while paused') && posted[0]!.includes('Resume reconnects, Terminate stops the bill'), posted.join('\n'))
  check('B: the pause detail carries the last engine lines from the pre-reconnect read', posted[0]?.includes('Last engine lines:\nengine still serving requests\nlast request finished') && !posted[0]?.includes('engine log unread'), posted.join('\n'))
  if (posted[0]) await captureHostNotice(posted[0], 'link-pause-engine-tail')
  const before = ssh.commands.length
  down = false
  const resumed = queueHostSetup(paused)
  await runHostJob(resumed.id, resumed.generation!, { runner, pauseMs: 20, timeoutMs: 10000, keepAlive: false })
  const after = readHostRecord(first.pod.id)!
  const commands = ssh.commands.slice(before)
  check('B: Resume reopens the same port and provider on the same rental', after.jobState === 'ready' && after.localPort === ready.localPort && after.provider === ready.provider && rp.state.creates === 1 && rp.state.deletes === 0, JSON.stringify(after))
  check('B: Resume probes health but never downloads or starts an answering engine', commands.some(row => row.args.at(-1)?.includes('/health')) && !commands.some(row => /nohup setsid|hf download|rsync|MERCURY_WEIGHTS_PRESENT/.test(row.args.at(-1) ?? '')), commands.map(row => row.args.at(-1)).join('\n'))
  closeHostTunnel(first.pod.id)

  const unreadRental = await rent('link-log-unread')
  unread = true; down = true; closeHostTunnel(unreadRental.pod.id); await unreadRental.job
  check('B: an unavailable log read is named honestly in the pause detail', notices(unreadRental.pod.id).some(words => words.includes('engine log unread')) && readHostRecord(unreadRental.pod.id)?.jobState === 'paused')
  unread = false

  for (const kind of ['link', 'engine'] as const) {
    down = false
    const rental = await rent('sweep-' + kind)
    if (kind === 'engine') ssh.state.log += 'MERCURY_ENGINE_EXITED\nMERCURY_ENGINE_CAUSE CUDA out of memory\n'
    else down = true
    closeHostTunnel(rental.pod.id); await rental.job
    const stopped = readHostRecord(rental.pod.id)!
    const deletes = rp.state.deletes
    await sweepHostIdle({ records: [stopped], now: stopped.advancedAt! + HOST_IDLE_LIMIT_MS - 1 })
    check('C: ' + kind + ' pause never terminates before two hours', rp.state.deletes === deletes)
    await sweepHostIdle({ records: [stopped], now: stopped.advancedAt! + HOST_IDLE_LIMIT_MS })
    const expected = 'the ' + (kind === 'engine' ? 'engine died' : 'link dropped') + ' and the pause went unanswered for 2 hours'
    const words = notices(rental.pod.id).filter(words => words.includes('2 hours'))
    check('C: ' + kind + ' sweep states the actual cause before and after verified termination', readHostRecord(rental.pod.id)?.status === 'TERMINATED' && rp.state.deletes === deletes + 1 && words.length === 2 && words.every(text => text.includes(expected) && !text.includes('the setup pause')), words.join('\n'))
    for (const [index, text] of words.entries()) await captureHostNotice(text, 'sweep-' + kind + '-' + index)
    ssh.state.log = ssh.state.log.replace(/MERCURY_ENGINE_EXITED[\s\S]*$/, '')
  }
  check('B/C: loopback only and no credential on screen', escaped.length === 0 && !notices(first.pod.id).some(words => words.includes(rp.key)))
  if (failures.length) throw new Error(failures.length + ' link/pause checks failed: ' + failures.join('; '))
  console.log('HOST LINK PAUSE GREEN · ' + checks + ' checks')
} finally { globalThis.fetch = nativeFetch; ssh?.close(); await rp.close(); f.close() }
