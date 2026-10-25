import assert from 'node:assert/strict'
import '../builtin-tools/webfetchFixtureDns.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const pins: Record<string, () => Promise<void>> = {
  '1': async () => {
    const { default: axios } = await import('axios')
    const { getURLMarkdownContent, clearWebFetchCache } = await import('../../src/tools/WebFetchTool/utils.ts')
    const html = '<article><h1>Identifiers</h1><p>snake_case DOCX_NEEDLE_1 café_été 文字_数字 a__b _edge_</p><pre><code>code_name</code></pre></article>'
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req: Request) => new URL(req.url).pathname === '/robots.txt' ? new Response('User-agent: *\nAllow: /') : new Response(html, { headers: { 'content-type': 'text/html' } }) })
    const get = axios.get.bind(axios)
    axios.get = ((url: string, opts: object) => { assert.equal(new URL(url).hostname, 'fixture.example'); return get(`http://127.0.0.1:${server.port}${new URL(url).pathname}`, { ...opts, proxy: false }) }) as typeof axios.get
    try {
      clearWebFetchCache()
      const result = await getURLMarkdownContent('https://fixture.example/identifiers', new AbortController())
      assert.ok(!('type' in result))
      for (const word of ['snake_case', 'DOCX_NEEDLE_1', 'café_été', '文字_数字', 'a__b']) assert.ok(result.content.includes(word), result.content)
      assert.ok(result.content.includes('\\_edge\\_'), result.content)
      assert.ok(result.content.includes('code_name'))
    } finally { axios.get = get; server.stop(true); clearWebFetchCache() }
  },
  '2': async () => {
    const { discoverLocalServers } = await import('../../src/services/providers/local/localDiscovery.ts')
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req: Request) => Response.json(new URL(req.url).pathname === '/v1/models' ? { data: [{ id: 'fixture-llama' }] } : {}) })
    try {
      for (const primary of ['unreachable', 'http-error', 'ok', 'bad-json'] as const) {
        const seen: string[] = []
        const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = new URL(String(input)); seen.push(url.origin)
          if (url.port === '8080' && primary === 'http-error') return new Response('', { status: 503 })
          if (url.port === '8080' && primary === 'bad-json') return new Response('not json')
          if (url.port !== '9931' && !(url.port === '8080' && primary === 'ok')) throw new TypeError('fixture connection refused')
          return fetch(`http://127.0.0.1:${server.port}${url.pathname}`, init)
        }) as typeof fetch
        const result = await discoverLocalServers({ env: {}, fetchImpl })
        if (primary === 'unreachable') assert.equal(result.servers.find(s => s.kind === 'llamacpp')?.baseUrl, 'http://127.0.0.1:9931/v1')
        else assert.ok(!seen.some(url => url.endsWith(':9931')), `${primary} must not silently switch ports`)
        if (primary === 'ok') assert.equal(result.servers.find(s => s.kind === 'llamacpp')?.baseUrl, 'http://127.0.0.1:8080/v1')
        seen.length = 0
        await discoverLocalServers({ env: { MERCURY_LOCAL_PROBE_TARGETS: 'llamacpp=http://127.0.0.1:8080' }, fetchImpl })
        assert.ok(!seen.some(url => url.endsWith(':9931')), 'explicit endpoints do not fall back')
      }
    } finally { server.stop(true) }
  },
  '3': async () => {
    const { inspectCompatServer } = await import('../../src/services/providers/openaicompat/compatProbe.ts')
    const { hostModelEfforts } = await import('../../src/services/providers/openaicompat/compatEffort.ts')
    const rows = [
      { id: 'top', supported_reasoning_levels: ['low', 'high', 'max'], default_reasoning_level: 'high', input_modalities: ['text', 'image'] },
      { id: 'nested', metadata: { supported_reasoning_levels: [{ effort: 'minimal' }, { value: 'medium' }, { level: 'xhigh' }], default_reasoning_level: 'medium' } },
      { id: 'default', metadata: { default_reasoning_level: 'high' } },
      { id: 'empty', supported_reasoning_levels: [], metadata: { supported_reasoning_levels: ['high'] } },
      { id: 'plain' },
    ]
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ data: rows }) })
    try {
      const reading = await inspectCompatServer({ baseUrl: `http://127.0.0.1:${server.port}`, dialect: 'chat-completions' })
      for (const [id, want] of [['top', ['low', 'high', 'max']], ['nested', ['minimal', 'medium', 'xhigh']], ['default', ['high']], ['empty', []]] as const) {
        assert.deepEqual(reading.efforts?.[id], want)
        assert.deepEqual(hostModelEfforts(id, 'chat-completions', reading.efforts?.[id]), want)
      }
      assert.equal(reading.efforts?.plain, undefined)
      assert.equal(reading.capabilities?.top?.reasoning, true)
      assert.equal(reading.capabilities?.top?.images, true)
      for (const dialect of ['responses', 'lmstudio'] as const) assert.deepEqual(hostModelEfforts('top', dialect, reading.efforts?.top), ['low', 'high', 'max'])
      const { configuredCompatEndpoints } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
      const { rememberCompatCatalogue } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
      const { effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
      const previous = process.env.MERCURY_COMPAT_BASE_URL
      process.env.MERCURY_COMPAT_BASE_URL = `http://127.0.0.1:${server.port}/v1`
      try {
        const endpoint = configuredCompatEndpoints().find(row => row.name === 'default')!
        rememberCompatCatalogue(endpoint, reading)
        const picker = effortVocabularyFor('compat/top')
        assert.equal(picker.kind, 'provider')
        assert.deepEqual('vocabulary' in picker ? picker.vocabulary : [], ['low', 'high', 'max'])
      } finally { if (previous === undefined) delete process.env.MERCURY_COMPAT_BASE_URL; else process.env.MERCURY_COMPAT_BASE_URL = previous }
    } finally { server.stop(true) }
  },
  '4': async () => {
    const { normalizeToolSchemaFor } = await import('../../src/utils/normalizeToolSchema.ts')
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const schema = { description: 'MCP object variants', [key]: [
        { type: 'object', properties: { shared: { type: 'string' }, left: { type: 'boolean' } }, required: ['shared', 'left'] },
        { type: 'object', properties: { shared: { enum: ['x'] }, right: { type: 'integer' } }, required: ['shared', 'right'] },
      ] }
      const before = JSON.stringify(schema)
      const result = normalizeToolSchemaFor('anthropic-strict', schema).schema
      assert.equal(result.type, 'object')
      assert.equal(result[key], undefined)
      assert.deepEqual((result.properties as Record<string, unknown>).shared, { [key === 'allOf' ? 'allOf' : 'anyOf']: [{ type: 'string' }, { enum: ['x'] }] })
      assert.deepEqual(result.required, key === 'allOf' ? ['shared', 'left', 'right'] : ['shared'])
      assert.equal(result.description, schema.description)
      assert.equal(JSON.stringify(schema), before)
    }
    const rooted = normalizeToolSchemaFor('anthropic-strict', { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], allOf: [{ type: 'object', properties: { id: { minLength: 1 }, flag: { type: 'boolean' } }, required: ['flag'] }] }).schema
    assert.deepEqual(rooted.required, ['id', 'flag'])
    assert.deepEqual((rooted.properties as Record<string, unknown>).id, { allOf: [{ type: 'string' }, { minLength: 1 }] })
  },
  '5': async () => {
    const { default: hyperlinkSupport } = await import('supports-hyperlinks')
    const supported = hyperlinkSupport.stdout
    const { applyMarkdown } = await import('../../src/utils/markdown.ts')
    const { default: stripAnsi } = await import('strip-ansi')
    const source = 'const u = "https://example.com/a_(b))]}", v = "https://example.com/next"'
    hyperlinkSupport.stdout = true
    try {
      for (const highlight of [undefined, { supportsLanguage: () => true, highlight: (text: string) => text.replace('example', '\u001b[32mexample\u001b[39m') }]) {
        const result = applyMarkdown('```js\n' + source + '\n```', 'dark', highlight as never)
        assert.ok(result.includes('\u001b]8;;https://example.com/a_(b)\u0007'), JSON.stringify(result))
        assert.ok(result.includes('\u001b]8;;https://example.com/next\u0007'))
        assert.equal(stripAnsi(result), source)
      }
      const { default: React } = await import('react')
      const { EventEmitter } = await import('node:events')
      const { PassThrough } = await import('node:stream')
      const { render, Box, flushPendingSyncWork } = await import('../../src/ink.ts')
      const { AppStateProvider } = await import('../../src/state/AppState.tsx')
      const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
      const { HighlightedCode } = await import('../../src/components/HighlightedCode.tsx')
      const { getCliHighlightPromise } = await import('../../src/utils/cliHighlight.ts')
      await getCliHighlightPromise()
      const full = process.env.MERCURY_FULLSCREEN
      const term = process.env.TERM
      process.env.TERM = 'xterm-256color'
      try {
        for (const fullscreen of ['0', '1']) for (const syntaxOff of [true, false]) {
          process.env.MERCURY_FULLSCREEN = fullscreen
          const url = 'https://example.com/a_very_long_path_(balanced)'
          const code = url + ')]}'
          const output = new PassThrough(); output.resume()
          const stdout = Object.assign(output, { columns: 22, rows: 20 }) as unknown as NodeJS.WriteStream
          const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() {}, ref() {}, pause() {}, resume() {} }) as unknown as NodeJS.ReadStream
          const defaults = getDefaultAppState()
          const initialState = { ...defaults, settings: { ...defaults.settings, view: { ...defaults.settings.view, syntaxOff } } }
          const element = React.createElement(AppStateProvider, { initialState, children: React.createElement(Box, { width: 22 }, React.createElement(HighlightedCode, { code, filePath: 'fixture.js', width: 22 })) })
          const instance = await render(element, { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
          try {
            for (let attempt = 0; attempt < 10; attempt++) { flushPendingSyncWork(); await new Promise(resolve => setTimeout(resolve, 10)) }
            const frame = instance.lastFrame()
            const linked = [...frame.matchAll(/\u001b\]8;[^;]*;([^\u0007]+)\u0007([\s\S]*?)\u001b\]8;;\u0007/g)]
            assert.ok(linked.length >= 2, `wrapped fragments: ${JSON.stringify(frame)}`)
            assert.ok(linked.every(match => match[1] === url), JSON.stringify(frame))
            assert.equal(linked.map(match => stripAnsi(match[2]!)).join(''), url)
          } finally { instance.unmount(); instance.cleanup(); output.destroy() }
        }
      } finally {
        if (full === undefined) delete process.env.MERCURY_FULLSCREEN; else process.env.MERCURY_FULLSCREEN = full
        if (term === undefined) delete process.env.TERM; else process.env.TERM = term
      }
    } finally { hyperlinkSupport.stdout = supported }
  },
  '6': async () => {
    const { PATH_EXTRACTORS } = await import('../../src/tools/BashTool/pathValidation.ts')
    for (const path of ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/fd/1', '/dev/fd/2']) assert.deepEqual(PATH_EXTRACTORS.dd(['if=input', `of=${path}`, 'bs=1']), [], path)
    for (const path of ['/dev/sda', '/dev/disk0', '/dev/nullb0', '/dev/fd/10', '/dev/stdout/file', 'output']) assert.deepEqual(PATH_EXTRACTORS.dd([`of=${path}`]), [path], path)
  },
  '7': async () => {
    const { buildEvalPrompt } = await import('../../src/tools/EvalTool/prompt.ts')
    const prompt = await buildEvalPrompt()
    for (const call of ['tool.<Name>(...)', 'agent(prompt, ...)', 'completion(prompt, ...)']) assert.ok(prompt.includes(`await ${call}`), call)
    assert.match(prompt, /Python[^\n]*(?:synchronous|without await|no await)/)
  },
  '8': async () => {
    const { ResponsesStreamFold } = await import('../../src/services/providers/openai/openaiWire.ts')
    const { openaiFaultToTypedError, openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.ts')
    const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
    const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
    const { takesBusyLadder } = await import('../../src/services/providers/busyRetry.ts')
    for (const type of ['error', 'response.error', 'response.failed']) {
      for (const code of ['model_not_found', 'openai-model_not_found']) {
        const error = { code, message: 'Model unavailable; try again later.', retry_after: 1 }
        const event = type === 'response.failed' ? { type, response: { error } } : { type, error }
        const faults = new ResponsesStreamFold().fold(event).filter(row => row.type === 'stream-fault')
        assert.equal(faults.length, 1)
        const fault = faults[0]!.fault
        assert.equal(fault.retryable, false, JSON.stringify(fault))
        assert.equal(openaiFaultToTypedError(fault), 'invalid_request')
        assert.equal(takesBusyLadder(fault, 'invalid_request'), false)
      }
    }
    let type = 'error'
    let partial = false
    let hits = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request: Request) => {
      if (request.method !== 'POST') return Response.json({ data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['high'], visibility: 'list', supported_in_api: true }] })
      hits++
      const error = { code: 'model_not_found', message: 'Fixture model is missing. Try again later.' }
      if (type === 'http') return Response.json({ error }, { status: 404, headers: { 'Retry-After': '1' } })
      const events = [
        { type: 'response.created', response: { id: 'missing-fixture' } },
        ...(partial ? [{ type: 'response.output_text.delta', delta: 'partial fixture answer' }] : []),
        type === 'response.failed' ? { type, response: { error } } : { type, error },
      ]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'Retry-After': '1' } })
    } })
    const key = process.env.OPENAI_API_KEY
    const base = process.env.MERCURY_OPENAI_API_BASE
    process.env.OPENAI_API_KEY = 'proof-key-ci-gate-not-a-real-key'
    process.env.MERCURY_OPENAI_API_BASE = `http://127.0.0.1:${server.port}/v1`
    try {
      for (type of ['http', 'error', 'response.failed']) for (partial of type === 'http' ? [false] : [false, true]) {
        hits = 0
        const items: any[] = []
        for await (const item of openaiCallModel({ messages: [{ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'Fixture request' } }], systemPrompt: asSystemPrompt(['Fixture']), thinkingConfig: { type: 'disabled' }, tools: [], signal: new AbortController().signal, options: { model: 'gpt-5.6-sol', querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [] } } as never)) items.push(item)
        assert.equal(hits, 1, `${type} ${partial}: no retries`)
        const errors = items.filter(item => item.type === 'assistant' && item.isApiErrorMessage)
        assert.equal(errors.length, 1)
        assert.equal(errors[0].error, 'invalid_request', `${type} afterContent=${partial}: ${JSON.stringify(errors)}`)
        assert.ok(!JSON.stringify(errors).includes('The stream ended'), 'not a continuable stream cut')
        if (partial) assert.ok(items.some(item => item.type === 'assistant' && item.message.content.some((block: any) => block.text === 'partial fixture answer')))
      }
    } finally {
      if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key
      if (base === undefined) delete process.env.MERCURY_OPENAI_API_BASE; else process.env.MERCURY_OPENAI_API_BASE = base
      server.stop(true)
    }
  },
  '10': async () => {
    const { getURLMarkdownContent, isPreapprovedUrl } = await import('../../src/tools/WebFetchTool/utils.ts')
    for (const url of ['https://docs.python.org\\@evil.example/path', 'http://fixture.example\\host/path', 'HTTPS://fixture.example\\@evil.example/', 'https:\\fixture.example/path', ' https://fixture.example\\@evil.example/', '\u0000https://docs.python.org\\@evil.example/path', 'https://docs.python.org\t\\@evil.example/path']) {
      assert.equal(isPreapprovedUrl(url), false, url)
      await assert.rejects(getURLMarkdownContent(url, new AbortController()), /^Error: Invalid URL$/, url)
    }
    assert.equal(isPreapprovedUrl('https://docs.python.org/3/'), true)
  },
}
let failures = 0
for (const [id, run] of Object.entries(pins)) {
  if (process.argv[2] && process.argv[2] !== id) continue
  try { await run(); console.log(`PASS delta pin ${id}`) }
  catch (error) { failures++; console.error(`FAIL delta pin ${id}:`, error) }
}
process.exitCode = failures ? 1 : 0
