// ============================================================================
//  corpus repo: notedeck — a small ESM note-store CLI (node --test).
//  Base tree is ALL-GREEN; task branches overlay genuine defects or new
//  failing specs. Fixture code style: single-quoted strings, no template
//  literals (content lives inside TS template literals here).
// ============================================================================
import type { BranchOverlay, FileMap, HelixRepoSpec } from '../contracts.js'
import { MF_BRANCHES } from './notedeckMultifile.js'

const PACKAGE_JSON = `{
  "name": "notedeck",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
`

// ── src/id.js ───────────────────────────────────────────────────────────────

const ID_BASE = `// Note id minting. Ids are namespace-prefixed base36 counters, zero-padded
// to six digits so lexicographic order matches mint order.
export function mintId(ns, seq) {
  if (!/^[a-z]+$/.test(ns)) throw new Error('bad namespace: ' + ns)
  const encoded = seq.toString(36)
  return ns + '-' + encoded.padStart(6, '0')
}

export function parseId(id) {
  const at = id.indexOf('-')
  if (at < 1) throw new Error('bad id: ' + id)
  return { ns: id.slice(0, at), seq: parseInt(id.slice(at + 1), 36) }
}
`

/** reference: structured ids {ns, key}. */
export const ID_STRUCTURED = `// Note ids are structured { ns, key } records; key is the six-digit base36
// counter. idKey/idFromKey convert to and from the canonical string form.
export function mintId(ns, seq) {
  if (!/^[a-z]+$/.test(ns)) throw new Error('bad namespace: ' + ns)
  return { ns, key: seq.toString(36).padStart(6, '0') }
}

export function idKey(id) {
  return id.ns + '-' + id.key
}

export function idFromKey(text) {
  const at = text.indexOf('-')
  if (at < 1) throw new Error('bad id: ' + text)
  return { ns: text.slice(0, at), key: text.slice(at + 1) }
}
`

// ── src/store.js ────────────────────────────────────────────────────────────

const STORE_BASE = `import { mintId } from './id.js'

// Note bodies are stored newline-normalized: CRLF and bare CR both become LF
// at the write boundary, so serialized stores are byte-stable across
// platforms and no content is ever lost to line-ending translation.
export function normalizeNewlines(text) {
  return text.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n')
}

export const NOTE_FIELDS = ['id', 'title', 'tags', 'body']

export function createStore(ns) {
  return { ns, seq: 0, notes: [], index: new Map() }
}

export function addNote(store, note) {
  store.seq += 1
  const id = mintId(store.ns, store.seq)
  const stored = {
    id,
    title: note.title,
    tags: [...note.tags],
    body: normalizeNewlines(note.body),
  }
  store.notes.push(stored)
  store.index.set(id, stored)
  return id
}

export function getNote(store, id) {
  return store.index.get(id)
}

export function updateNote(store, id, patch) {
  const at = store.notes.findIndex(n => n.id === id)
  if (at === -1) throw new Error('no such note: ' + id)
  const next = { ...store.notes[at], ...patch, id }
  if (typeof next.body === 'string') next.body = normalizeNewlines(next.body)
  store.notes[at] = next
  store.index.set(id, next)
  return next
}

export function serialize(store) {
  return JSON.stringify({ ns: store.ns, seq: store.seq, notes: store.notes })
}

export function load(json) {
  const raw = JSON.parse(json)
  const store = createStore(raw.ns)
  store.seq = raw.seq
  for (const note of raw.notes) {
    store.notes.push(note)
    store.index.set(note.id, note)
  }
  return store
}
`

/** defect: updateNote forgets to refresh the index (stale reads). */
const STORE_STALE_INDEX = STORE_BASE.replace(
  `  store.notes[at] = next
  store.index.set(id, next)
  return next`,
  `  store.notes[at] = next
  return next`,
)

// ── src/parse.js ────────────────────────────────────────────────────────────

