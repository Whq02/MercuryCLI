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

console.log('1 · qualificationStore: a torn file reads as empty and is replaced by the next write; an unreadable file is left as it is')
{
  const q = await import('../../src/models/roads/openai/qualificationStore.js')
  withScratchConfig(() => {
    const file = q.__qualificationFilePathForTest()
    check('absent file reads as empty receipts', q.readQualificationReceipts().length === 0, 'fix readQualificationReceipts in src/models/roads/openai/qualificationStore.ts so a missing file reads as an empty list')

    writeFileSync(file, '{broken json', 'utf8')
    check('corrupt file returns empty on readQualificationReceipts', q.readQualificationReceipts().length === 0, 'fix readQualificationReceipts in src/models/roads/openai/qualificationStore.ts so a torn file reads as an empty list')
    check('corrupt file returns empty on readWireEffortVocabularies', q.readWireEffortVocabularies().length === 0, 'fix readWireEffortVocabularies in src/models/roads/openai/qualificationStore.ts so a torn file reads as an empty list')
    check('corrupt file returns undefined on wireEffortVocabularyOf', q.wireEffortVocabularyOf('gpt-5', 'api-key') === undefined, 'fix wireEffortVocabularyOf in src/models/roads/openai/qualificationStore.ts so a torn file answers undefined')

    const writeOnCorrupt = q.recordLiveQualification({ modelId: 'gpt-5', role: 'primary', sourceKind: 'api-key', now: () => 100 })
    const healed = JSON.parse(readFileSync(file, 'utf8')) as { receipts?: unknown[] }
    check('recordLiveQualification replaces a torn file with the new receipt', writeOnCorrupt !== undefined && Array.isArray(healed.receipts) && healed.receipts.length === 1, JSON.stringify(healed) + ' | fix recordLiveQualification in src/models/roads/openai/qualificationStore.ts so a torn file is replaced by a file holding the new receipt')

    writeFileSync(file, '{broken json', 'utf8')
    const wireOnCorrupt = q.recordWireEffortRefusal({ modelId: 'gpt-5', sourceKind: 'api-key', refused: 'high', levels: ['low'], now: () => 100 })
    const healedWire = JSON.parse(readFileSync(file, 'utf8')) as { wireEfforts?: unknown[] }
    check('recordWireEffortRefusal replaces a torn file with the new memory', wireOnCorrupt !== undefined && Array.isArray(healedWire.wireEfforts) && healedWire.wireEfforts.length === 1, JSON.stringify(healedWire) + ' | fix recordWireEffortRefusal in src/models/roads/openai/qualificationStore.ts so a torn file is replaced by a file holding the new memory')

    if (POSIX_MODES) {
      const valid = JSON.stringify({ version: 1, receipts: [] }) + '\n'
      writeFileSync(file, valid, { mode: 0o600 })
      chmodSync(file, 0o200)
      const receiptsOnUnreadable = q.readQualificationReceipts()
      const wireOnUnreadable = q.readWireEffortVocabularies()
      const writeOnUnreadable = q.recordLiveQualification({ modelId: 'gpt-5', role: 'primary', sourceKind: 'api-key', now: () => 100 })
      chmodSync(file, 0o600)
      check('unreadable file returns empty on readers', receiptsOnUnreadable.length === 0 && wireOnUnreadable.length === 0, 'fix readQualificationReceipts and readWireEffortVocabularies in src/models/roads/openai/qualificationStore.ts so an unreadable file reads as an empty list')
      check('recordLiveQualification leaves unreadable file untouched', writeOnUnreadable === undefined && readFileSync(file, 'utf8') === valid, 'fix recordLiveQualification in src/models/roads/openai/qualificationStore.ts so it writes nothing and returns undefined when the file cannot be read')
    }
  })
}

console.log('2 · compatPrefixCache: compatEndpointLastTurnAt distinguishes absent from corrupt or unreadable')
{
  const { compatEndpointLastTurnAt, noteCompatPrefixCache } = await import('../../src/models/roads/openaicompat/compatPrefixCache.js')
  const { compatEndpointDigest } = await import('../../src/models/roads/openaicompat/compatSlots.js')
  withScratchConfig(dir => {
    const endpoint = { baseUrl: 'http://127.0.0.1:8080/v1' }
    check('absent prefix cache returns undefined', compatEndpointLastTurnAt(endpoint) === undefined, 'fix compatEndpointLastTurnAt in src/models/roads/openaicompat/compatPrefixCache.ts so a missing cache file answers undefined')

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
    check('corrupt prefix cache throws on compatEndpointLastTurnAt', corruptErr instanceof Error, String(corruptErr) + ' | fix compatEndpointLastTurnAt in src/models/roads/openaicompat/compatPrefixCache.ts so a corrupt cache file throws')

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
      check('unreadable prefix cache throws EACCES on compatEndpointLastTurnAt', (eaccesErr as NodeJS.ErrnoException | undefined)?.code === 'EACCES', String(eaccesErr) + ' | fix compatEndpointLastTurnAt in src/models/roads/openaicompat/compatPrefixCache.ts so an unreadable cache file throws its EACCES error')
    }
  })
}

