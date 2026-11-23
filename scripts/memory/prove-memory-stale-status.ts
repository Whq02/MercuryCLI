import assert from 'node:assert/strict'
import { memoryStatusWords, renderMemoryRefLine, type MemoryRef } from '../../src/sessions/mneme/memoryRefs.ts'
import { renderPointerLine } from '../../src/sessions/mneme/mnemePointers.ts'

const ref: MemoryRef = { refId: 'mneme:12', kind: 'mneme-fact', store: 'mneme', scope: 'project', status: 'stale', confirmedAt: '2026-01-01T00:00:00.000Z', summary: 'the archive keeps a copy', why: 'content matches archive', deref: 'Recall read:"seq:12"', tier: 2 }
const mark = '[stale — not confirmed since 2026-01-01]'
assert(renderMemoryRefLine(ref).includes(mark), `renderMemoryRefLine in src/sessions/mneme/memoryRefs.ts must include stale mark ${mark}`)
assert(renderPointerLine({ id: 'seq:12', title: `archive [${memoryStatusWords(ref)}]`, kind: 'fact', footnotes: {} }).includes(mark), `renderPointerLine in src/sessions/mneme/mnemePointers.ts must render stale mark ${mark} from memoryStatusWords`)
assert(renderMemoryRefLine({ ...ref, status: 'needs-review' }).includes('[needs review — cited path moved]'), 'renderMemoryRefLine in src/sessions/mneme/memoryRefs.ts must render [needs review — cited path moved] for needs-review status')
assert(!renderMemoryRefLine({ ...ref, status: 'current' }).includes('[stale'), 'renderMemoryRefLine in src/sessions/mneme/memoryRefs.ts must omit [stale tag for current status')
console.log('PASS shared stale status and date on reference and Recall pointer')