const PARSE_BASE = `// parseNote(text): the first line is the title; #tags may appear anywhere in
// the title line. Quoted tags keep their spaces: #"project x". Tags are
// case-folded to lowercase; the title keeps its own casing.
export function parseNote(text) {
  const lines = text.split('\\n')
  const titleLine = lines[0] ?? ''
  const tags = []
  let title = ''
  let i = 0
  while (i < titleLine.length) {
    const ch = titleLine[i]
    if (ch === '#') {
      if (titleLine[i + 1] === '"') {
        const close = titleLine.indexOf('"', i + 2)
        if (close === -1) throw new Error('unterminated quoted tag')
        tags.push(titleLine.slice(i + 2, close).toLowerCase())
        i = close + 1
      } else {
        let j = i + 1
        while (j < titleLine.length && /[\\w-]/.test(titleLine[j])) j += 1
        tags.push(titleLine.slice(i + 1, j).toLowerCase())
        i = j
      }
    } else {
      title += ch
      i += 1
    }
  }
  return {
    title: title.replace(/\\s+/g, ' ').trim(),
    tags,
    body: lines.slice(1).join('\\n').trim(),
  }
}
`

/** defect: naive token split — quoted tags with spaces break. */
const PARSE_TOKEN_SPLIT = `// parseNote(text): the first line is the title; #tags may appear anywhere in
// the title line. Quoted tags keep their spaces: #"project x". Tags are
// case-folded to lowercase; the title keeps its own casing.
export function parseNote(text) {
  const lines = text.split('\\n')
  const titleLine = lines[0] ?? ''
  const tags = []
  const titleWords = []
  for (const token of titleLine.split(/\\s+/)) {
    if (token.startsWith('#')) {
      let tag = token.slice(1)
      if (tag.startsWith('"')) tag = tag.slice(1)
      if (tag.endsWith('"')) tag = tag.slice(0, -1)
      tags.push(tag.toLowerCase())
    } else if (token !== '') {
      titleWords.push(token)
    }
  }
  return {
    title: titleWords.join(' '),
    tags,
    body: lines.slice(1).join('\\n').trim(),
  }
}
`

/** lane defect: tag case-folding dropped on the bare-tag path. */
const PARSE_NO_CASEFOLD = PARSE_BASE.replace(
  `        tags.push(titleLine.slice(i + 1, j).toLowerCase())
        i = j`,
  `        tags.push(titleLine.slice(i + 1, j))
        i = j`,
)

// ── src/render.js ───────────────────────────────────────────────────────────

const RENDER_BASE = `import { getNote } from './store.js'

export function renderNote(store, id) {
  const note = getNote(store, id)
  if (!note) return '(missing note ' + id + ')'
  const tagLine = note.tags.length > 0 ? ' [' + note.tags.join(', ') + ']' : ''
  return '# ' + note.title + tagLine + '\\n\\n' + note.body + '\\n'
}

export function renderList(store) {
  const lines = []
  let n = 1
  for (const note of store.notes) {
    lines.push(String(n) + '. ' + note.title + ' (' + note.id + ')')
    n += 1
  }
  return lines.join('\\n')
}
`

/** lane defect: list numbering starts at 0. */
const RENDER_ZERO_NUMBERING = RENDER_BASE.replace('let n = 1', 'let n = 0')

/** reference: render over structured ids. */
export const RENDER_STRUCTURED = `import { getNote } from './store.js'
import { idKey } from './id.js'

export function renderNote(store, id) {
  const note = getNote(store, id)
  if (!note) return '(missing note ' + idKey(id) + ')'
  const tagLine = note.tags.length > 0 ? ' [' + note.tags.join(', ') + ']' : ''
  return '# ' + note.title + tagLine + '\\n\\n' + note.body + '\\n'
}

export function renderList(store) {
  const lines = []
  let n = 1
  for (const note of store.notes) {
    lines.push(String(n) + '. ' + note.title + ' (' + idKey(note.id) + ')')
    n += 1
  }
  return lines.join('\\n')
}
`

// ── src/cli.js ──────────────────────────────────────────────────────────────

const CLI_BASE = `import { addNote, getNote } from './store.js'
import { parseNote } from './parse.js'
import { renderNote, renderList } from './render.js'

// Exit codes: 0 ok · 1 bad input · 2 unknown command.
export function runCommand(store, argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'add') {
    const text = rest.join(' ')
    if (text.trim() === '') return { code: 1, out: 'add: empty note' }
    const id = addNote(store, parseNote(text))
    return { code: 0, out: id }
  }
  if (cmd === 'show') {
    const note = getNote(store, rest[0])
    if (!note) return { code: 1, out: 'show: no such note' }
    return { code: 0, out: renderNote(store, rest[0]) }
  }
  if (cmd === 'list') {
    return { code: 0, out: renderList(store) }
  }
  return { code: 2, out: 'unknown command: ' + (cmd ?? '(none)') }
}
`

