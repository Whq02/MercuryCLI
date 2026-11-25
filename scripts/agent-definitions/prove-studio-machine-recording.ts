;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env['MERCURY_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'studio-machine-recording-'))

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
await import('../../src/tools/crewmate/CrewmateTool.js')
const { createStudioEditorMachine } = await import('../../src/screen/agents/studio/studioEditorModel.js')
const { AgentStoreError } = await import('../../src/crew/agents/store.js')
const { revisionDigest } = await import('../../src/crew/agents/contracts.js')

const SELF = 'scripts/agent-definitions/prove-studio-machine-recording.ts'
const RECORDING = join(import.meta.dirname, 'recordings', 'studio-machine.txt')
const UNIT = 'createStudioEditorMachine'

type Machine = ReturnType<typeof createStudioEditorMachine>
type Options = Parameters<typeof createStudioEditorMachine>[0]
type Deps = NonNullable<Parameters<typeof createStudioEditorMachine>[2]>
type Snapshot = ReturnType<Machine['snapshot']>
type Receipt = Awaited<ReturnType<NonNullable<Deps['saveDocument']>>>
type Generated = Awaited<ReturnType<NonNullable<Deps['generate']>>>
type Held<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void }

type World = {
  mode: 'create' | 'edit'
  base?: { filePath: string; raw: string | null; revision?: string }
  drafts?: unknown[]
  existing?: unknown[]
}

type Stage = {
  machine: Machine
  call: (name: keyof Machine, ...args: unknown[]) => unknown
  say: (line: string) => void
  fire: (timer: number) => void
  drain: (turns?: number) => Promise<void>
  drafts: unknown[]
  existing: unknown[]
  plan: {
    saveDocument: (target: unknown, raw: string) => Promise<Receipt>
    saveDraft: () => Promise<string>
    generate: () => Promise<Generated>
  }
}

const hold = <T,>(): Held<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const named = new WeakMap<object, string>()
const calledAs = <T extends object>(words: string, value: T): T => {
  named.set(value, words)
  return value
}

const receipt = (changes: string[]): Receipt =>
  ({ path: '/dest/agent.md', afterRevision: 'rev-2', semanticChanges: changes, bytes: 1, at: 'now' }) as unknown as Receipt

