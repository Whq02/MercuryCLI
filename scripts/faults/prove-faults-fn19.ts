#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function withScratchConfig<T>(fn: (dir: string) => T): T {
  const saved = process.env.MERCURY_CONFIG_DIR
  const dir = mkdtempSync(join(tmpdir(), 'prove-faults-fn19-'))
  process.env.MERCURY_CONFIG_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (saved === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = saved
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('1 · qualificationStore: unreadable or corrupt file returns empty on read and is not clobbered on write')
{
  const q = await import('../../src/services/providers/openai/qualificationStore.js')
  withScratchConfig(() => {
    const file = q.__qualificationFilePathForTest()
    check('absent file reads as empty receipts', q.readQualificationReceipts().length === 0)

    writeFileSync(file, '{broken json', 'utf8')
    check('corrupt file returns empty on readQualificationReceipts', q.readQualificationReceipts().length === 0)
    check('corrupt file returns empty on readWireEffortVocabularies', q.readWireEffortVocabularies().length === 0)
    check('corrupt file returns undefined on wireEffortVocabularyOf', q.wireEffortVocabularyOf('gpt-5', 'api-key') === undefined)

    const writeOnCorrupt = q.recordLiveQualification({ modelId: 'gpt-5', role: 'primary', sourceKind: 'api-key', now: () => 100 })
    check('recordLiveQualification refuses to overwrite corrupt file', writeOnCorrupt === undefined && readFileSync(file, 'utf8') === '{broken json')

    const wireOnCorrupt = q.recordWireEffortRefusal({ modelId: 'gpt-5', sourceKind: 'api-key', refused: 'high', levels: ['low'], now: () => 100 })
    check('recordWireEffortRefusal refuses to overwrite corrupt file', wireOnCorrupt === undefined && readFileSync(file, 'utf8') === '{broken json')

    if (POSIX_MODES) {
      const valid = JSON.stringify({ version: 1, receipts: [] }) + '\n'
      writeFileSync(file, valid, { mode: 0o600 })
      chmodSync(file, 0o200)
      const receiptsOnUnreadable = q.readQualificationReceipts()
      const wireOnUnreadable = q.readWireEffortVocabularies()
      const writeOnUnreadable = q.recordLiveQualification({ modelId: 'gpt-5', role: 'primary', sourceKind: 'api-key', now: () => 100 })
      chmodSync(file, 0o600)
      check('unreadable file returns empty on readers', receiptsOnUnreadable.length === 0 && wireOnUnreadable.length === 0)
      check('recordLiveQualification leaves unreadable file untouched', writeOnUnreadable === undefined && readFileSync(file, 'utf8') === valid)
    }
  })
}

console.log('2 · compatPrefixCache: compatEndpointLastTurnAt distinguishes absent from corrupt or unreadable')
{
  const { compatEndpointLastTurnAt, noteCompatPrefixCache } = await import('../../src/services/providers/openaicompat/compatPrefixCache.js')
  const { compatEndpointDigest } = await import('../../src/services/providers/openaicompat/compatSlots.js')
  withScratchConfig(dir => {
    const endpoint = { baseUrl: 'http://127.0.0.1:8080/v1' }
    check('absent prefix cache returns undefined', compatEndpointLastTurnAt(endpoint) === undefined)

    const cacheDir = join(dir, 'cache', 'compat-prefix')
    mkdirSync(cacheDir, { recursive: true })
    const file = join(cacheDir, compatEndpointDigest(endpoint.baseUrl) + '.json')
    writeFileSync(file, '{corrupt', 'utf8')
    let corruptErr: unknown
    try {
      compatEndpointLastTurnAt(endpoint)
    } catch (error) {
      corruptErr = error
    }
    check('corrupt prefix cache throws on compatEndpointLastTurnAt', corruptErr instanceof Error, String(corruptErr))

    if (POSIX_MODES) {
      noteCompatPrefixCache(endpoint, 'm', { inputTokens: 10, outputTokens: 2, cachedInputTokens: 5 })
      chmodSync(file, 0o200)
      let eaccesErr: unknown
      try {
        compatEndpointLastTurnAt(endpoint)
      } catch (error) {
        eaccesErr = error
      }
      chmodSync(file, 0o600)
      check('unreadable prefix cache throws EACCES on compatEndpointLastTurnAt', (eaccesErr as NodeJS.ErrnoException | undefined)?.code === 'EACCES', String(eaccesErr))
    }
  })
}

console.log('3 · xaiCallModel: resolveCredential propagates credential read or refresh errors')
{
  const { spawnSync } = await import('node:child_process')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const srcRoot = process.env.PROVE_SRC ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../src')
  const xaiAccountsPath = join(srcRoot, 'services/providers/xai/xaiAccounts.ts')
  const xaiCallModelPath = join(srcRoot, 'services/providers/xai/xaiCallModel.ts')
  withScratchConfig(dir => {
    const script = `
      globalThis.MACRO = { VERSION: '1.0.0' }
      process.env.NODE_ENV = 'test'
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(dir)}
      delete process.env.XAI_API_KEY
      const { mock } = await import('bun:test')
      const actual = await import(${JSON.stringify(xaiAccountsPath)})
      let mode = 'absent'
      mock.module(${JSON.stringify(xaiAccountsPath)}, () => ({
        ...actual,
        resolveXaiCredential: async () => {
          if (mode === 'throw') throw new Error('xai refresh boom')
          return undefined
        },
      }))
      const { xaiLaneProfile } = await import(${JSON.stringify(xaiCallModelPath)})
      const absent = await xaiLaneProfile.resolveCredential()
      mode = 'throw'
      let caught = null
      try {
        await xaiLaneProfile.resolveCredential()
      } catch (error) {
        caught = error instanceof Error ? error.message : String(error)
      }
      process.stdout.write(JSON.stringify({ absent: absent === undefined, caught }))
    `
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: dir, XAI_API_KEY: '' } })
    const out = res.status === 0 ? (JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { absent?: boolean; caught?: string | null }) : {}
    check('absent xAI credential still returns undefined', res.status === 0 && out.absent === true, res.stderr.slice(-300))
    check('throwing resolveXaiCredential rejects with the same error', res.status === 0 && out.caught === 'xai refresh boom', JSON.stringify(out))
  })
}