/** defect: unknown command exits 0. */
const CLI_EXIT_ZERO = CLI_BASE.replace(
  "return { code: 2, out: 'unknown command: '",
  "return { code: 0, out: 'unknown command: '",
)

/** reference: cli converts canonical strings via idFromKey. */
export const CLI_STRUCTURED = `import { addNote, getNote } from './store.js'
import { idFromKey, idKey } from './id.js'
import { parseNote } from './parse.js'
import { renderNote, renderList } from './render.js'

// Exit codes: 0 ok · 1 bad input · 2 unknown command.
export function runCommand(store, argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'add') {
    const text = rest.join(' ')
    if (text.trim() === '') return { code: 1, out: 'add: empty note' }
    const id = addNote(store, parseNote(text))
    return { code: 0, out: idKey(id) }
  }
  if (cmd === 'show') {
    let id
    try {
      id = idFromKey(rest[0] ?? '')
    } catch {
      return { code: 1, out: 'show: bad id' }
    }
    const note = getNote(store, id)
    if (!note) return { code: 1, out: 'show: no such note' }
    return { code: 0, out: renderNote(store, id) }
  }
  if (cmd === 'list') {
    return { code: 0, out: renderList(store) }
  }
  return { code: 2, out: 'unknown command: ' + (cmd ?? '(none)') }
}
`

/** reference: store keyed by canonical id strings. */
export const STORE_STRUCTURED = `import { idKey, mintId } from './id.js'

// Note bodies are stored newline-normalized: CRLF and bare CR both become LF
// at the write boundary, so serialized stores are byte-stable across
// platforms and no content is ever lost to line-ending translation.
export function normalizeNewlines(text) {
  return text.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n')
}

export const NOTE_FIELDS = ['id', 'title', 'tags', 'body']

export function createStore(ns) {
  return { ns, seq: 0, notes: [], index: new Map() }
}

export function addNote(store, note) {
  store.seq += 1
  const id = mintId(store.ns, store.seq)
  const stored = {
    id,
    title: note.title,
    tags: [...note.tags],
    body: normalizeNewlines(note.body),
  }
  store.notes.push(stored)
  store.index.set(idKey(id), stored)
  return id
}

export function getNote(store, id) {
  return store.index.get(idKey(id))
}

export function updateNote(store, id, patch) {
  const wanted = idKey(id)
  const at = store.notes.findIndex(n => idKey(n.id) === wanted)
  if (at === -1) throw new Error('no such note: ' + wanted)
  const next = { ...store.notes[at], ...patch, id: store.notes[at].id }
  if (typeof next.body === 'string') next.body = normalizeNewlines(next.body)
  store.notes[at] = next
  store.index.set(wanted, next)
  return next
}

export function serialize(store) {
  return JSON.stringify({ ns: store.ns, seq: store.seq, notes: store.notes })
}

export function load(json) {
  const raw = JSON.parse(json)
  const store = createStore(raw.ns)
  store.seq = raw.seq
  for (const note of raw.notes) {
    store.notes.push(note)
    store.index.set(idKey(note.id), note)
  }
  return store
}
`

// ── base tests ──────────────────────────────────────────────────────────────

const TEST_ID = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mintId, parseId } from '../src/id.js'

test('mintId pads to six base36 digits', () => {
  assert.equal(mintId('work', 1), 'work-000001')
  assert.equal(mintId('work', 35), 'work-00000z')
  assert.equal(mintId('work', 36), 'work-000010')
})

test('parseId round-trips', () => {
  assert.deepEqual(parseId('log-00000a'), { ns: 'log', seq: 10 })
})