function stage(lines: string[], world: World): Stage {
  const ids = new Map<object, string>()
  const counts = new Map<string, number>()
  const shownDocs = new Set<object>()
  let ticks: { passed: number } | null = null
  let snapshotKeys: string | null = null

  const say = (line: string): void => {
    lines.push(ticks === null ? line : `[tick ${ticks.passed}] ${line}`)
  }
  const idOf = (kind: string, value: object): string => {
    const known = ids.get(value)
    if (known !== undefined) return known
    const next = (counts.get(kind) ?? 0) + 1
    counts.set(kind, next)
    const id = `${kind}#${next}`
    ids.set(value, id)
    return id
  }
  const text = (value: unknown): string => (value === undefined ? 'undefined' : typeof value === 'object' && value !== null && named.has(value) ? `<${named.get(value)}>` : JSON.stringify(value))
  const held = (kind: string, value: object | null): string => (value === null ? '-' : `${idOf(kind, value)}${text(value)}`)
  const docOf = (doc: Snapshot['doc']): string => {
    const id = idOf('doc', doc)
    if (!shownDocs.has(doc)) {
      shownDocs.add(doc)
      say(`  ${id} raw@${revisionDigest(doc.raw)} ${text(doc)}`)
    }
    return id
  }
  const shown = (snap: Snapshot): string => {
    const keys = Object.keys(snap).join(',')
    if (snapshotKeys === null) {
      snapshotKeys = keys
      say(`  snapshot keys ${keys}`)
    } else if (keys !== snapshotKeys) say(`  snapshot keys now ${keys}`)
    const doc = docOf(snap.doc)
    return `doc=${doc} rev=${text(snap.baseRevision)} scope=${snap.scope} view=${held('view', snap.view)} note=${held('note', snap.note)} busy=${snap.busy} conflict=${held('conflict', snap.conflict)} recover=${held('recover', snap.recoverOffer)} buf=${text(snap.textBuffer)} cur=${snap.textCursor}`
  }

  const drafts = [...(world.drafts ?? [])]
  const existing = [...(world.existing ?? [])]
  const timers: { run: () => void }[] = []
  const plan: Stage['plan'] = {
    saveDocument: async () => receipt(['description']),
    saveDraft: async () => '/drafts/x.json',
    generate: () => new Promise<Generated>(() => {}),
  }
  const base = world.base
  const options = {
    mode: world.mode,
    ...(base
      ? {
          base: {
            identity: { filePath: base.filePath, revision: base.revision ?? (base.raw === null ? 'rev-unread' : revisionDigest(base.raw)) },
            agent: { agentType: 'fixture-scout', whenToUse: 'x', getSystemPrompt: () => '', source: 'projectSettings', filePath: base.filePath },
          },
        }
      : {}),
    cwd: '/repo',
    getExistingAgents: () => {
      say(`. getExistingAgents() -> ${existing.length}`)
      return existing
    },
    getParentModel: () => {
      say('. getParentModel()')
      return 'claude-fable-5'
    },
    onSaved: (message: string) => say(`. onSaved(${text(message)})`),
    onCancel: () => say('. onCancel()'),
  } as unknown as Options
  const deps = {
    readFile: (path: string) => {
      say(`. readFile(${text(path)})${base && path === base.filePath && base.raw !== null ? '' : ' throws'}`)
      if (base && path === base.filePath && base.raw !== null) return base.raw
      throw new Error(`no fixture file at ${path}`)
    },
    saveDocument: (target: unknown, doc: Snapshot['doc']) => {
      say(`. saveDocument(${text(target)}, ${docOf(doc)})`)
      return plan.saveDocument(target, doc.raw)
    },
    saveDraft: (draft: { raw: string }) => {
      say(`. saveDraft(${text({ ...draft, raw: `raw@${revisionDigest(draft.raw)}` })})`)
      return plan.saveDraft()
    },
    listDrafts: () => {
      say(`. listDrafts() -> ${drafts.length}`)
      return drafts
    },
    discardDraft: (path: string) => say(`. discardDraft(${text(path)})`),
    generate: (prompt: string, model: string, known: string[], signal: AbortSignal) => {
      say(`. generate(${text(prompt)}, ${text(model)}, ${text(known)}, aborted=${signal.aborted})`)
      signal.addEventListener('abort', () => say('. the generation signal aborts'))
      return plan.generate()
    },
    setTimer: (run: () => void, ms: number) => {
      const handle = { run }
      timers.push(handle)
      say(`. setTimer(${ms}) -> ${idOf('timer', handle)}`)
      return handle
    },
    clearTimer: (handle: unknown) => say(`. clearTimer(${typeof handle === 'object' && handle !== null ? idOf('timer', handle) : text(handle)})`),
  } as unknown as Deps

  say(`mount ${text({ mode: world.mode, base: base ? { filePath: base.filePath, read: base.raw !== null } : null })}`)
  const machine = createStudioEditorMachine(options, snap => say(`~ emit ${shown(snap)}`), deps)
  say(`  methods ${Object.entries(machine).map(([key, value]) => `${key}:${typeof value === 'function' ? `${value.name}/${value.length}` : typeof value}`).join(' ')}`)
  say(`= ${shown(machine.snapshot())}`)

  return {
    machine,
    say,
    drafts,
    existing,
    plan,
    call: (name, ...args) => {
      say(`> ${name}(${args.map(text).join(', ')})`)
      let out: unknown
      try {
        out = (machine[name] as (...given: unknown[]) => unknown)(...args)
      } catch (error) {
        say(`! ${name} threw ${String(error)}`)
        say(`= ${shown(machine.snapshot())}`)
        return undefined
      }
      say(`< ${out instanceof Promise ? 'a promise' : text(out)}`)
      say(`= ${shown(machine.snapshot())}`)
      return out
    },
    fire: timer => {
      say(`> fire timer#${timer}`)
      timers[timer - 1]!.run()
      say(`= ${shown(machine.snapshot())}`)
    },
    drain: async (turns = 12) => {
      ticks = { passed: 0 }
      for (let turn = 0; turn < turns; turn++) {
        await Promise.resolve()
        ticks.passed++
      }
      ticks = null
      say(`= ${shown(machine.snapshot())}`)
    },
  }
}