console.log('3 · xaiCallModel: resolveCredential propagates credential read or refresh errors')
{
  const { spawnSync } = await import('node:child_process')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const srcRoot = process.env.PROVE_SRC ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../src')
  const xaiAccountsPath = join(srcRoot, 'models/roads/xai/xaiAccounts.ts')
  const xaiCallModelPath = join(srcRoot, 'models/roads/xai/xaiCallModel.ts')
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
    check('absent xAI credential still returns undefined', res.status === 0 && out.absent === true, res.stderr.slice(-300) + ' | fix resolveCredential of xaiLaneProfile in src/models/roads/xai/xaiCallModel.ts so an absent credential returns undefined')
    check('throwing resolveXaiCredential rejects with the same error', res.status === 0 && out.caught === 'xai refresh boom', JSON.stringify(out) + ' | fix resolveCredential of xaiLaneProfile in src/models/roads/xai/xaiCallModel.ts so an error from resolveXaiCredential is rethrown, not swallowed')
  })
}

console.log('4 · streamIdleBudget: an estimator that throws counts the request as 1 token as before, so no fit check refuses on it')
{
  const { spawnSync } = await import('node:child_process')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const srcRoot = process.env.PROVE_SRC ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../src')
  const tokenEstPath = join(srcRoot, 'models/facts/tokenEstimation.ts')
  const budgetPath = join(srcRoot, 'models/roads/streamIdleBudget.ts')
  const { estimateRequestTokens } = await import('../../src/models/roads/streamIdleBudget.js')
  check('undefined body still estimates as 1', estimateRequestTokens(undefined) === 1, 'fix estimateRequestTokens in src/models/roads/streamIdleBudget.ts so an undefined body counts as 1 token')

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
  check('a throwing estimator on a 40k body answers 1 and does not throw', res.status === 0 && out.est === 1, `${res.stderr.slice(-200)} ${JSON.stringify(out)} | fix estimateRequestTokens in src/models/roads/streamIdleBudget.ts so an estimator that throws is caught and the request counts as 1 token`)
}

console.log('5 · qwenAccounts: a DASHSCOPE_BASE_URL that is not a URL is skipped and the turn goes on')
{
  const qa = await import('../../src/models/roads/qwen/qwenAccounts.js')
  const env: NodeJS.ProcessEnv = { DASHSCOPE_API_KEY: 'sk-fixture-qwen', DASHSCOPE_BASE_URL: 'not a valid url' }
  check('resolveQwenAccount stays non-throwing on malformed DASHSCOPE_BASE_URL', qa.resolveQwenAccount(env)?.kind === 'api-key', 'fix resolveQwenAccount in src/models/roads/qwen/qwenAccounts.ts so a malformed DASHSCOPE_BASE_URL does not throw')
  check('qwenBaseOverride answers no override for a malformed DASHSCOPE_BASE_URL', qa.qwenBaseOverride(env) === undefined, 'fix qwenBaseOverride in src/models/roads/qwen/qwenAccounts.ts so a malformed DASHSCOPE_BASE_URL answers no override')
  let dispatchErr: unknown
  try {
    await qa.resolveQwenCredential({ env })
  } catch (error) {
    dispatchErr = error
  }
  check('resolveQwenCredential does not refuse the turn for a malformed DASHSCOPE_BASE_URL', dispatchErr === undefined, String(dispatchErr) + ' | fix resolveQwenCredential in src/models/roads/qwen/qwenAccounts.ts so a malformed DASHSCOPE_BASE_URL is skipped and the turn goes on')
  const validEnv: NodeJS.ProcessEnv = { DASHSCOPE_API_KEY: 'sk-fixture-qwen', DASHSCOPE_BASE_URL: 'https://example.invalid/v1' }
  const ok = await qa.resolveQwenCredential({ env: validEnv })
  check('valid DASHSCOPE_BASE_URL still resolves normally', ok?.requestUrl === 'https://example.invalid/v1/chat/completions', JSON.stringify(ok) + ' | fix resolveQwenCredential and qwenBaseOverride in src/models/roads/qwen/qwenAccounts.ts so a valid DASHSCOPE_BASE_URL is used for the request URL')
}

console.log('6 · qwenLogin: a DASHSCOPE_BASE_URL that is not a URL does not refuse the sign-in')
{
  const { storeQwenApiKeyLogin } = await import('../../src/models/roads/qwen/qwenLogin.js')
  await withScratchConfig(async () => {
    let fetched = 0
    const env: NodeJS.ProcessEnv = { DASHSCOPE_BASE_URL: 'not a valid url' }
    const out = await storeQwenApiKeyLogin('sk-fixture-qwen', {
      env,
      fetchImpl: (async () => {
        fetched++
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
    })
    check('the sign-in goes on to its endpoint check and is not refused for the variable', fetched > 0 && !out.receipt.includes('DASHSCOPE_BASE_URL is not a valid'), JSON.stringify({ fetched, out }) + ' | fix storeQwenApiKeyLogin in src/models/roads/qwen/qwenLogin.ts so a malformed DASHSCOPE_BASE_URL does not stop the sign-in before its endpoint check')
    check('the stored key receipt says once that the variable is not used and where requests go', out.stored && out.receipt.includes('NOTE: DASHSCOPE_BASE_URL is not a usable URL (') && out.receipt.includes('so it is not used and requests go to the endpoint above; fix or unset it.'), JSON.stringify(out) + ' | fix the NOTE built in storeQwenApiKeyLogin in src/models/roads/qwen/qwenLogin.ts so the receipt keeps this wording')
  })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