test('bad namespace refuses', () => {
  assert.throws(() => mintId('Bad Ns', 1))
})
`

const TEST_PARSE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNote } from '../src/parse.js'

test('title and bare tags', () => {
  const note = parseNote('Fix the boiler #home #URGENT\\nCall the plumber.')
  assert.equal(note.title, 'Fix the boiler')
  assert.deepEqual(note.tags, ['home', 'urgent'])
  assert.equal(note.body, 'Call the plumber.')
})

test('quoted tags keep their spaces', () => {
  const note = parseNote('Kickoff notes #"project x" #q3\\nAgenda follows.')
  assert.deepEqual(note.tags, ['project x', 'q3'])
  assert.equal(note.title, 'Kickoff notes')
})

test('quoted tag mid-title preserves surrounding words', () => {
  const note = parseNote('Plan #"deep work" review\\n')
  assert.equal(note.title, 'Plan review')
  assert.deepEqual(note.tags, ['deep work'])
})

test('unterminated quoted tag refuses', () => {
  assert.throws(() => parseNote('Broken #"never closed\\n'))
})
`

const TEST_STORE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addNote,
  createStore,
  getNote,
  load,
  normalizeNewlines,
  serialize,
  updateNote,
} from '../src/store.js'

test('add + get round-trips', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'One', tags: ['a'], body: 'body' })
  assert.equal(getNote(store, id).title, 'One')
})

test('CRLF bodies are normalized, never lost', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'Win', tags: [], body: 'line one\\r\\nline two\\rline three' })
  assert.equal(getNote(store, id).body, 'line one\\nline two\\nline three')
})

test('normalizeNewlines is idempotent', () => {
  assert.equal(normalizeNewlines('a\\nb'), 'a\\nb')
})

test('updateNote refreshes indexed reads', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'Old', tags: [], body: 'x' })
  updateNote(store, id, { title: 'New' })
  assert.equal(getNote(store, id).title, 'New')
})

test('serialize/load round-trips', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'Keep', tags: ['t'], body: 'b\\r\\nc' })
  const copy = load(serialize(store))
  assert.equal(getNote(copy, id).body, 'b\\nc')
  assert.equal(copy.seq, 1)
})
`

const TEST_RENDER = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addNote, createStore, updateNote } from '../src/store.js'
import { renderList, renderNote } from '../src/render.js'

test('renderNote shows title, tags and body', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'Hello', tags: ['x', 'y'], body: 'Body.' })
  assert.equal(renderNote(store, id), '# Hello [x, y]\\n\\nBody.\\n')
})

test('renderNote after updateNote shows the new title', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'Before', tags: [], body: 'b' })
  updateNote(store, id, { title: 'After' })
  assert.match(renderNote(store, id), /# After/)
})

test('renderList numbers from 1', () => {
  const store = createStore('work')
  addNote(store, { title: 'First', tags: [], body: '' })
  addNote(store, { title: 'Second', tags: [], body: '' })
  const lines = renderList(store).split('\\n')
  assert.equal(lines[0], '1. First (work-000001)')
  assert.equal(lines[1], '2. Second (work-000002)')
})
`

const TEST_CLI = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.js'
import { runCommand } from '../src/cli.js'

test('add then show', () => {
  const store = createStore('work')
  const added = runCommand(store, ['add', 'Title #tag', 'body'])
  assert.equal(added.code, 0)
  const shown = runCommand(store, ['show', added.out])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /# Title/)
})

test('empty add is a bad-input error', () => {
  const store = createStore('work')
  assert.equal(runCommand(store, ['add', '   ']).code, 1)
})

test('unknown command exits 2', () => {
  const store = createStore('work')
  const result = runCommand(store, ['frobnicate'])
  assert.equal(result.code, 2)
})
`

// ── branch tests (structured ids — failing until the refactor) ──────────

const TEST_ID_STRUCTURED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { idFromKey, idKey, mintId } from '../src/id.js'

test('mintId returns a structured id', () => {
  assert.deepEqual(mintId('work', 1), { ns: 'work', key: '000001' })
})

test('idKey renders the canonical string form', () => {
  assert.equal(idKey({ ns: 'work', key: '000001' }), 'work-000001')
})

test('idFromKey round-trips the canonical form', () => {
  assert.deepEqual(idFromKey('work-00000a'), { ns: 'work', key: '00000a' })
})

test('mintId pads and encodes base36', () => {
  assert.deepEqual(mintId('log', 35), { ns: 'log', key: '00000z' })
})

test('bad namespace still refuses', () => {
  assert.throws(() => mintId('Bad Ns', 1))
})
`