const BASE_PATH = '/repo/.mercury/agents/fixture-scout.md'
const BASE_RAW = '---\nname: fixture-scout\ndescription: The base description as discovered on disk today.\nmaxTurns: 5\n---\nThe base body, long enough to be a lawful system prompt for the walk.\n'
const THEIR_RAW = '---\nname: fixture-scout\ndescription: Their newer description, written elsewhere on disk.\nmaxTurns: 9\n---\nTheir newer body, long enough to stand as a real system prompt.\n'
const THIRD_RAW = '---\nname: fixture-scout\ndescription: A third description, written after theirs.\nmaxTurns: 11\n---\nA third body, long enough to stand as a real system prompt.\n'
const DRAFT_RAW = '---\nname: recovered-scout\ndescription: A draft left behind by a previous session for recovery.\n---\nThe recovered body, long enough to stand as a lawful system prompt.\n'
const CLEAN_RAW = '---\nname: raw-scout\ndescription: A clean raw replacement written through the editor door.\n---\nA lawful replacement body, long enough for the validation floor.\n'
const NAMELESS_RAW = '---\ndescription: no name here\n---\nA body without a name key above it, long enough to pass length.\n'
const HOOKED_RAW = BASE_RAW.replace('maxTurns: 5\n', 'maxTurns: 5\nhooks:\n  tool.before: []\n')
const DOUBLED_RAW = '---\nname: first-scout\nname: second-scout\ndescription: one\ndescription: two\ntools: Read\ntools: Write\nmodel: opus\nmodel: haiku\n---\nA body under keys written twice, long enough for the floor.\n'
const LONG_PROMPT = 'You are the walk scout. Walk the whole estate and report faithfully.'
const GENERATED: Generated = {
  identifier: 'made-scout',
  whenToUse: 'Use this agent when the walk needs a generated fixture.',
  systemPrompt: 'You are the generated fixture scout. Hold the machine to its own spellings and never improvise beyond them.',
} as Generated
const ADVANCED = { kind: 'advanced', cursor: 0, editing: null }
const draftOf = (path: string, raw: unknown, basePath?: string): unknown => ({
  path,
  draft: { version: 1, savedAt: 'then', ...(basePath ? { baseIdentity: { filePath: basePath, revision: 'rev-then' } } : {}), raw },
})
const lawful = (s: Stage, name: string): void => {
  s.call('commit', { set: { name, description: 'Use this agent when the recording needs a lawful draft.' }, body: `${LONG_PROMPT}\n` })
}

