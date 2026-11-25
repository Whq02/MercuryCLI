import type { ProofPair } from './locked-refresh-road.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const [path = '', base = ''] = process.argv.slice(2)
const { lockedRefresh } = await import('../../../src/models/sign-in/lifecycle/lockedRefresh.ts')
const { proofRoad, readRow, told } = await import('./locked-refresh-road.ts')

const refresh = lockedRefresh<ProofPair>()
const before = readRow(path)?.tokens?.refreshToken
const refreshing = refresh(proofRoad(path, base))
console.log(JSON.stringify({ about: 'refresh', before }))
const answer = await refreshing
console.log(JSON.stringify({ before, answer: told(answer), stored: readRow(path)?.tokens?.refreshToken }))
