#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w04-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.HF_TOKEN
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function withServer(
  handler: (req: { url?: string; headers: Record<string, string | string[] | undefined> }) => { status: number; body: string; contentType?: string },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    const reply = handler(req)
    res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json' })
    res.end(reply.body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

try {
  {
    const { chooseWeightsSource } = await import('../../src/services/host/weightsSource.ts')
    const { runLocalSetupRoad } = await import('../../src/services/localSetup/ggufRoad.ts')
    const { runModelDoor } = await import('../../src/services/host/door.ts')
    const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
    const recipe = HOST_RECIPES.find(row => row.engine === 'llamacpp')!
    const secretsFile = join(home, '.provider-secrets.json')

    let absentPrivateLabel = ''
    await chooseWeightsSource(
      { recipe, vendor: 'runpod', managed: false },
      undefined,
      async plan => {
        absentPrivateLabel = plan.rows?.find(row => row.value === 'private-repo')?.label ?? ''
        return 'back'
      },
      () => {},
      new AbortController().signal,
    )
    check(
      'w04-1 absent HF key still labels private-repo with /logins huggingface',
      absentPrivateLabel.includes('/logins huggingface') && !absentPrivateLabel.includes('could not be read'),
      absentPrivateLabel,
    )

    writeFileSync(secretsFile, '{not valid json\n', { mode: 0o600 })
    try {
      const emitted: string[] = []
      let stepCount = 0
      let unreadableLabel = ''
      await chooseWeightsSource(
        { recipe, vendor: 'runpod', managed: false },
        undefined,
        async plan => {
          stepCount++
          if (stepCount === 1) {
            unreadableLabel = plan.rows?.find(row => row.value === 'private-repo')?.label ?? ''
            return 'private-repo'
          }
          return 'back'
        },
        event => { emitted.push(event.words) },
        new AbortController().signal,
      )
      check(
        'w04-1 weightsSource reports unreadable HF key instead of absent key',
        unreadableLabel.includes('the Hugging Face key could not be read (') &&
          unreadableLabel.includes('so this went out without it') &&
          emitted.some(words => words.includes('the Hugging Face key could not be read (') && words.includes('so this went out without it')),
        JSON.stringify({ unreadableLabel, emitted }),
      )

      await withServer(
        req => {
          if (req.url?.startsWith('/api/models?')) {
            return {
              status: 200,
              body: JSON.stringify([
                {
                  id: 'org/gated-chat',
                  downloads: 500,
                  gated: 'manual',
                  private: false,
                  pipeline_tag: 'text-generation',
                  tags: ['text-generation'],
                  siblings: [{ rfilename: 'model-Q4_K_M.gguf' }],
                },
              ]),
            }
          }
          return { status: 403, body: JSON.stringify({ error: 'gated' }) }
        },
        async baseUrl => {
          let ggufEnded = ''
          for await (const event of runLocalSetupRoad(async () => 'stop', {
            repo: 'org/gated-chat',
            hubBase: baseUrl,
            home,
            platform: 'darwin',
            totalMemoryBytes: 64 * 1024 ** 3,
          })) {
            if (event.type === 'done') ggufEnded = event.summary.words
          }
          check(
            'w04-1 ggufRoad appends unreadable HF key note on failed repo lookup',
            ggufEnded.includes('the Hugging Face key could not be read (') && ggufEnded.includes('so this went out without it'),
            ggufEnded,
          )

          const prevBase = process.env.MERCURY_HOST_HF_API_BASE
          process.env.MERCURY_HOST_HF_API_BASE = baseUrl
          try {
            let doorWillRun = ''
            let phase = 0
            await runModelDoor(
              async plan => {
                if (plan.step !== 'door-models') return null
                if (phase === 0) {
                  phase = 1
                  return 'search:gated'
                }
                if (phase === 1) {
                  if (plan.rows?.some(row => row.value === 'hf:org/gated-chat')) {
                    phase = 2
                    return 'hf:org/gated-chat'
                  }
                  return new Promise<string | null>(() => {})
                }
                doorWillRun = plan.willRun
                return null
              },
              () => {},
              new AbortController().signal,
              {
                offers: async () => [],
                pods: async () => [],
                records: () => [],
                road: async () => ({ ok: false, words: 'unused' }),
              },
            )
            check(
              'w04-1 door appends unreadable HF key note on gated HF pick',
              doorWillRun.includes('the Hugging Face key could not be read (') && doorWillRun.includes('so this went out without it'),
              doorWillRun,
            )
          } finally {
            if (prevBase === undefined) delete process.env.MERCURY_HOST_HF_API_BASE
            else process.env.MERCURY_HOST_HF_API_BASE = prevBase
          }
        },
      )
    } finally {
      chmodSync(secretsFile, 0o600)
      rmSync(secretsFile, { force: true })
    }
  }

  {
    const { runpodFixture } = await import('../host/runpodFixture.mjs')
    const { createHostRoad } = await import('../../src/services/host/index.ts')
    const { sweepHostIdle, HOST_IDLE_LIMIT_MS } = await import('../../src/services/host/idle.ts')
    const { writeHostRecord, readHostRecord, removeHostRecord } = await import('../../src/services/host/store.ts')
    const { saveVendorKey, vendorClient } = await import('../../src/services/host/vendors/client.ts')
    const rp = await runpodFixture()
    const daemonDir = join(home, 'daemon')
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 })
    const workersFile = join(daemonDir, 'concourse-workers.json')
    writeFileSync(workersFile, '{corrupt json\n', { mode: 0o600 })
    try {
      saveVendorKey('runpod', rp.key)
      const api = vendorClient('runpod', { key: rp.key, apiBaseUrl: rp.baseUrl })
      const offer = (await api.offers(new AbortController().signal))[0]!
      const sessionId = '22222222-2222-4222-8222-222222222222'
      const hostedModel = 'compat/pod-w04/qwen'
      const priorModel = 'compat/local/base'

      const pod1 = await api.create(offer, 'ssh-ed25519 fixture', 'w04-idle-restore')
      const oldAt = Date.now() - HOST_IDLE_LIMIT_MS - 60_000
      writeHostRecord({
        id: pod1.id,
        vendor: 'runpod',
        name: pod1.name,
        recipe: offer.recipe.id,
        price: pod1.cost,
        startedAt: new Date(oldAt).toISOString(),
        status: 'RUNNING',
        jobState: 'ready',
        steps: [{ step: 'ready', at: oldAt }],
        advancedAt: oldAt,
        apiBaseUrl: rp.baseUrl,
        sessionId,
        sessionModel: hostedModel,
        sessionModelBefore: priorModel,
      })
      await sweepHostIdle({ now: Date.now() })
      const afterIdle = readHostRecord(pod1.id)
      check(
        'w04-2 idle termination adds restore failure sentence when session cannot be switched back',
        Boolean(afterIdle?.error?.includes(' · this session stays on a model that is gone (')) &&
          Boolean(afterIdle?.error?.includes(') — run /model ' + priorModel)),
        afterIdle?.error ?? '(no error)',
      )
      removeHostRecord(pod1.id)

      const pod2 = await api.create(offer, 'ssh-ed25519 fixture', 'w04-road-restore')
      writeHostRecord({
        id: pod2.id,
        vendor: 'runpod',
        name: pod2.name,
        recipe: offer.recipe.id,
        price: pod2.cost,
        startedAt: pod2.createdAt,
        status: 'RUNNING',
        jobState: 'ready',
        apiBaseUrl: rp.baseUrl,
        sessionId,
        sessionModel: hostedModel,
        sessionModelBefore: priorModel,
      })
      const road = createHostRoad({ apiBaseUrl: rp.baseUrl, pauseMs: 1 })
      const result = await road(
        async q => {
          if (q.step === 'door-models') return 'pods'
          if (q.step === 'paid-pods') return pod2.id
          if (q.step === 'pod-controls' || q.step === 'pod-confirm') return 'terminate'
          return null
        },
        () => {},
        new AbortController().signal,
      )
      check(
        'w04-2 host road termination adds restore failure sentence when session cannot be switched back',
        result.ok &&
          result.words.includes(' · this session stays on a model that is gone (') &&
          result.words.includes(') — run /model ' + priorModel),
        result.words,
      )
    } finally {
      rmSync(workersFile, { force: true })
      await rp.close()
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