const TEST_STORE_STRUCTURED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addNote,
  createStore,
  getNote,
  load,
  serialize,
  updateNote,
} from '../src/store.js'

test('addNote returns a structured id and getNote accepts it', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'One', tags: [], body: 'b' })
  assert.deepEqual(id, { ns: 'work', key: '000001' })
  assert.equal(getNote(store, id).title, 'One')
})

test('updateNote accepts structured ids', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'Old', tags: [], body: 'x' })
  updateNote(store, id, { title: 'New' })
  assert.equal(getNote(store, id).title, 'New')
})

test('serialize/load round-trips structured ids', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'Keep', tags: [], body: 'b' })
  const copy = load(serialize(store))
  assert.equal(getNote(copy, id).title, 'Keep')
})
`

const TEST_RENDER_STRUCTURED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addNote, createStore } from '../src/store.js'
import { renderList, renderNote } from '../src/render.js'

test('renderNote accepts structured ids', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'Hello', tags: ['x'], body: 'Body.' })
  assert.equal(renderNote(store, id), '# Hello [x]\\n\\nBody.\\n')
})

test('renderList shows canonical id strings', () => {
  const store = createStore('work')
  addNote(store, { title: 'First', tags: [], body: '' })
  const lines = renderList(store).split('\\n')
  assert.equal(lines[0], '1. First (work-000001)')
})
`

const TEST_CLI_STRUCTURED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.js'
import { runCommand } from '../src/cli.js'

test('add prints the canonical id and show accepts it', () => {
  const store = createStore('work')
  const added = runCommand(store, ['add', 'Title #tag', 'body'])
  assert.equal(added.code, 0)
  assert.equal(added.out, 'work-000001')
  const shown = runCommand(store, ['show', 'work-000001'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /# Title/)
})

test('show with an unparseable id is a bad-input error', () => {
  const store = createStore('work')
  assert.equal(runCommand(store, ['show', 'nodash']).code, 1)
})

test('unknown command still exits 2', () => {
  const store = createStore('work')
  assert.equal(runCommand(store, ['frobnicate']).code, 2)
})
`

// ── branch tests (pinned + archived — failing until implemented) ────────

const TEST_PIN = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addNote, createStore, NOTE_FIELDS } from '../src/store.js'
import { setPinned } from '../src/store.js'
import { renderList } from '../src/render.js'
import { runCommand } from '../src/cli.js'

test('pinned is a first-class note field', () => {
  assert.ok(NOTE_FIELDS.includes('pinned'))
})

test('notes default to unpinned', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'A', tags: [], body: '' })
  assert.equal(store.notes[0].pinned, false)
  assert.equal(typeof setPinned, 'function')
  setPinned(store, id, true)
  assert.equal(store.notes[0].pinned, true)
})

test('renderList floats pinned notes first, stably, with a star', () => {
  const store = createStore('work')
  addNote(store, { title: 'One', tags: [], body: '' })
  const two = addNote(store, { title: 'Two', tags: [], body: '' })
  addNote(store, { title: 'Three', tags: [], body: '' })
  setPinned(store, two, true)
  const lines = renderList(store).split('\\n')
  assert.equal(lines[0], '1. * Two (work-000002)')
  assert.equal(lines[1], '2. One (work-000001)')
  assert.equal(lines[2], '3. Three (work-000003)')
})

test('cli pin command sets the flag', () => {
  const store = createStore('work')
  const added = runCommand(store, ['add', 'A note', 'body'])
  const pinned = runCommand(store, ['pin', added.out])
  assert.equal(pinned.code, 0)
  assert.equal(store.notes[0].pinned, true)
})

test('cli pin with a bad id is a bad-input error', () => {
  const store = createStore('work')
  assert.equal(runCommand(store, ['pin', 'work-999999']).code, 1)
})
`

const TEST_ARCHIVE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addNote, createStore, NOTE_FIELDS } from '../src/store.js'
import { setArchived } from '../src/store.js'
import { renderList } from '../src/render.js'
import { runCommand } from '../src/cli.js'

test('archived is a first-class note field', () => {
  assert.ok(NOTE_FIELDS.includes('archived'))
})

test('notes default to unarchived', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'A', tags: [], body: '' })
  assert.equal(store.notes[0].archived, false)
  assert.equal(typeof setArchived, 'function')
  setArchived(store, id, true)
  assert.equal(store.notes[0].archived, true)
})

