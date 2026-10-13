import { deepStrictEqual, equal, rejects, strictEqual, throws } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix, resolve, win32 } from 'node:path'
import ts from 'typescript'

type Paths = typeof import('../../src/utils/sessionStorage/paths.js')
const compiled = ts.transpileModule(readFileSync(resolve(import.meta.dir, '../../src/utils/sessionStorage/paths.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const absent = Object.assign(new Error('absent'), { code: 'ENOENT' })
const broken = Object.assign(new Error('broken'), { code: 'EIO' })

function fixture(path: typeof posix) {
  const events: unknown[][] = []
  const files = new Map<string, string | Error>()
  const directories = new Map<string, unknown[] | Error>()
  const state = {
    cwd: 'project/with dots', home: path.resolve('/proof-home'), session: 'session-one',
    override: undefined as string | null | undefined,
    statError: undefined as Error | undefined,
    resolutionError: undefined as Error | undefined,
    publishError: undefined as Error | undefined,
  }
  const project = (cwd: string) => path.join(state.home, 'projects', encodeURIComponent(cwd))
  const ports: Record<string, unknown> = {
    path,
    'fs/promises': {
      async readdir(dir: string, options?: unknown) {
        events.push(['readdir', dir, options])
        const contents = directories.get(dir) ?? absent
        if (contents instanceof Error) throw contents
        return contents
      },
      async readFile(file: string, encoding: string) {
        events.push(['read', file, encoding])
        const contents = files.get(file) ?? absent
        if (contents instanceof Error) throw contents
        return contents
      },
    },
    '../../bootstrap/state.js': {
      getOriginalCwd: () => { events.push(['cwd']); return state.cwd },
      getSessionId: () => { events.push(['session']); return state.session },
      getSessionProjectDir: () => { events.push(['override']); return state.override },
    },
    '../debug.js': { logForDebugging: (...args: unknown[]) => events.push(['warn', ...args]) },
    '../envUtils.js': { getMercuryHome: () => state.home },
    '../errors.js': { isFsInaccessible: (error: unknown) => error === absent },
    '../fsOperations.js': {
      getFsImplementation: () => ({ statSync(file: string) { events.push(['stat', file]); if (state.statError) throw state.statError; return {} } }),
    },
    '../../substrate/durablePublish.js': {
      async durableAtomicPublish(file: string, text: string) {
        events.push(['publish', file, text])
        if (state.publishError) throw state.publishError
      },
    },
    '../sessionStoragePortable.js': {
      getProjectDir(cwd: string) {
        events.push(['project', cwd])
        if (state.resolutionError) throw state.resolutionError
        return project(cwd)
      },
    },
    '../../rows/storage.js': {
      EPHEMERAL_STORAGE_PROGRESS: new Set(['bash_progress', 'powershell_progress', 'mcp_progress']),
      storageRowPolicy: (type: string) => ['user', 'assistant', 'system', 'attachment'].includes(type) ? { fold: 'message' } : undefined,
    },
  }
  const env: Record<string, string | undefined> = {}
  const api = {} as Paths
  new Function('require', 'exports', 'process', compiled)((name: string) => {
    const key = name.replace(/^node:/, '')
    if (!(key in ports)) throw new Error(`Unexpected dependency ${name}`)
    return ports[key]
  }, api, { env })
  return { api, state, events, files, directories, project, env }
}

for (const path of [posix, win32]) {
  const f = fixture(path)
  const { api, state, events, files, directories, project, env } = f
  const id = 'agent.one' as never
  equal(api.MAX_TRANSCRIPT_READ_BYTES, 50 * 1024 * 1024)
  equal(api.getProjectsDir(), path.join(state.home, 'projects'))
  for (const override of [undefined, null, '', path.resolve('/moved project'), 'relative/../override']) {
    state.override = override
    const base = override ?? project(state.cwd)
    events.length = 0
    equal(api.getTranscriptPath(), path.join(base, `${state.session}.jsonl`))
    deepStrictEqual(events, [['override'], ...(override == null ? [['cwd'], ['project', state.cwd]] : []), ['session']])
    equal(api.getTranscriptPathForSession(state.session), path.join(base, `${state.session}.jsonl`))
    equal(api.getTranscriptPathForSession('other'), path.join(project(state.cwd), 'other.jsonl'))
    for (const subdir of ['', 'workflows/run-one', '../relative', '/absolute', 'C:\\example']) {
      equal(api.setAgentTranscriptSubdir(id, subdir), undefined)
      const root = path.join(base, state.session, 'subagents')
      equal(api.getAgentTranscriptPath(id), path.join(subdir ? path.join(root, subdir) : root, `agent-${id}.jsonl`))
      equal(api.getAgentMetadataPath(id), api.getAgentTranscriptPath(id).replace(/\.jsonl$/, '.meta.json'))
    }
    equal(api.clearAgentTranscriptSubdir(id), undefined)
    equal(api.clearAgentTranscriptSubdir(id), undefined)
    equal(api.getAgentTranscriptPath(id), path.join(base, state.session, 'subagents', `agent-${id}.jsonl`))
    for (const run of ['', 'run-one', '../run', '名前']) {
      equal(api.getWorkflowTranscriptDir(run), path.join(base, state.session, 'subagents', 'workflows', run))
    }
    for (const error of [undefined, absent, broken]) {
      state.statError = error
      events.length = 0
      equal(api.sessionIdExists(state.session), error === undefined)
      deepStrictEqual(events, [['cwd'], ['project', state.cwd], ['stat', path.join(project(state.cwd), `${state.session}.jsonl`)]])
    }
  }
  state.statError = undefined
  state.resolutionError = broken
  throws(() => api.sessionIdExists('other'), error => error === broken)
  state.resolutionError = undefined
  events.length = 0
  equal(api.getProjectDir('new-folder'), project('new-folder'))
  equal(api.getProjectDir('new-folder'), project('new-folder'))
  deepStrictEqual(events, [['project', 'new-folder'], ['project', 'new-folder']])
  for (const value of [undefined, '', 'test', 'production']) {
    env.NODE_ENV = value
    env.MERCURY_ENTRYPOINT = value
    equal(api.getNodeEnv(), value || 'development')
    equal(api.getEntrypoint(), value)
    equal(api.isCustomTitleEnabled(), true)
  }

  state.override = undefined
  state.resolutionError = absent
  deepStrictEqual(await api.listAgentMetadata(), [])
  state.resolutionError = broken
  await rejects(() => api.listAgentMetadata(), error => error === broken)
  state.resolutionError = undefined
  const meta = api.getAgentMetadataPath(id)
  for (const raw of ['{"agentType":"worker","model":"m"}', 'false', '0', '""', '[]', 'null']) {
    files.set(meta, raw)
    deepStrictEqual(await api.readAgentMetadata(id), JSON.parse(raw))
  }
  files.set(meta, '{broken')
  events.length = 0
  equal(await api.readAgentMetadata(id), null)
  deepStrictEqual(events.at(-1), ['warn', `The launch sidecar at ${meta} does not decode; the resume re-resolves the agent instead`, { level: 'warn' }])
  for (const error of [absent, broken]) {
    files.set(meta, error)
    if (error === absent) equal(await api.readAgentMetadata(id), null)
    else await rejects(() => api.readAgentMetadata(id), failure => failure === broken)
  }
  const metadata = { agentType: 'worker', model: 'm', effort: 'max', name: '', launchedAt: 1 }
  events.length = 0
  await api.writeAgentMetadata(id, metadata)
  deepStrictEqual(events.at(-1), ['publish', meta, JSON.stringify(metadata)])
  state.publishError = broken
  await rejects(() => api.writeAgentMetadata(id, metadata), error => error === broken)
  state.publishError = undefined

  const root = path.join(project(state.cwd), state.session, 'subagents')
  directories.set(root, ['agent-a.meta.json', 'ignored.json', 'agent-z.meta.json', 'agent-b.meta.json', 'agent-c.meta.json', 'agent-.meta.json'])
  api.setAgentTranscriptSubdir('a', 'workflows/group')
  files.set(api.getAgentMetadataPath('a' as never), 'false')
  files.set(api.getAgentMetadataPath('z' as never), '{torn')
  files.set(api.getAgentMetadataPath('b' as never), broken)
  files.set(api.getAgentMetadataPath('c' as never), '0')
  events.length = 0
  deepStrictEqual(await api.listAgentMetadata(), [{ agentId: 'a', metadata: false }, { agentId: 'c', metadata: 0 }])
  deepStrictEqual(events.filter(row => row[0] === 'read').map(row => row[1]), ['a', 'z', 'b', 'c'].map(name => api.getAgentMetadataPath(name as never)))
  directories.set(root, absent)
  deepStrictEqual(await api.listAgentMetadata(), [])
  directories.set(root, broken)
  await rejects(() => api.listAgentMetadata(), error => error === broken)

  const transcript = path.join(state.home, 'elsewhere', 'session.jsonl')
  const tree = path.join(path.dirname(transcript), 'tree-session', 'subagents')
  const entry = (name: string, directory = false) => ({ name, isDirectory: () => directory })
  directories.set(tree, [entry('agent-z.jsonl'), entry('d', true), entry('agent-link.jsonl'), entry('agent-.jsonl'), entry('other.jsonl'), entry('missing', true)])
  const expected = [path.join(tree, 'agent-z.jsonl'), path.join(tree, 'agent-link.jsonl')]
  let current = tree
  for (let depth = 1; depth <= 5; depth++) {
    current = path.join(current, 'd')
    directories.set(current, [entry(`agent-${depth}.jsonl`), entry('d', true)])
    if (depth <= 4) expected.push(path.join(current, `agent-${depth}.jsonl`))
  }
  events.length = 0
  deepStrictEqual(await api.listAgentTranscriptPaths(transcript, 'tree-session'), expected.sort())
  deepStrictEqual(events.filter(row => row[0] === 'readdir').map(row => row[1]), [tree, ...Array.from({ length: 4 }, (_, depth) => path.join(tree, ...Array(depth + 1).fill('d'))), path.join(tree, 'missing')])
  for (const read of events.filter(row => row[0] === 'readdir')) deepStrictEqual(read[2], { withFileTypes: true })
  directories.set(path.join(tree, 'missing'), broken)
  await rejects(() => api.listAgentTranscriptPaths(transcript, 'tree-session'), error => error === broken)
  directories.set(tree, absent)
  deepStrictEqual(await api.listAgentTranscriptPaths(transcript, 'tree-session'), [])

  for (const type of ['user', 'assistant', 'system', 'attachment', 'progress', 'unknown', 'constructor']) {
    equal(api.isTranscriptMessage({ type } as never), ['user', 'assistant', 'system', 'attachment'].includes(type))
    equal(api.isChainParticipant({ type } as never), type !== 'progress')
  }
  const parent = { type: 'progress', uuid: '' }
  for (const value of [parent, { ...parent, parentUuid: 123 }, Object.create(parent)]) equal(api.isPersistedProgressEntry(value), true)
  for (const value of [undefined, null, 0, 'progress', {}, { type: 'progress' }, { type: 'progress', uuid: 1 }, { type: 'user', uuid: '' }]) equal(api.isPersistedProgressEntry(value), false)
  for (const type of ['bash_progress', 'powershell_progress', 'mcp_progress', 'hook_progress', '', undefined, 1, new String('bash_progress')]) {
    equal(api.isEphemeralToolProgress(type), typeof type === 'string' && ['bash_progress', 'powershell_progress', 'mcp_progress'].includes(type))
  }
  strictEqual(api.isCustomTitleEnabled(), true)
}
console.log('PASS: POSIX and Windows path bytes, root overrides, metadata values/effects, sequential tree walk and row vocabulary')