console.log('4 · streamIdleBudget: estimateRequestTokens falls back to body length over four when estimator throws')
{
  const { spawnSync } = await import('node:child_process')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const srcRoot = process.env.PROVE_SRC ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../src')
  const tokenEstPath = join(srcRoot, 'services/tokenEstimation.ts')
  const budgetPath = join(srcRoot, 'services/providers/streamIdleBudget.ts')
  const { estimateRequestTokens } = await import('../../src/services/providers/streamIdleBudget.js')

  const circular: Record<string, unknown> = { payload: 'a'.repeat(40_000) }
  circular.self = circular
  const circularEst = estimateRequestTokens(circular, 'test-model')
  check('circular 40k body estimates about length/4 instead of 1', circularEst >= 9_000 && circularEst <= 12_000, `got ${circularEst}`)
  check('undefined body still estimates as 1', estimateRequestTokens(undefined) === 1)

  const script = `
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.env.NODE_ENV = 'test'
    const { mock } = await import('bun:test')
    const actual = await import(${JSON.stringify(tokenEstPath)})
    mock.module(${JSON.stringify(tokenEstPath)}, () => ({
      ...actual,
      estimateRequestTokens: () => { throw new Error('estimator boom') },
    }))
    const { estimateRequestTokens } = await import(${JSON.stringify(budgetPath)})
    const big = { messages: [{ role: 'user', content: 'x'.repeat(40_000) }] }
    const est = estimateRequestTokens(big, 'test-model')
    process.stdout.write(JSON.stringify({ est }))
  `
  const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  const out = res.status === 0 ? (JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { est?: number }) : {}
  check('throwing estimator on 40k body answers about length/4 instead of 1', res.status === 0 && typeof out.est === 'number' && out.est >= 9_000 && out.est <= 12_000, `${res.stderr.slice(-200)} ${JSON.stringify(out)}`)
}

console.log('5 · qwenAccounts: malformed DASHSCOPE_BASE_URL refuses dispatch instead of falling back')
{
  const qa = await import('../../src/services/providers/qwen/qwenAccounts.js')
  const env: NodeJS.ProcessEnv = { DASHSCOPE_API_KEY: 'sk-fixture-qwen', DASHSCOPE_BASE_URL: 'not a valid url' }
  check('resolveQwenAccount stays non-throwing on malformed DASHSCOPE_BASE_URL', qa.resolveQwenAccount(env)?.kind === 'api-key')
  let dispatchErr: unknown
  try {
    await qa.resolveQwenCredential({ env })
  } catch (error) {
    dispatchErr = error
  }
  const msg = dispatchErr instanceof Error ? dispatchErr.message : ''
  check('resolveQwenCredential rejects malformed DASHSCOPE_BASE_URL with the sentence', msg.includes('DASHSCOPE_BASE_URL is not a valid http(s) URL') && msg.includes('requests are not sent to another endpoint') && msg.includes('fix or unset DASHSCOPE_BASE_URL, then retry.'), msg)
  const validEnv: NodeJS.ProcessEnv = { DASHSCOPE_API_KEY: 'sk-fixture-qwen', DASHSCOPE_BASE_URL: 'https://example.invalid/v1' }
  const ok = await qa.resolveQwenCredential({ env: validEnv })
  check('valid DASHSCOPE_BASE_URL still resolves normally', ok?.requestUrl === 'https://example.invalid/v1/chat/completions')
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