test('renderList hides archived notes by default', () => {
  const store = createStore('work')
  addNote(store, { title: 'Keep', tags: [], body: '' })
  const gone = addNote(store, { title: 'Gone', tags: [], body: '' })
  setArchived(store, gone, true)
  const lines = renderList(store).split('\\n')
  assert.equal(lines.length, 1)
  assert.equal(lines[0], '1. Keep (work-000001)')
})

test('renderList with all:true shows archived notes', () => {
  const store = createStore('work')
  const gone = addNote(store, { title: 'Gone', tags: [], body: '' })
  setArchived(store, gone, true)
  const lines = renderList(store, { all: true }).split('\\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Gone/)
})

test('cli archive command sets the flag', () => {
  const store = createStore('work')
  const added = runCommand(store, ['add', 'A note', 'body'])
  const archived = runCommand(store, ['archive', added.out])
  assert.equal(archived.code, 0)
  assert.equal(store.notes[0].archived, true)
})
`

/** reference: pinned + archived implemented at the shared owner. */
export const STORE_FLAGS = STORE_BASE.replace(
  `export const NOTE_FIELDS = ['id', 'title', 'tags', 'body']`,
  `export const NOTE_FIELDS = ['id', 'title', 'tags', 'body', 'pinned', 'archived']`,
).replace(
  `  const stored = {
    id,
    title: note.title,
    tags: [...note.tags],
    body: normalizeNewlines(note.body),
  }`,
  `  const stored = {
    id,
    title: note.title,
    tags: [...note.tags],
    body: normalizeNewlines(note.body),
    pinned: false,
    archived: false,
  }`,
) + `
export function setPinned(store, id, pinned) {
  return updateNote(store, id, { pinned: Boolean(pinned) })
}

export function setArchived(store, id, archived) {
  return updateNote(store, id, { archived: Boolean(archived) })
}
`

export const RENDER_FLAGS = `import { getNote } from './store.js'

export function renderNote(store, id) {
  const note = getNote(store, id)
  if (!note) return '(missing note ' + id + ')'
  const tagLine = note.tags.length > 0 ? ' [' + note.tags.join(', ') + ']' : ''
  return '# ' + note.title + tagLine + '\\n\\n' + note.body + '\\n'
}

export function renderList(store, options) {
  const all = Boolean(options && options.all)
  const visible = store.notes.filter(n => all || !n.archived)
  const pinned = visible.filter(n => n.pinned)
  const rest = visible.filter(n => !n.pinned)
  const lines = []
  let n = 1
  for (const note of [...pinned, ...rest]) {
    const star = note.pinned ? '* ' : ''
    lines.push(String(n) + '. ' + star + note.title + ' (' + note.id + ')')
    n += 1
  }
  return lines.join('\\n')
}
`

export const CLI_FLAGS = CLI_BASE.replace(
  `import { addNote, getNote } from './store.js'`,
  `import { addNote, getNote, setArchived, setPinned } from './store.js'`,
).replace(
  `  if (cmd === 'list') {`,
  `  if (cmd === 'pin') {
    const note = getNote(store, rest[0])
    if (!note) return { code: 1, out: 'pin: no such note' }
    setPinned(store, rest[0], true)
    return { code: 0, out: 'pinned ' + rest[0] }
  }
  if (cmd === 'archive') {
    const note = getNote(store, rest[0])
    if (!note) return { code: 1, out: 'archive: no such note' }
    setArchived(store, rest[0], true)
    return { code: 0, out: 'archived ' + rest[0] }
  }
  if (cmd === 'list') {`,
)

// ── comparison-partition overlays (task/cmp-*) ────────────────────

/** defect: serialize drops the sequence counter — ids collide after a
 *  load. The base store test's round-trip assertion catches it. */
const STORE_SERIALIZE_DROPS_SEQ = STORE_BASE.replace(
  `export function serialize(store) {
  return JSON.stringify({ ns: store.ns, seq: store.seq, notes: store.notes })
}`,
  `export function serialize(store) {
  return JSON.stringify({ ns: store.ns, notes: store.notes })
}`,
).replace(
  `  store.seq = raw.seq`,
  `  store.seq = raw.seq ?? 0`,
)

/** reference: the tag index at the store owner + the cli filter. */
export const STORE_TAGINDEX = STORE_BASE + `
export function findByTag(store, tag) {
  const wanted = String(tag).toLowerCase()
  return store.notes.filter(n => n.tags.includes(wanted))
}
`

export const CLI_TAGINDEX = CLI_BASE.replace(
  `import { addNote, getNote } from './store.js'`,
  `import { addNote, findByTag, getNote } from './store.js'`,
).replace(
  `  if (cmd === 'list') {
    return { code: 0, out: renderList(store) }
  }`,
  `  if (cmd === 'list') {
    if (rest[0] === '--tag') {
      const matches = findByTag(store, rest[1] ?? '')
      return { code: 0, out: renderList({ notes: matches }) }
    }
    return { code: 0, out: renderList(store) }
  }`,
)

/** falsify: the case-sensitive index (misses folded tags). */
export const STORE_TAGINDEX_CASE_SENSITIVE = STORE_BASE + `
export function findByTag(store, tag) {
  return store.notes.filter(n => n.tags.includes(String(tag)))
}
`

/** branch: the tag-index acceptance oracle (failing until implemented). */
const TEST_TAGS = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addNote, createStore, findByTag } from '../src/store.js'
import { runCommand } from '../src/cli.js'

test('findByTag matches case-insensitively over folded tags', () => {
  const store = createStore('work')
  addNote(store, { title: 'One', tags: ['home'], body: '' })
  addNote(store, { title: 'Two', tags: ['office'], body: '' })
  assert.equal(findByTag(store, 'home').length, 1)
  assert.equal(findByTag(store, 'HOME').length, 1)
  assert.equal(findByTag(store, 'Home')[0].title, 'One')
})

test('findByTag with an unknown tag is empty', () => {
  const store = createStore('work')
  addNote(store, { title: 'One', tags: ['a'], body: '' })
  assert.deepEqual(findByTag(store, 'nope'), [])
})

test('cli list --tag filters the listing', () => {
  const store = createStore('work')
  runCommand(store, ['add', 'Alpha #home', 'body'])
  runCommand(store, ['add', 'Beta #office', 'body'])
  const filtered = runCommand(store, ['list', '--tag', 'home'])
  assert.equal(filtered.code, 0)
  const lines = filtered.out.split('\\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Alpha/)
})

test('cli plain list is unchanged', () => {
  const store = createStore('work')
  runCommand(store, ['add', 'Alpha #home', 'body'])
  runCommand(store, ['add', 'Beta #office', 'body'])
  assert.equal(runCommand(store, ['list']).out.split('\\n').length, 2)
})
`

/** reference: word-count + tag-count land at the ONE render owner. */
export const RENDER_STATS = `import { getNote } from './store.js'

export function renderNote(store, id, options) {
  const note = getNote(store, id)
  if (!note) return '(missing note ' + id + ')'
  const tagLine = note.tags.length > 0 ? ' [' + note.tags.join(', ') + ']' : ''
  let out = '# ' + note.title + tagLine + '\\n\\n' + note.body + '\\n'
  if (options && options.stats) {
    const trimmed = note.body.trim()
    const words = trimmed === '' ? 0 : trimmed.split(/\\s+/).length
    out += '(' + words + ' words)\\n'
  }
  return out
}

export function renderList(store) {
  const lines = []
  let n = 1
  for (const note of store.notes) {
    const tagCount = note.tags.length > 0 ? ' [' + note.tags.length + ' tags]' : ''
    lines.push(String(n) + '. ' + note.title + ' (' + note.id + ')' + tagCount)
    n += 1
  }
  return lines.join('\\n')
}
`

/** branch: both stats specs target the ONE render owner. */
const TEST_WORDCOUNT = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addNote, createStore } from '../src/store.js'
import { renderNote } from '../src/render.js'

test('stats option appends the word count', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'Hello', tags: ['x'], body: 'Body here now.' })
  assert.equal(
    renderNote(store, id, { stats: true }),
    '# Hello [x]\\n\\nBody here now.\\n(3 words)\\n',
  )
})

