import { workerRowWords } from '../../src/daemon/status.ts'
import type { WireRosterEntry } from '../../src/daemon/protocol.ts'

const row = { short: 'concourse-w1', sessionId: 'session-under-proof', pid: 42, state: 'running', model: 'claude-opus-5-5', effort: 'high' } as WireRosterEntry
const warm = workerRowWords({ ...row, warm: true } as WireRosterEntry)
const claimed = workerRowWords(row)
const ok = warm.includes('warm runner') && warm.includes('unclaimed') && !warm.includes(' · session ') && claimed.includes('session session-')
console.log(`${ok ? 'PASS' : 'FAIL'} a pre-booted runner is named as warm, not as a session\n${warm}\n${claimed}`)
process.exit(ok ? 0 : 1)