const scenes: [name: string, run: (lines: string[]) => Promise<void>][] = [
  ['create: the guided walk by hand, then save', async lines => {
    const s = stage(lines, { mode: 'create' })
    s.call('guidedDestination', 'user')
    s.call('guidedMethod', 'manual')
    s.call('guidedIdentity', 'Bad Name!')
    s.call('guidedIdentity', 'walk-scout')
    s.call('guidedPrompt', 'too short')
    s.call('guidedPrompt', `  ${LONG_PROMPT}  `)
    s.call('guidedDescription', '   ')
    s.call('guidedDescription', '  Use this agent when the machine walk needs a fixture.  ')
    s.call('guidedTools', ['Read'])
    s.call('guidedModel', 'inherit')
    s.call('reviewEscape')
    s.call('guidedModel', 'opus')
    s.call('guidedTools', undefined)
    s.drafts.push(draftOf('/drafts/new.json', DRAFT_RAW), draftOf('/drafts/edit.json', DRAFT_RAW, BASE_PATH), draftOf('/drafts/new-2.json', DRAFT_RAW))
    s.call('save')
    await s.drain()
  }],
  ['create: back through the guided steps, and the guided calls outside the guided view', async lines => {
    const s = stage(lines, { mode: 'create' })
    s.call('guidedDestination', 'project')
    s.call('guidedMethod', 'manual')
    s.call('guidedIdentity', 'back-scout')
    s.call('guidedBack')
    s.call('guidedBack')
    s.call('guidedBack')
    s.call('guidedBack')
    s.call('guidedMethod', 'generate')
    s.call('guidedBack')
    s.call('setView', ADVANCED)
    s.call('guidedBack')
    s.call('guidedDestination', 'user')
    s.call('guidedMethod', 'generate')
    s.call('guidedMethod', 'manual')
    s.call('guidedIdentity', 'outside-scout')
    s.call('guidedPrompt', LONG_PROMPT)
    s.call('guidedDescription', 'Use this agent outside the guided view.')
    s.call('guidedTools', [])
    s.call('guidedModel')
    s.call('setView', { kind: 'raw' })
    s.call('guidedModel', 'haiku')
    s.call('reviewEscape')
  }],
  ['the guided steps over a document whose keys the codec will not patch', async lines => {
    const s = stage(lines, { mode: 'create' })
    s.call('loadRaw', DOUBLED_RAW)
    s.call('guidedIdentity', 'patched-scout')
    s.call('guidedDescription', 'Use this agent when a patch is refused.')
    s.call('guidedTools', ['Read'])
    s.call('guidedTools', undefined)
    s.call('guidedModel', 'opus')
    s.call('guidedModel', 'inherit')
    s.call('guidedPrompt', LONG_PROMPT)
    s.call('setView', ADVANCED)
    s.call('openFieldEditor', 'name')
    s.call('commitTextField', 'name', 'patched-scout')
  }],
  ['the text fields of the advanced list', async lines => {
    const s = stage(lines, { mode: 'create' })
    s.call('openFieldEditor', 'name')
    s.call('closeFieldEditor')
    s.call('commitTextField', 'description', 'Committed while the guided view is up.')
    s.call('setView', ADVANCED)
    for (const field of ['name', 'description', 'skills', 'maxTurns', 'initialPrompt', 'model', 'body']) s.call('openFieldEditor', field)
    s.call('commitTextField', 'name', '  field-scout  ')
    s.call('openFieldEditor', 'name')
    s.call('setTextBuffer', 'field-sco')
    s.call('setTextCursor', 3)
    s.call('closeFieldEditor')
    s.call('openFieldEditor', 'description')
    s.call('commitTextField', 'description', 'Use this agent when a field needs a value.')
    s.call('openFieldEditor', 'description')
    s.call('openFieldEditor', 'skills')
    s.call('commitTextField', 'skills', ' chart-lore ,  map-lore , ')
    s.call('openFieldEditor', 'skills')
    s.call('commitTextField', 'skills', '   ')
    s.call('openFieldEditor', 'maxTurns')
    for (const turns of ['seven', '0', '2.5', '-3', '12']) s.call('commitTextField', 'maxTurns', turns)
    s.call('openFieldEditor', 'maxTurns')
    s.call('commitTextField', 'maxTurns', '')
    s.call('openFieldEditor', 'initialPrompt')
    s.call('commitTextField', 'initialPrompt', '  Start by reading the ledger.  ')
    s.call('openFieldEditor', 'initialPrompt')
    s.call('commitTextField', 'initialPrompt', '   ')
    s.call('openFieldEditor', 'model')
    s.call('commitTextField', 'model', 'opus')
    s.call('commitTextField', 'body', 'never taken')
    s.call('setScope', 'user')
    s.call('setScope', 'project')
    s.call('setView', { kind: 'review' })
    s.call('setTextBuffer', 'kept across views')
  }],
  ['commit: taken, refused by the codec, failed by a throw', async lines => {
    const s = stage(lines, { mode: 'create' })
    s.call('commit', { set: { name: 'commit-scout' } })
    s.call('commit', { set: { hooks: { 'tool.before': [] } } })
    s.call(
      'commit',
      calledAs('an edit whose set throws', {
        get set(): never {
          throw new Error('a scripted edit failure')
        },
      }),
    )
    s.call('commit', { set: { background: true, isolation: 'worktree' } })
    s.call('commit', { remove: ['background'] })
    s.call('commit', { body: 'A body set alone.\n' })
  }],
  ['loadRaw: the same bytes, a document with errors, a clean one', async lines => {
    const s = stage(lines, { mode: 'create' })
    s.call('loadRaw', s.machine.snapshot().doc.raw)
    s.call('loadRaw', NAMELESS_RAW)
    s.call('loadRaw', CLEAN_RAW)
    s.call('loadRaw', CLEAN_RAW)
    const edited = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: BASE_RAW } })
    edited.call('loadRaw', BASE_RAW)
    edited.call('loadRaw', THEIR_RAW)
  }],
  ['edit: the base read, the autosave and its timer, dispose', async lines => {
    const s = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: BASE_RAW } })
    s.call('reviewEscape')
    s.call('commit', { set: { description: 'A first edit arms the debounce.' } })
    s.call('commit', { set: { description: 'A second edit arms it again.' } })
    s.fire(2)
    await s.drain()
    s.call('commit', { set: { maxTurns: 7 } })
    s.fire(3)
    await s.drain()
    s.call('commit', { set: { maxTurns: 8 } })
    s.call('dispose')
    s.call('commit', { set: { maxTurns: 9 } })
    s.call('setScope', 'user')
    s.call('dispose')
    const created = stage(lines, { mode: 'create' })
    created.call('setScope', 'user')
    created.call('commit', { set: { name: 'draft-scout' } })
    created.fire(1)
    await created.drain()
    created.call('dispose')
  }],
  ['the autosave: a draft save that fails', async lines => {
    const open = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: BASE_RAW } })
    open.plan.saveDraft = () => Promise.reject(new Error('the draft folder is full'))
    open.call('commit', { set: { maxTurns: 7 } })
    open.fire(1)
    await open.drain()
    open.call('commit', { set: { maxTurns: 8 } })
    open.plan.saveDraft = () => Promise.reject('a failure that is no Error')
    open.fire(2)
    await open.drain()
    open.plan.saveDraft = async () => '/drafts/x.json'
    open.call('commit', { set: { maxTurns: 9 } })
    open.fire(3)
    await open.drain()
    const closed = stage(lines, { mode: 'create' })
    const late = hold<string>()
    closed.plan.saveDraft = () => late.promise
    closed.call('commit', { set: { name: 'late-scout' } })
    closed.fire(1)
    closed.call('dispose')
    late.reject(new Error('the draft folder is full'))
    await closed.drain()
  }],
  ['edit: a base file that cannot be read, and the draft on offer', async lines => {
    const accept = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: null }, drafts: [draftOf('/drafts/new.json', CLEAN_RAW), draftOf('/drafts/edit.json', DRAFT_RAW, BASE_PATH)] })
    accept.call('acceptRecover')
    accept.call('acceptRecover')
    accept.call('declineRecover')
    const decline = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: BASE_RAW }, drafts: [draftOf('/drafts/edit.json', DRAFT_RAW, BASE_PATH)] })
    decline.call('declineRecover')
    decline.call('declineRecover')
    const created = stage(lines, { mode: 'create', drafts: [draftOf('/drafts/edit.json', DRAFT_RAW, BASE_PATH), draftOf('/drafts/new.json', DRAFT_RAW)] })
    created.call('acceptRecover')
    const unreadable = stage(lines, { mode: 'create', drafts: [draftOf('/drafts/new.json', 42)] })
    unreadable.call('acceptRecover')
    const none = stage(lines, { mode: 'create', drafts: [draftOf('/drafts/edit.json', DRAFT_RAW, BASE_PATH)] })
    none.call('acceptRecover')
    none.call('declineRecover')
  }],
  ['save: refused, held while busy, on an existing file, and each failure', async lines => {
    const s = stage(lines, { mode: 'create' })
    s.call('save')
    await s.drain()
    lawful(s, 'save-scout')
    s.existing.push({ agentType: 'save-scout', source: 'userSettings', filePath: '/home/.mercury/agents/save-scout.md' })
    s.call('save')
    await s.drain()
    s.existing.length = 0
    const pending = hold<Receipt>()
    s.plan.saveDocument = () => pending.promise
    s.call('save')
    s.call('save')
    s.call('guidedDescribe', 'held back while a save runs')
    pending.resolve(receipt([]))
    await s.drain()
    s.plan.saveDocument = () => Promise.reject(new Error('the disk is full'))
    s.call('save')
    await s.drain()
    s.plan.saveDocument = () => Promise.reject('a failure that is no Error')
    s.call('save')
    await s.drain()
    s.plan.saveDocument = () => Promise.reject(new AgentStoreError('revision-conflict', 'revision moved'))
    s.call('save')
    await s.drain()
    s.call('clearConflict')
    s.plan.saveDocument = () => {
      throw new AgentStoreError('io', 'thrown before any promise')
    }
    s.call('save')
    await s.drain()
    const edited = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: BASE_RAW, revision: 'rev-of-the-listing' } })
    edited.call('commit', { set: { maxTurns: 6 } })
    edited.drafts.push(draftOf('/drafts/edit.json', DRAFT_RAW, BASE_PATH), draftOf('/drafts/other.json', DRAFT_RAW, '/repo/.mercury/agents/other-scout.md'), draftOf('/drafts/new.json', DRAFT_RAW))
    edited.call('save')
    await edited.drain()
    const unread = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: null, revision: 'rev-of-the-listing' } })
    lawful(unread, 'fixture-scout')
    unread.call('save')
    await unread.drain()
  }],
  ['save: a conflict, then the merge onto theirs', async lines => {
    const s = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: BASE_RAW } })
    s.call('mergeOntoTheirs')
    s.call('commit', { set: { maxTurns: undefined, skills: ['chart-lore'] }, body: 'My edited body, long enough to pass the validation floor.\n' })
    s.plan.saveDocument = () => Promise.reject(new AgentStoreError('revision-conflict', 'revision moved', { currentRaw: THEIR_RAW }))
    s.call('save')
    await s.drain()
    s.call('mergeOntoTheirs')
    s.call('mergeOntoTheirs')
    s.plan.saveDocument = () => Promise.reject(new AgentStoreError('revision-conflict', 'revision moved', { currentRaw: THIRD_RAW }))
    s.call('save')
    await s.drain()
    s.call('mergeOntoTheirs')
    s.plan.saveDocument = async () => receipt(['skills'])
    s.call('save')
    await s.drain()
    const kept = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: HOOKED_RAW } })
    kept.call('commit', { set: { description: 'My newer description, edited in this draft with intent.' } })
    kept.plan.saveDocument = () => Promise.reject(new AgentStoreError('revision-conflict', 'revision moved', { currentRaw: THEIR_RAW }))
    kept.call('save')
    await kept.drain()
    kept.call('clearConflict')
    kept.call('mergeOntoTheirs')
    kept.call('save')
    await kept.drain()
    kept.call('mergeOntoTheirs')
    const hooked = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: HOOKED_RAW } })
    hooked.call('loadRaw', HOOKED_RAW.replace('tool.before', 'tool.after').replace('The base description', 'My description'))
    hooked.plan.saveDocument = () => Promise.reject(new AgentStoreError('revision-conflict', 'revision moved', { currentRaw: THEIR_RAW.replace('maxTurns: 9\n', 'maxTurns: 9\nhooks:\n  Stop: []\n') }))
    hooked.call('save')
    await hooked.drain()
    hooked.call('mergeOntoTheirs')
    const failing = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: BASE_RAW } })
    failing.call('loadRaw', BASE_RAW.replace('maxTurns: 5', 'model: "two\\nlines"'))
    failing.plan.saveDocument = () => Promise.reject(new AgentStoreError('revision-conflict', 'revision moved', { currentRaw: THEIR_RAW.replace('maxTurns: 9\n', 'maxTurns: 9\nhooks:\n  tool.before: []\n') }))
    failing.call('save')
    await failing.drain()
    failing.call('mergeOntoTheirs')
  }],
  ['generation: settled, failed, cancelled, late, and after dispose', async lines => {
    const settled = stage(lines, { mode: 'create' })
    settled.existing.push({ agentType: 'known-scout', source: 'projectSettings' })
    let generation = hold<Generated>()
    settled.plan.generate = () => generation.promise
    settled.call('guidedDestination', 'project')
    settled.call('guidedMethod', 'generate')
    settled.call('guidedDescribe', 'an agent that walks fixtures')
    settled.call('guidedDescribe', 'a second ask before the first settles')
    settled.call('save')
    generation.resolve(GENERATED)
    await settled.drain()
    settled.call('abortGeneration')
    generation = hold<Generated>()
    settled.call('guidedDescribe', 'an agent that fails')
    generation.reject(new Error('the model refused'))
    await settled.drain()
    generation = hold<Generated>()
    settled.call('guidedDescribe', 'an agent that fails with no Error')
    generation.reject('a failure that is no Error')
    await settled.drain()
    generation = hold<Generated>()
    settled.call('guidedDescribe', 'an agent whose identifier the codec refuses')
    generation.resolve({ ...GENERATED, identifier: 'two\nlines' } as Generated)
    await settled.drain()
    const cancelled = stage(lines, { mode: 'create' })
    let other = hold<Generated>()
    cancelled.plan.generate = () => other.promise
    cancelled.call('guidedDescribe', 'an agent that is cancelled and then fails')
    cancelled.call('abortGeneration')
    other.reject(new Error('aborted'))
    await cancelled.drain()
    other = hold<Generated>()
    cancelled.call('guidedDescribe', 'an agent that is cancelled and then settles late')
    cancelled.call('abortGeneration')
    other.resolve(GENERATED)
    await cancelled.drain()
    cancelled.call('abortGeneration')
    const disposed = stage(lines, { mode: 'create' })
    const last = hold<Generated>()
    disposed.plan.generate = () => last.promise
    disposed.call('guidedDescribe', 'an agent that settles after dispose')
    disposed.call('dispose')
    last.resolve(GENERATED)
    await disposed.drain()
    disposed.call('guidedDescribe', 'asked of a disposed machine')
    disposed.call('abortGeneration')
    const thrown = stage(lines, { mode: 'create' })
    thrown.plan.generate = () => {
      throw new Error('thrown before any promise')
    }
    thrown.call('guidedDescribe', 'an agent whose generator throws at once')
    await thrown.drain()
  }],
]