test('an empty body counts zero words', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'Empty', tags: [], body: '' })
  assert.match(renderNote(store, id, { stats: true }), /\\(0 words\\)/)
})

test('without the option the render is unchanged', () => {
  const store = createStore('work')
  const id = addNote(store, { title: 'Plain', tags: [], body: 'b' })
  assert.equal(renderNote(store, id), '# Plain\\n\\nb\\n')
})
`

const TEST_TAGCOUNT = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addNote, createStore } from '../src/store.js'
import { renderList } from '../src/render.js'

test('list rows show a tag count when tags exist', () => {
  const store = createStore('work')
  addNote(store, { title: 'Tagged', tags: ['a', 'b'], body: '' })
  addNote(store, { title: 'Bare', tags: [], body: '' })
  const lines = renderList(store).split('\\n')
  assert.equal(lines[0], '1. Tagged (work-000001) [2 tags]')
  assert.equal(lines[1], '2. Bare (work-000002)')
})
`

// ── the repo spec ───────────────────────────────────────────────────────────

const BASE_FILES: FileMap = {
  'package.json': PACKAGE_JSON,
  'src/id.js': ID_BASE,
  'src/store.js': STORE_BASE,
  'src/parse.js': PARSE_BASE,
  'src/render.js': RENDER_BASE,
  'src/cli.js': CLI_BASE,
  'test/id.test.mjs': TEST_ID,
  'test/parse.test.mjs': TEST_PARSE,
  'test/store.test.mjs': TEST_STORE,
  'test/render.test.mjs': TEST_RENDER,
  'test/cli.test.mjs': TEST_CLI,
}

