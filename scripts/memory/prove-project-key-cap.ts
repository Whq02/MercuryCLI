#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'project-key-cap-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { mnemeProjectKeyFor, lineagePath, getMemoryBaseDir } = await import('../../src/mneme/paths.js')
const { getProjectDir, sanitizePath, MAX_SANITIZED_LENGTH, capSanitizedName } = await import('../../src/utils/sessionStoragePortable.js')
const { sanitizePathComponent } = await import('../../src/utils/tasks.js')

let deepRoot = join(scratch, 'deep')
for (let index = 1; deepRoot.length < 236; index++) deepRoot = join(deepRoot, `lvl-abcdefghij${index}`)
mkdirSync(deepRoot, { recursive: true })
const deeperRoot = join(deepRoot, ...Array.from({ length: 12 }, (_, index) => `more-klmnopqrst${index + 1}`))
const shortRoot = join(scratch, 'short-project')
mkdirSync(shortRoot, { recursive: true })
console.log(`deep root: ${deepRoot.length} chars`)

section('§1 one cap law for every store key: a project path over the cap is slugged, truncated and suffixed with its hash for the memory store exactly as for the transcript store')
const memoryKey = mnemeProjectKeyFor(deepRoot)
const transcriptDir = getProjectDir(deepRoot)
const transcriptKey = transcriptDir.slice(transcriptDir.lastIndexOf('/') + 1).slice(transcriptDir.lastIndexOf('\\') + 1)
console.log(`  memory key:     ${memoryKey} (${memoryKey.length} chars)`)
console.log(`  transcript key: ${transcriptKey} (${transcriptKey.length} chars)`)
check('the memory key is capped: at most the cap plus one hash suffix', memoryKey.length <= MAX_SANITIZED_LENGTH + 1 + 16, `${memoryKey.length} chars`)
check('the memory key is the capped form of its own slug (truncated at the cap, then the hash of the path)', memoryKey === capSanitizedName(sanitizePathComponent(deepRoot), deepRoot) && memoryKey.startsWith(sanitizePathComponent(deepRoot).slice(0, MAX_SANITIZED_LENGTH) + '-'), memoryKey)
check('the transcript key is capped the same way (the same cap, the same hash of the same path)', sanitizePath(deepRoot) === capSanitizedName(deepRoot.replace(/[^a-zA-Z0-9]/g, '-'), deepRoot) && transcriptKey.startsWith(sanitizePath(deepRoot)), transcriptKey)
check('the memory key and the transcript key carry the same cap-hash suffix for the same path', memoryKey.slice(memoryKey.lastIndexOf('-')) === sanitizePath(deepRoot).slice(sanitizePath(deepRoot).lastIndexOf('-')), `${memoryKey} vs ${sanitizePath(deepRoot)}`)
const deeperKey = mnemeProjectKeyFor(deeperRoot)
check('the key length is bounded whatever the depth: a path twice as deep keys to the same bounded length (a 255-byte filename limit can no longer be hit)', deeperKey.length <= MAX_SANITIZED_LENGTH + 1 + 16 && Math.abs(deeperKey.length - memoryKey.length) <= 3 && deeperRoot.length > 255, `${deeperKey.length} chars for a ${deeperRoot.length}-char path`)
check('the lineage ledger path past the home is bounded the same way', lineagePath(deeperKey).length - getMemoryBaseDir().length <= 1 + 'projects'.length + 1 + MAX_SANITIZED_LENGTH + 1 + 16 + '/lineage/ledger.jsonl'.length, `${lineagePath(deeperKey).length - getMemoryBaseDir().length} chars past the home`)
const shortKey = mnemeProjectKeyFor(shortRoot)
check('a path under the cap keeps its plain key — no suffix, no change for every existing store', shortKey === sanitizePathComponent(shortRoot) && !/-[0-9a-z]{6,}$/.test(shortKey.slice(sanitizePathComponent(shortRoot).length)), shortKey)

section('§2 the hardest case of the retired-spelling law: a store written under the long form is read where it stands — no move, no alias')
const uncapped = sanitizePathComponent(deepRoot)
const projects = join(getMemoryBaseDir(), 'projects')
mkdirSync(join(projects, uncapped, 'lineage'), { recursive: true })
writeFileSync(join(projects, uncapped, 'lineage', 'ledger.jsonl'), '{"sessionId":"old","ordinal":1}\n')
const keyWithOldStore = mnemeProjectKeyFor(deepRoot)
check('with only the long-form store on disk, the key is the long form (the existing ledger is read where it stands)', keyWithOldStore === uncapped, keyWithOldStore)
check('…so the lineage path is the existing file', lineagePath(keyWithOldStore) === join(projects, uncapped, 'lineage', 'ledger.jsonl') && existsSync(lineagePath(keyWithOldStore)), lineagePath(keyWithOldStore))
check('nothing was moved or created under the capped key', !existsSync(join(projects, memoryKey)))
mkdirSync(join(projects, memoryKey), { recursive: true })
check('when both forms exist, the capped form is the law', mnemeProjectKeyFor(deepRoot) === memoryKey, mnemeProjectKeyFor(deepRoot))

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-project-key-cap: ALL LAWS HOLD' : `\nprove-project-key-cap: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