async function record(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const [name, run] of scenes) {
    const lines: string[] = []
    await run(lines)
    out.set(name, lines)
  }
  return out
}

const written = (recorded: Map<string, string[]>): string => [...recorded].map(([name, lines]) => `## ${name}\n${lines.join('\n')}\n`).join('\n')

function read(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let lines: string[] | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) out.set(line.slice(3), (lines = []))
    else if (lines !== null) lines.push(line)
  }
  for (const held of out.values()) while (held.length > 0 && held[held.length - 1] === '') held.pop()
  return out
}

const cut = (line: string | undefined): string => (line === undefined ? '(no line)' : line.length > 220 ? `${line.slice(0, 220)}…` : line)

function firstDifference(stood: string[], stands: string[]): string | null {
  const reach = Math.max(stood.length, stands.length)
  for (let at = 0; at < reach; at++) {
    if (stood[at] !== stands[at]) return `line ${at + 1}\n      stood:  ${cut(stood[at])}\n      stands: ${cut(stands[at])}`
  }
  return null
}

const first = await record()
const second = await record()
let failures = 0
const fail = (line: string): void => {
  failures++
  console.log(`  [FAIL] ${line}`)
}

for (const [name, lines] of first) {
  const twice = firstDifference(lines, second.get(name) ?? [])
  if (twice !== null) fail(`${name}: two recordings in one process differ, so nothing can be compared with it: ${twice}`)
}