const BRANCHES: Record<string, BranchOverlay> = {
  'task/parse-defect': { 'src/parse.js': PARSE_TOKEN_SPLIT },
  'task/refactor-id': {
    'test/id.test.mjs': TEST_ID_STRUCTURED,
    'test/store.test.mjs': TEST_STORE_STRUCTURED,
    'test/render.test.mjs': TEST_RENDER_STRUCTURED,
    'test/cli.test.mjs': TEST_CLI_STRUCTURED,
  },
  'task/misleading': { 'src/store.js': STORE_STALE_INDEX },
  'task/tiny': { 'src/cli.js': CLI_EXIT_ZERO },
  'task/shared-schema': {
    'test/pin.test.mjs': TEST_PIN,
    'test/archive.test.mjs': TEST_ARCHIVE,
  },
  'task/lanes': {
    'src/parse.js': PARSE_NO_CASEFOLD,
    'src/render.js': RENDER_ZERO_NUMBERING,
  },
  'task/cmp-serialize': { 'src/store.js': STORE_SERIALIZE_DROPS_SEQ },
  'task/cmp-tags': { 'test/tags.test.mjs': TEST_TAGS },
  'task/cmp-render-stats': {
    'test/wordcount.test.mjs': TEST_WORDCOUNT,
    'test/tagcount.test.mjs': TEST_TAGCOUNT,
  },
}

export const NOTEDECK_REPO: HelixRepoSpec = {
  id: 'notedeck',
  seed: 'inline',
  files: BASE_FILES,
  // family 17 (multi-file change sets) rides self-contained
  // overlays — new files beside the untouched all-green base.
  branches: { ...BRANCHES, ...MF_BRANCHES },
}

/** Reference/falsify content re-exported for tasks.ts. */
export const NOTEDECK_CONTENT = {
  PARSE_BASE,
  STORE_BASE,
  RENDER_BASE,
  CLI_BASE,
  ID_STRUCTURED,
  STORE_STRUCTURED,
  RENDER_STRUCTURED,
  CLI_STRUCTURED,
  STORE_FLAGS,
  RENDER_FLAGS,
  CLI_FLAGS,
  TEST_STORE,
  TEST_PARSE,
  STORE_TAGINDEX,
  CLI_TAGINDEX,
  STORE_TAGINDEX_CASE_SENSITIVE,
  RENDER_STATS,
} as const
