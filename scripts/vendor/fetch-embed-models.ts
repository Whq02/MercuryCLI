#!/usr/bin/env bun
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  EMBED_DEFAULT_MODEL,
  EMBED_MODELS,
  EMBED_MODELS_VENDOR_PATH,
  checkEmbedModel,
  downloadEmbedModel,
  embedModelByName,
  mbWords,
  type EmbedModelRow,
} from '../../src/mneme/embedModels.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const CACHE_DIR = join(ROOT, 'vendor', 'embed-models')

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const force = argv.includes('--force')
const all = argv.includes('--all')

function fail(msg: string): never {
  console.error(`fetch-embed-models: ${msg}`)
  process.exit(1)
}

function proverPair(): EmbedModelRow[] {
  const rows = [embedModelByName(EMBED_DEFAULT_MODEL)]
  const smallest = [...EMBED_MODELS].sort((a, b) => a.bytes - b.bytes)[0] ?? null
  if (smallest && !rows.some(r => r?.name === smallest.name)) rows.push(smallest)
  return rows.filter((r): r is EmbedModelRow => r !== null)
}

function selectRows(): EmbedModelRow[] {
  if (all) return [...EMBED_MODELS]
  const named: EmbedModelRow[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--model') continue
    const value = argv[i + 1]
    const row = value ? embedModelByName(value) : null
    if (!row) fail(`--model wants one of ${EMBED_MODELS.map(r => r.name).join(', ')} (got ${value ?? 'nothing'})`)
    if (!named.some(r => r.name === row.name)) named.push(row)
    i++
  }
  return named.length > 0 ? named : proverPair()
}

function cacheInvalidReason(row: EmbedModelRow): string | null {
  const check = checkEmbedModel({ kind: 'catalogue', row, pinned: true }, { dir: CACHE_DIR, digest: true })
  if (check.state === 'present') return null
  if (check.state === 'absent') return `absent (${EMBED_MODELS_VENDOR_PATH}/${row.file})`
  if (check.state === 'ollama') return 'unexpected ollama pin'
  return check.note
}

async function main(): Promise<void> {
  const rows = selectRows()
  if (checkOnly) {
    let stale = 0
    for (const row of rows) {
      const invalid = cacheInvalidReason(row)
      if (invalid === null) console.log(`fetch-embed-models --check: OK — ${row.name} (${mbWords(row.bytes)}) cache valid against the lock`)
      else {
        stale++
        console.error(`fetch-embed-models --check: STALE — ${row.name}: ${invalid}`)
      }
    }
    if (stale > 0) {
      console.error('  remedy: bun run scripts/vendor/fetch-embed-models.ts (downloads the pinned files, verifies sha256)')
      process.exit(2)
    }
    process.exit(0)
  }
  for (const row of rows) {
    const invalid = cacheInvalidReason(row)
    if (invalid === null && !force) {
      console.log(`fetch-embed-models: cache already valid for ${row.name} — nothing to do (--force re-fetches)`)
      continue
    }
    console.log(`fetch-embed-models: downloading ${row.url} (${mbWords(row.bytes)})`)
    let lastMark = 0
    const result = await downloadEmbedModel(row, CACHE_DIR, {
      force,
      onProgress: (received, total) => {
        const mark = Math.floor((received / total) * 10)
        if (mark > lastMark) {
          lastMark = mark
          console.log(`  ${mark * 10}%`)
        }
      },
    }).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
    console.log(`fetch-embed-models: verified sha256 ${result.sha256.slice(0, 12)}… (${result.bytes} bytes${result.reused ? ', reused' : ''}) → ${EMBED_MODELS_VENDOR_PATH}/${row.file}`)
    const post = cacheInvalidReason(row)
    if (post !== null) fail(`post-download validation failed for ${row.name}: ${post}`)
    console.log(`fetch-embed-models: DONE — ${row.name} ready for the provers (${statSync(result.path).size} bytes)`)
  }
  if (!existsSync(CACHE_DIR)) fail(`${EMBED_MODELS_VENDOR_PATH} was not created`)
}

void main()
