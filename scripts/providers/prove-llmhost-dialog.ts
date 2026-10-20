import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { llmhostFixture } from './lib/llmhostFixture.ts'
import { KEY, mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'

const f = await llmhostFixture()
try {
  assert.ok(existsSync(join(f.root, 'src/components/LlmHostDialog.tsx')), '/llmhost has its own dialog')
  const { runLlmHost } = await import(`${f.root}/src/services/llmHost/index.ts`)
  const { configuredCompatEndpoints } = await import(`${f.root}/src/services/providers/openaicompat/compatAccounts.ts`)
  const { readStoredCompatApiKey } = await import(`${f.root}/src/services/providers/providerSecrets.ts`)
  const { resetSettingsCache } = await import(`${f.root}/src/utils/settings/settingsCache.ts`)
  const settingsPath = join(f.home, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', compatProvider: { neighbor: { baseUrl: f.baseUrl, models: [f.model] } } }))
  resetSettingsCache()
  const defaults: Record<string, string> = { servers: '__add__', address: f.baseUrl, dialect: 'vllm', key: f.key, model: f.model, name: 'llmhost', confirm: 'run' }
  const drive = async (answers: Record<string, string | null>, onAsk?: (q: any) => void) => {
    const events: any[] = []
    const result = await runLlmHost(async (q: any) => { onAsk?.(q); assert.ok(q.step in answers, `answer for ${q.step}`); return answers[q.step] }, (event: any) => events.push(event), new AbortController().signal)
    assert.ok(!JSON.stringify(events).includes(f.key))
    return result
  }
  f.state.modelIds = [f.model, f.model + '-second']
  for (const stopAt of ['servers', 'address', 'dialect', 'key', 'model', 'name', 'confirm']) {
    const before = readFileSync(settingsPath, 'utf8')
    const result = await drive({ ...defaults, [stopAt]: null })
    assert.equal(result.ok, false)
    assert.equal(readFileSync(settingsPath, 'utf8'), before, `stop at ${stopAt} writes nothing`)
    assert.equal(readStoredCompatApiKey('llmhost'), undefined)
  }
  f.state.modelIds = [f.model]
  assert.equal((await drive(defaults, question => assert.notEqual(question.step, 'model', 'one listed model skips the model question'))).ok, true)
  const saved = readFileSync(settingsPath, 'utf8')
  assert.ok(saved.includes('neighbor') && saved.includes('dark') && !saved.includes(f.key))
  assert.equal(readStoredCompatApiKey('llmhost'), f.key)
  const recheck = await drive({ servers: 'llmhost', action: 'recheck', model: f.model, confirm: 'run' })
  assert.equal(recheck.ok, true)
  assert.equal(readFileSync(settingsPath, 'utf8'), saved, 'recheck leaves settings unchanged')
  f.state.mode = 'truncated'
  const failed = await drive({ servers: 'llmhost', action: 'recheck', model: f.model, confirm: 'run' })
  assert.equal(failed.ok, false)
  assert.equal(failed.registered, true)
  f.state.mode = 'reply'
  const forwarded: Array<string | null> = []
  const second = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    forwarded.push(req.headers.get('authorization'))
    const target = `${f.baseUrl.replace(/\/v1$/, '')}${new URL(req.url).pathname}`
    return fetch(target, { method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body: await req.text() } : {}), redirect: 'error' })
  } })
  try {
    const next = `http://127.0.0.1:${second.port}/v1`
    assert.equal((await drive({ ...defaults, servers: 'llmhost', action: 'repoint', address: next, key: '' })).ok, true)
    assert.ok(forwarded.length > 0 && forwarded.every(auth => auth === null), 'repoint never forwards the old stored key')
    assert.equal(readStoredCompatApiKey('llmhost'), undefined)
    assert.equal(configuredCompatEndpoints().find((row: any) => row.name === 'llmhost')?.baseUrl, next)
  } finally { second.stop(true) }
  const beforeRemove = readFileSync(settingsPath, 'utf8')
  assert.equal((await drive({ servers: 'llmhost', action: 'remove', remove: 'cancel' })).ok, false)
  assert.equal(readFileSync(settingsPath, 'utf8'), beforeRemove)
  assert.equal((await drive({ servers: 'llmhost', action: 'remove', remove: 'remove' })).ok, true)
  assert.deepEqual(configuredCompatEndpoints().map((row: any) => row.name), ['neighbor'])
  const React = await import('react')
  const { LlmHostDialog } = await import(`${f.root}/src/components/LlmHostDialog.tsx`)
  const { ThemeProvider } = await import(`${f.root}/src/components/design-system/ThemeProvider.tsx`)
  const { useInput } = await import(`${f.root}/src/ink.js`)
  for (const [columns, rows] of [[120, 44], [80, 24], [48, 16], [24, 3]] as const) {
    let selected: string | null | undefined
    const road = async (ask: any) => {
      selected = await ask({ step: 'model', title: '4 · choose the model', found: 'listed by fixture', willRun: 'check the chosen model', rows: Array.from({ length: 50 }, (_, n) => ({ value: String(n), label: `fixture-${n} · 1,048,576 tokens` })) })
      return { ok: false, words: 'stopped · nothing more runs' }
    }
    let controlsMounted = false
    let inputRead = 0
    const inputEvents: unknown[] = []
    const InputWitness = () => { useInput((input: string, key: unknown) => { inputRead++; inputEvents.push({ input, key: { ...key as object } }) }); return null }
    const Controls = () => {
      React.useEffect(() => { controlsMounted = true }, [])
      return React.createElement(React.Fragment, {}, React.createElement(InputWitness), React.createElement(LlmHostDialog, { width: columns, rowBudget: rows, road }))
    }
    const element = React.createElement(ThemeProvider, {}, React.createElement(Controls))
    const m = await mountOffscreen(element, columns, rows)
    try {
      assert.ok(await waitFor(() => controlsMounted && m.screen().includes('choose the model'), 5000))
      m.push(KEY.enter)
      assert.ok(await waitFor(() => inputRead === 1, 5000), 'the input owner consumed Enter')
      assert.equal(selected, undefined, 'Enter alone leaves the choice open')
      m.push(KEY.up)
      assert.ok(await waitFor(() => m.screen().includes('› fixture-49'), 5000), `${columns}x${rows} last row stays visible · ${JSON.stringify(inputEvents)}\n${m.screen()}`)
      assert.equal(selected, undefined, 'Enter with no cursor cannot choose a model')
      assert.ok(m.lines().every(line => stringWidth(line) <= columns))
      assert.ok(!m.screen().includes('RENDER ERROR'))
      m.push(KEY.esc)
      assert.ok(await waitFor(() => selected === null && m.screen().includes('stopped'), 5000))
    } finally { m.unmount() }
  }
  console.log('LLMHOST DIALOG GREEN — cancellation at every step, recheck, failed reply, safe repoint, confirmed removal and 120/80/48-column choice screens')
} finally { f.close() }