if (process.argv.includes('--write')) {
  if (failures === 0) {
    const stood = existsSync(RECORDING) ? read(readFileSync(RECORDING, 'utf-8')) : new Map<string, string[]>()
    for (const [name, lines] of first) {
      const moved = firstDifference(stood.get(name) ?? [], lines)
      if (moved !== null) console.log(`  wrote ${name}: ${stood.has(name) ? moved : `${lines.length} lines, new`}`)
    }
    for (const name of stood.keys()) if (!first.has(name)) console.log(`  dropped ${name}: no scene records it`)
    mkdirSync(dirname(RECORDING), { recursive: true })
    writeFileSync(RECORDING, written(first))
    console.log(`\n${first.size} scenes, ${[...first.values()].reduce((n, lines) => n + lines.length, 0)} lines written to ${RECORDING}`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

if (!existsSync(RECORDING)) fail(`no recording stands at ${RECORDING}: run \`bun run ${SELF} --write\` on a tree whose behaviour is the one to hold, and commit it`)
else {
  const stood = read(readFileSync(RECORDING, 'utf-8'))
  for (const [name, lines] of first) {
    const held = stood.get(name)
    if (held === undefined) {
      fail(`${name}: the scene has no recording; run \`bun run ${SELF} --write\` and commit the recording with the scene`)
      continue
    }
    const moved = firstDifference(held, lines)
    if (moved === null) console.log(`  [PASS] ${name} (${lines.length} lines)`)
    else fail(`the recorded behaviour of ${UNIT} changed in "${name}" at ${moved}\n      if nobody asked for the change, the change is the fault; if it was asked for, run \`bun run ${SELF} --write\`, read the difference it prints, and commit the recording with the change`)
  }
  for (const name of stood.keys()) if (!first.has(name)) fail(`${name}: a recording stands that no scene records; run \`bun run ${SELF} --write\` to drop it`)
}

{
  const dbg = await import('../../src/platform/logs/debugLog.js')
  const prevNodeEnv = process.env.NODE_ENV
  delete process.env.NODE_ENV
  dbg.enableDebugLogging()
  const dbgPath = dbg.getDebugLogPath()
  const lines: string[] = []
  const open = stage(lines, { mode: 'edit', base: { filePath: BASE_PATH, raw: BASE_RAW } })
  open.plan.saveDraft = () => Promise.reject(new Error('studio-draft-disk-full'))
  open.call('commit', { set: { maxTurns: 7 } })
  open.fire(1)
  await open.drain()
  await dbg.flushDebugLogs()
  if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv
  const dbgText = (() => { try { return readFileSync(dbgPath, 'utf8') } catch { return '' } })()
  if (!dbgText.includes('studio-draft-disk-full')) {
    fail(`draft save failure did not write error detail to debug log — log the raw error via logForDebugging in src/screen/agents/studio/studioEditorModel.ts`)
  } else {
    console.log('  [PASS] draft save failure writes raw error detail to debug log')
  }
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-studio-machine-recording — ${first.size} scenes, ${failures === 0 ? 'equal to the recording' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
