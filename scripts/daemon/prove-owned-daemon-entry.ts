import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.MERCURY_CONFIG_DIR
assert(home, 'run with a scratch MERCURY_CONFIG_DIR')
const scratch = mkdtempSync(join(home, 'owned-daemon-entry-'))
const { spawnOwnedDaemon } = await import('../../src/daemon/ownedDaemon.ts')
let checks = 0
const check = (label: string, value: unknown) => { assert(value, label); console.log(`PASS ${label}`); checks++ }
const settle = (ms: number) => new Promise(res => setTimeout(res, ms))

const self = (globalThis as { Bun?: { main?: string } }).Bun?.main ?? process.argv[1]!
check('this proof runs as its own entry (Bun.main is this file)', self.endsWith('prove-owned-daemon-entry.ts'))
const realArgv1 = process.argv[1]

for (const name of ['from-self', 'from-fixture', 'from-shipped']) mkdirSync(join(scratch, name), { recursive: true })
process.argv[1] = self
const fromSelf = spawnOwnedDaemon(join(scratch, 'from-self'), { label: 'entry-self' })
check('with no script given and the running proof as argv[1], no daemon is spawned (the proof would only relaunch itself)', fromSelf === undefined)

const fixture = join(scratch, 'fixture-daemon.ts')
writeFileSync(fixture, "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.ENTRY_PROOF_MARK!, process.argv.slice(2).join(' '))\n")
const mark = join(scratch, 'fixture.mark')
process.argv[1] = fixture
const fromFixture = spawnOwnedDaemon(join(scratch, 'from-fixture'), { label: 'entry-fixture', extraEnv: { ENTRY_PROOF_MARK: mark } })
await settle(1500)
check('a fixture a proof stands in as the entry on purpose still spawns, with the daemon run arguments', typeof fromFixture === 'number' && readFileSync(mark, 'utf8').startsWith('daemon run '))

const shipped = join(scratch, 'builds', 'abc', 'mercury.mjs')
mkdirSync(join(scratch, 'builds', 'abc'), { recursive: true })
writeFileSync(shipped, "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.ENTRY_PROOF_MARK, process.argv.slice(2).join(' '))\n")
const mark2 = join(scratch, 'shipped.mark')
process.argv[1] = shipped
const fromShipped = spawnOwnedDaemon(join(scratch, 'from-shipped'), { label: 'entry-shipped', extraEnv: { ENTRY_PROOF_MARK: mark2 } })
await settle(1500)
check('a mercury.mjs entry spawns as before', typeof fromShipped === 'number' && readFileSync(mark2, 'utf8').startsWith('daemon run '))
process.argv[1] = realArgv1

const source = readFileSync(new URL('../../src/daemon/ownedDaemon.ts', import.meta.url), 'utf8')
check('the guard reads the host entry from Bun.main first and names mercury.mjs, src/main.tsx and src/entrypoints as the entries', source.includes("Bun?: { main?: string } }).Bun?.main ?? process.argv[1]") && source.includes("/^mercury(?:\\.m?js|\\.cjs)?$/") && source.includes("\\/src\\/main\\.tsx$") && source.includes("\\/src\\/entrypoints\\/"))
console.log(`owned daemon entry: ${checks} checks passed`)
