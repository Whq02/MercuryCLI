import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from './lib/llmhostFixture.ts'

const f = await llmhostFixture()
const mode = process.argv[2] ?? 'window'
try {
  const { resetSettingsCache } = await import(`${f.root}/src/platform/settings/settingsCache.ts`)
  const { SettingsSchema } = await import(`${f.root}/src/platform/settings/settingsSchema.ts`)
  const catalogue = await import(`${f.root}/src/models/roads/openaicompat/compatCatalogue.ts`)
  const { getContextWindowForModel } = await import(`${f.root}/src/models/facts/capabilities.ts`)
  const { compatProviderAdapter } = await import(`${f.root}/src/models/roads/openaicompat/compatAdapter.ts`)
  const id = `compat/llmhost/${f.model}`
  const configure = (dialect: string, extra = {}) => {
    const settings = { compatProvider: { llmhost: { baseUrl: f.baseUrl, dialect, sessionAffinityHeader: 'x-session-id' } }, ...extra }
    assert.ok(SettingsSchema().safeParse(settings).success, `${dialect} dialect settings must be accepted`)
    writeFileSync(join(f.home, 'settings.json'), JSON.stringify(settings))
    resetSettingsCache()
  }
  if (mode === 'window') {
    for (const field of ['max_model_len', 'context_length']) {
      f.state.field = field
      configure('vllm')
      await catalogue.refreshCompatCatalogues({ force: true })
      assert.equal(getContextWindowForModel(id), 1_048_576, `${field} reaches the request budget`)
      assert.equal(compatProviderAdapter.describe().catalogue.find((row: any) => row.id === id)?.contextWindow, 1_048_576)
    }
    for (const dialect of ['sglang', 'llamacpp', 'ollama']) {
      f.state.field = dialect === 'sglang' ? 'max_model_len' : ''; f.state.dialect = dialect
      configure(dialect)
      await catalogue.refreshCompatCatalogues({ force: true })
      assert.equal(getContextWindowForModel(id), 1_048_576, `${dialect} native metadata reaches the budget`)
    }
    f.state.dialect = 'llamacpp'; f.state.window = 131_072; f.state.slots = 4
    configure('llamacpp')
    await catalogue.refreshCompatCatalogues({ force: true })
    assert.equal(getContextWindowForModel(id), 131_072, 'llama.cpp reports n_ctx per slot in /props (--ctx-size 524288 --parallel 4 → 131072) and the budget takes it as is')
    f.state.window = 1_048_576; f.state.slots = 1
    configure('ollama', { models: { [id]: { contextWindow: 1_200_000 } } })
    assert.equal(getContextWindowForModel(id), 1_200_000, 'the explicit model override wins')
    configure('ollama', { models: { [id]: { contextWindow: 65_536 } } })
    assert.equal(getContextWindowForModel(id), 65_536, 'a smaller explicit override also wins')
    configure('vllm'); f.state.field = 'max_model_len'; f.state.window = -1
    await catalogue.refreshCompatCatalogues({ force: true })
    assert.notEqual(getContextWindowForModel(id), -1, 'invalid metadata never becomes a budget')
    f.state.window = 32_768
    await catalogue.refreshCompatCatalogues({ force: true })
    assert.equal(getContextWindowForModel(id), 32_768, 'a small server window is not raised to the default')
  } else {
    const dialect = mode === 'sglang' ? 'sglang' : 'vllm'
    configure(dialect)
    f.state.mode = 'tools'
    const messages: any[] = [f.createUserMessage({ content: 'do two fixture calls' })]
    for (let n = 0; n < 3; n++) {
      const replies = await f.run(id, messages)
      assert.ok(replies.length && replies.every(row => !row.isApiErrorMessage), 'the routed turn settles')
      const body = f.captures.at(-1)!.body
      assert.equal(body.model, f.model)
      assert.equal(body.reasoning_effort, 'max')
      assert.ok(body.tools.some((row: any) => row.function.name === 'FixtureEcho'), `src/models/roads/openaicompat/compatChatClient.ts ${dialect} turn ${n} request missing FixtureEcho tool`)
      assert.ok(f.captures.at(-1)!.affinity, `src/models/roads/openaicompat/compatChatClient.ts ${dialect} turn ${n} missing sessionAffinityHeader`)
      if (dialect === 'sglang') assert.equal(body.chat_template_kwargs?.clear_thinking, false)
      for (let prior = 0; prior < n; prior++) {
        assert.ok(body.messages.some((row: any) => row.role === 'assistant' && row.reasoning_content?.includes(`reasoning-${prior}`)), `reasoning-${prior} is replayed on tool turn ${n}`)
        assert.ok(body.messages.some((row: any) => row.role === 'tool' && row.tool_call_id === `fixture-call-${prior}`), `src/models/roads/openaicompat/compatChatClient.ts ${dialect} turn ${n} missing tool_result fixture-call-${prior}`)
      }
      messages.push(...replies)
      if (n < 2) messages.push(f.createUserMessage({ content: [{ type: 'tool_result', tool_use_id: `fixture-call-${n}`, content: 'hello' }] }))
      else assert.equal(replies.at(-1).message.usage.input_tokens, 10)
    }
    messages.push(f.createUserMessage({ content: 'continue' }))
    await f.run(id, messages)
    assert.ok(f.captures.at(-1)!.body.messages.some((row: any) => row.reasoning_content?.includes('reasoning-0')), 'reasoning also survives a later user turn')
    const prior = f.captures.length
    const controller = new AbortController(); controller.abort()
    await f.run(id, messages, controller.signal)
    assert.equal(f.captures.length, prior)
    f.state.mode = 'refuse'
    const refusedReplies = await f.run(id)
    assert.ok(refusedReplies.some(row => row.isApiErrorMessage && row.error === 'authentication_failed'), `src/models/roads/openaicompat/compatChatClient.ts ${dialect} 401 refusal expected authentication_failed: got ${JSON.stringify(refusedReplies.map(r => r.error))}`)
    f.state.mode = 'retry'
    const retriedReplies = await f.run(id)
    assert.ok(retriedReplies.some(row => row.message.content.some((part: any) => part.text === 'LLMHOST-READY')), `src/models/roads/openaicompat/compatChatClient.ts ${dialect} retry did not yield LLMHOST-READY`)
    f.state.mode = 'truncated'
    const truncatedReplies = await f.run(id)
    assert.ok(truncatedReplies.some(row => row.isApiErrorMessage), `src/models/roads/openaicompat/compatChatClient.ts ${dialect} truncated stream did not yield isApiErrorMessage`)
  }
  console.log(`LLMHOST WIRE ${mode.toUpperCase()} GREEN — loopback only`)
} finally { f.close() }
