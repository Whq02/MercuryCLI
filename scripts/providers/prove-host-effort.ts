import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from './lib/llmhostFixture.ts'
import { KEY, mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
delete process.env.MERCURY_EFFORT_LEVEL
const f = await llmhostFixture({ model: 'unsloth/GLM-5.3-Flash-GGUF:UD-Q4_K_XL' })
let mounted: Mounted | undefined
try {
  f.state.dialect = 'llamacpp'
  f.state.slots = 4
  const { runLlmHost } = await import(`${f.root}/src/services/llmHost/index.ts`)
  const { updateSettingsForSource } = await import(`${f.root}/src/utils/settings/settings.ts`)
  const { selectableEffortLevels, resolveEffortTruth, effortAdjustedReceiptLine } = await import(`${f.root}/src/utils/effort.ts`)
  const { effortPopupRows, EffortPopup, EffortApplyContext } = await import(`${f.root}/src/commands/effort/EffortPopup.tsx`)
  const { executeEffort } = await import(`${f.root}/src/commands/effort/effort.tsx`)
  const answers: Record<string, string> = { servers: '__add__', address: f.baseUrl, dialect: 'llamacpp', key: '', model: f.model, name: 'effort-host', confirm: 'run' }
  const result = await runLlmHost(async (question: any) => {
    assert.ok(question.step in answers, question.step)
    return answers[question.step]
  }, () => {}, new AbortController().signal)
  assert.ok(result.ok, result.words)
  const id = result.model!
  const settings = JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8'))
  assert.deepEqual(settings.models?.[id]?.efforts, ['low', 'high', 'max'], 'registration records the served template vocabulary, not a universal ladder')
  assert.deepEqual(selectableEffortLevels(id), ['low', 'high', 'max'])
  assert.deepEqual(effortPopupRows(id).map((row: any) => row.word), ['auto', 'low', 'high', 'max'])

  const React = await import('react')
  const { Box } = await import(`${f.root}/src/ink.js`)
  const { AppStateProvider } = await import(`${f.root}/src/state/AppState.tsx`)
  const { getDefaultAppState } = await import(`${f.root}/src/state/AppStateStore.ts`)
  const { ThemeProvider } = await import(`${f.root}/src/components/design-system/ThemeProvider.tsx`)
  const { setEngineModelOverride } = await import(`${f.root}/src/bootstrap/state.ts`)
  const { MODEL_PICKER_CURRENT } = await import(`${f.root}/src/utils/model/modelPickerGroups.ts`)
  const h = React.createElement
  let selected: string | undefined
  let done = ''
  const open = async (model: string, effort?: string) => {
    setEngineModelOverride(model)
    return mountOffscreen(h(AppStateProvider, { initialState: { ...getDefaultAppState(), effortValue: effort } }, h(ThemeProvider, {}, h(Box, { width: 110, height: 30 }, h(EffortApplyContext.Provider, { value: (value: string) => {
      const applied = executeEffort(value, model)
      selected = applied.effortUpdate?.value as string | undefined
      return applied.message
    } }, h(EffortPopup, { onDone: (message: string) => { done = message } }))))), 110, 30)
  }
  mounted = await open(id, 'low')
  assert.ok(await waitFor(() => mounted!.screen().includes('Mercury · effort'), 10000), mounted.screen())
  assert.ok(mounted.lines().some(line => /\blow\b/.test(line) && line.includes(MODEL_PICKER_CURRENT)), mounted.screen())
  assert.ok(!mounted.screen().includes('Opus'), 'a hosted model does not borrow another provider’s capability labels')
  const frames = process.argv.indexOf('--frames')
  if (frames >= 0 && process.argv[frames + 1]) {
    mkdirSync(process.argv[frames + 1]!, { recursive: true })
    writeFileSync(join(process.argv[frames + 1]!, 'hosted-effort.txt'), mounted.screen() + '\n')
  }
  mounted.push(KEY.down)
  assert.ok(await waitFor(() => mounted!.screen().includes('❯ high'), 5000), mounted.screen())
  mounted.push(KEY.enter)
  assert.ok(await waitFor(() => done.length > 0, 5000), mounted.screen())
  assert.equal(selected, 'high')
  assert.match(done, /Effort set to high/)
  mounted.unmount(); mounted = undefined
  const high = await f.run(id, undefined, undefined, selected)
  assert.ok(high.every(row => !row.isApiErrorMessage))
  assert.equal(f.captures.at(-1)!.body.chat_template_kwargs.reasoning_effort, 'high')
  assert.equal(f.captures.at(-1)!.body.reasoning_effort, undefined)
  assert.equal(high.at(-1).effort.wire, 'chat_template_kwargs.reasoning_effort=high')

  const configure = (name: string, dialect: string, wire = f.model, efforts?: string[]) => {
    const model = `compat/${name}/${wire}`
    const changed = updateSettingsForSource('userSettings', { compatProvider: { [name]: { baseUrl: f.baseUrl, dialect, models: [wire] } }, ...(efforts !== undefined ? { models: { [model]: { efforts } } } : {}) } as never)
    assert.equal(changed.error, null)
    return model
  }
  for (const dialect of ['vllm', 'sglang', 'chat-completions']) {
    const model = configure(dialect, dialect, dialect === 'chat-completions' ? 'moonshotai/Kimi-K3' : 'zai-org/GLM-5.3-Flash')
    f.state.dialect = dialect
    assert.deepEqual(selectableEffortLevels(model), ['low', 'high', 'max'])
    const replies = await f.run(model, undefined, undefined, 'high')
    assert.ok(replies.every(row => !row.isApiErrorMessage))
    assert.equal(f.captures.at(-1)!.body.reasoning_effort, 'high', dialect)
    if (dialect === 'sglang') assert.equal(f.captures.at(-1)!.body.chat_template_kwargs.clear_thinking, false)
    if (dialect === 'chat-completions') {
      await f.run(model, [f.createUserMessage({ content: 'first turn' }), ...replies, f.createUserMessage({ content: 'continue' })], undefined, 'high')
      assert.ok(f.captures.at(-1)!.body.messages.some((row: any) => row.reasoning_content === 'reasoning-0'), 'Kimi preserves thinking across turns')
      assert.equal(f.captures.at(-1)!.body.reasoning_effort, 'high')
    }
  }
  const qwen = configure('qwen', 'sglang', 'Qwen/Qwen3.8-27B-FP8')
  assert.deepEqual(selectableEffortLevels(qwen), ['low', 'medium', 'xhigh'])
  await f.run(qwen, undefined, undefined, 'high')
  assert.equal(f.captures.at(-1)!.body.reasoning_effort, 'medium')
  const ds = configure('deepseek', 'sglang', 'deepseek-ai/DeepSeek-V4.1-Flash-1017')
  assert.deepEqual(selectableEffortLevels(ds), ['low', 'high', 'max'])
  const nemotron = configure('nemotron', 'llamacpp', 'unsloth/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-GGUF:UD-Q3_K_XL')
  assert.deepEqual(selectableEffortLevels(nemotron), [])
  mounted = await open(nemotron, 'high')
  assert.ok(await waitFor(() => mounted!.screen().includes('this server has no effort dial'), 10000), mounted.screen())
  mounted.push(KEY.esc)
  mounted.unmount(); mounted = undefined

  const noDial = configure('nodial', 'llamacpp', 'Fixture/NoDial', [])
  f.state.dialect = 'llamacpp'
  assert.deepEqual(selectableEffortLevels(noDial), [])
  assert.equal(resolveEffortTruth(noDial, 'high').supportsEffort, false)
  mounted = await open(noDial, 'high')
  assert.ok(await waitFor(() => mounted!.screen().includes('this server has no effort dial'), 10000), mounted.screen())
  mounted.push(KEY.esc)
  mounted.unmount(); mounted = undefined
  await f.run(noDial, undefined, undefined, 'high')
  assert.equal(f.captures.at(-1)!.body.reasoning_effort, undefined)
  assert.equal(f.captures.at(-1)!.body.chat_template_kwargs?.reasoning_effort, undefined)
  const lm = configure('lm', 'lmstudio')
  assert.deepEqual(selectableEffortLevels(lm), [])
  await f.run(lm, undefined, undefined, 'high')
  assert.equal(f.captures.at(-1)!.body.reasoning_effort, undefined)

  for (const dialect of ['llamacpp', 'vllm', 'sglang']) {
    f.state.dialect = dialect
    const model = configure(`retry-${dialect}`, dialect)
    f.state.mode = 'reject-effort'
    const before = f.captures.length
    const eventStart = f.events.length
    const replies = await f.run(model, undefined, undefined, 'high')
    assert.equal(f.captures.length - before, 2, 'one retry without the rejected field')
    assert.ok(replies.every(row => !row.isApiErrorMessage))
    assert.equal(f.events.slice(eventStart).filter(row => row.type === 'system' && row.error?.message?.includes('server default')).length, 0, 'no error notice interrupts the reply; the settled message carries the adjustment for the turn receipt')
    const adjusted = replies.at(-1).effortAdjusted
    assert.ok(adjusted?.fieldRejected !== undefined, 'the settled reply stamps the rejected field')
    assert.equal(adjusted.asked, 'high')
    assert.equal(adjusted.name, f.model)
    assert.match(effortAdjustedReceiptLine(adjusted), /^effort high: .+ rejected (reasoning_effort|chat_template_kwargs) for .+ — retried once without it; the server default applies$/)
    const first = f.captures[before]!.body
    const second = f.captures[before + 1]!.body
    assert.equal(second.reasoning_effort, undefined)
    assert.equal(second.chat_template_kwargs?.reasoning_effort, undefined)
    assert.deepEqual(second.tools, first.tools)
    assert.deepEqual(second.messages, first.messages)
    assert.equal(second.id_slot, first.id_slot)
    if (dialect === 'sglang') assert.equal(second.chat_template_kwargs.clear_thinking, false)
    assert.equal(replies.at(-1).effort.wire, 'none')
  }
  f.state.dialect = 'llamacpp'
  f.state.mode = 'reject-template'
  const containerStart = f.captures.length
  const containerReplies = await f.run(id, undefined, undefined, 'high')
  assert.equal(f.captures.length - containerStart, 2)
  assert.ok(containerReplies.every(row => !row.isApiErrorMessage))
  assert.equal(f.captures.at(-1)!.body.chat_template_kwargs, undefined, 'a rejected template container is omitted, with the parameter named separately from the message')
  f.state.mode = 'reject-persistent'
  const persistentStart = f.captures.length
  const persistentReplies = await f.run(id, undefined, undefined, 'high')
  assert.equal(f.captures.length - persistentStart, 2, 'a second named 400 is terminal, not an endless retry')
  assert.ok(persistentReplies.some(row => row.isApiErrorMessage))
  f.state.mode = 'reply'
  f.state.dialect = 'ollama'
  f.state.thinkingValues = ['low', 'medium', 'high']
  answers.name = 'ollama-effort'
  answers.dialect = 'ollama'
  const ollama = await runLlmHost(async (question: any) => answers[question.step], () => {}, new AbortController().signal)
  assert.ok(ollama.ok, ollama.words)
  assert.deepEqual(selectableEffortLevels(ollama.model!), ['low', 'medium', 'high'])
  await f.run(ollama.model!, undefined, undefined, 'medium')
  assert.equal(f.captures.at(-1)!.body.reasoning_effort, 'medium', 'Ollama /v1 uses reasoning_effort, not the native think field')
  assert.equal(f.captures.at(-1)!.body.think, undefined)
  f.state.thinkingValues = [false, true]
  answers.servers = 'ollama-effort'
  answers.action = 'recheck'
  const booleanOnly = await runLlmHost(async (question: any) => answers[question.step], () => {}, new AbortController().signal)
  assert.ok(booleanOnly.ok, booleanOnly.words)
  assert.deepEqual(selectableEffortLevels(ollama.model!), [], 'boolean thinking is not a depth ladder')
  await f.run(ollama.model!, undefined, undefined, 'high')
  assert.equal(f.captures.at(-1)!.body.reasoning_effort, undefined)
  f.state.mode = 'reply'
  f.state.dialect = 'sglang'
  await f.run(ds, undefined, undefined, 'max')
  assert.equal(f.captures.at(-1)!.body.reasoning_effort, 'max')
  f.state.mode = 'retry'
  const retryStart = f.captures.length
  await f.run(id, undefined, undefined, 'high')
  assert.equal(f.captures.length - retryStart, 2)
  for (const capture of f.captures.slice(retryStart)) assert.equal(capture.body.chat_template_kwargs.reasoning_effort, 'high')
  f.state.mode = 'reject-other'
  const before = f.captures.length
  const refused = await f.run(id, undefined, undefined, 'high')
  assert.equal(f.captures.length - before, 1, 'unrelated 400 is not hidden by an effort retry')
  assert.ok(refused.some(row => row.isApiErrorMessage))
  f.state.mode = 'reply'
  f.state.dialect = 'llamacpp'
  await f.run(id, undefined, undefined, 'high')
  assert.equal(f.captures.at(-1)!.body.chat_template_kwargs.reasoning_effort, 'high', 'a rejection does not lower future requests')
  executeEffort('auto', id)
  await f.run(id, undefined, undefined, null)
  assert.equal(f.captures.at(-1)!.body.chat_template_kwargs?.reasoning_effort, undefined, 'automatic preserves the server-start default')
  mounted = await open(id)
  assert.ok(await waitFor(() => mounted!.lines().some(line => /\bauto\b/.test(line) && line.includes(MODEL_PICKER_CURRENT)), 10000), mounted.screen())
  mounted.push(KEY.esc)
  console.log('HOST EFFORT GREEN — registered template levels; keyboard popup selection; per-dialect wire; no-dial rows; bounded rejection retry; preserved tools, slots and reasoning options; loopback only')
} finally { mounted?.unmount(); f.close() }
