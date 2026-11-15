#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withProofAccountHome } from '../lib/proofAccountHome.ts'
import { pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import * as worldFixture from './fixtures/world.ts'

withProofAccountHome('tensorfold-fixture-')
const home = pinScratchHome('tensorfold-fixture')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const inventory = await import('../../src/services/tensorfold/inventory.ts')

const { QWEN_2B_CONFIG, QWEN_2B_PIN, QWEN_2B_REPO } = worldFixture
const SCRATCH = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tf-fixture-proof-'))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const refusing = (code: string) => (): never => {
  throw Object.assign(new Error(`${code}: operation not permitted`), { code })
}

section('1 · the weights of a seeded checkpoint: a symbolic link, a hard link where that is refused, a copy where both are')
{
  const seeds = [{ repo: QWEN_2B_REPO, config: QWEN_2B_CONFIG, weightsBytes: 4096, sha: QWEN_2B_PIN }]
  const seeded = (name: string, io?: Record<string, unknown>): { root: string; blob: string; file: string; error?: string } => {
    const root = join(SCRATCH, name)
    mkdirSync(root, { recursive: true })
    const base = join(root, `models--${QWEN_2B_REPO.replace('/', '--')}`)
    const made = { root, blob: join(base, 'blobs', 'weightsblob'), file: join(base, 'snapshots', QWEN_2B_PIN, 'model.safetensors') }
    try {
      ;(worldFixture.seedHfCache as unknown as (root: string, seeds: unknown, io?: unknown) => void)(root, seeds, io)
      return made
    } catch (error) {
      return { ...made, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const linked = seeded('linked')
  const linkedSeen = linked.error === undefined ? lstatSync(linked.file) : undefined
  check('a seed made as this host allows holds its weights: the symbolic link it held, or a hard link where this account may make none', linkedSeen !== undefined && statSync(linked.file).size === 4096 && (linkedSeen.isSymbolicLink() || linkedSeen.ino === statSync(linked.blob).ino), linked.error ?? '')
  const hard = seeded('hard', { symlink: refusing('EPERM') })
  const hardSeen = hard.error === undefined && existsSync(hard.file) ? lstatSync(hard.file) : undefined
  check('[CHECKPOINT 104] where the symbolic link is refused (EPERM, as on the Windows box) the weights are a hard link to the blob', hardSeen !== undefined && !hardSeen.isSymbolicLink() && hardSeen.isFile() && hardSeen.ino === statSync(hard.blob).ino && statSync(hard.blob).nlink === 2, hard.error ?? (hardSeen === undefined ? 'no file' : `symlink ${hardSeen.isSymbolicLink()} links ${statSync(hard.blob).nlink}`))
  const copied = seeded('copied', { symlink: refusing('EPERM'), link: refusing('EPERM') })
  const copySeen = copied.error === undefined && existsSync(copied.file) ? lstatSync(copied.file) : undefined
  check('where the hard link is refused too they are a copy of the blob', copySeen !== undefined && !copySeen.isSymbolicLink() && copySeen.isFile() && copySeen.ino !== statSync(copied.blob).ino && copySeen.size === 4096 && statSync(copied.blob).nlink === 1, copied.error ?? (copySeen === undefined ? 'no file' : `symlink ${copySeen.isSymbolicLink()} size ${copySeen.size}`))
  const read = [linked, hard, copied].map(made => inventory.readHfSnapshot(made.root, QWEN_2B_REPO))
  check('the product reads the three caches alike: the checkpoint, its weights of 4,096 bytes, nothing half fetched', hardSeen !== undefined && !hardSeen.isSymbolicLink() && copySeen !== undefined && !copySeen.isSymbolicLink() && read.every(snapshot => snapshot !== undefined && snapshot.weightsBytes === 4096 && snapshot.incompleteBytes === 0 && snapshot.config.model_type === 'qwen3_5'), JSON.stringify(read.map(snapshot => snapshot?.weightsBytes)))
  const twice = seeded('linked')
  check('weights already standing where a seed would put its own are still an error, never a second file laid over them (holds on the parent too)', twice.error !== undefined && twice.error.includes('EEXIST'), String(twice.error))
}

rmSync(SCRATCH, { recursive: true, force: true })
await releaseScratchHome(home)
console.log(`\n${checks - failures} of ${checks} checks hold`)
console.log(`prove-tensorfold-fixture: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
