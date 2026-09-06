#!/usr/bin/env bun
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  WHISPER_DEFAULT_MODEL,
  WHISPER_MODELS,
  WHISPER_MODELS_VENDOR_PATH,
  checkWhisperModel,
  downloadWhisperModel,
  mbWords,
  whisperModelByName,
  type WhisperModelRow,
} from '../../src/services/voice/whisperModels.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const CACHE_DIR = join(ROOT, 'vendor', 'whisper-models')

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const force = argv.includes('--force')
const all = argv.includes('--all')

function fail(msg: string): never {
  console.error(`fetch-whisper-models: ${msg}`)
  process.exit(1)
}

function proverPair(): WhisperModelRow[] {
  const rows = [whisperModelByName(WHISPER_DEFAULT_MODEL)]
  const smallest = [...WHISPER_MODELS].filter(r => r.language === 'en').sort((a, b) => a.bytes - b.bytes)[0] ?? null
  if (smallest && !rows.some(r => r?.name === smallest.name)) rows.push(smallest)
  return rows.filter((r): r is WhisperModelRow => r !== null)
}

function selectRows(): WhisperModelRow[] {
  if (all) return [...WHISPER_MODELS]
  const named: WhisperModelRow[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--model') continue
    const value = argv[i + 1]
    const row = value ? whisperModelByName(value) : null
    if (!row) fail(`--model wants one of ${WHISPER_MODELS.map(r => r.name).join(', ')} (got ${value ?? 'nothing'})`)
    if (!named.some(r => r.name === row.name)) named.push(row)
    i++
  }
  return named.length > 0 ? named : proverPair()
}

function cacheInvalidReason(row: WhisperModelRow): string | null {
  const check = checkWhisperModel({ kind: 'catalogue', row, pinned: true }, { dir: CACHE_DIR, digest: true })
  if (check.state === 'present') return null
  if (check.state === 'absent') return `absent (${WHISPER_MODELS_VENDOR_PATH}/${row.file})`
  return check.note
}

async function main(): Promise<void> {
  const rows = selectRows()
  if (checkOnly) {
    let stale = 0
    for (const row of rows) {
      const invalid = cacheInvalidReason(row)
      if (invalid === null) console.log(`fetch-whisper-models --check: OK — ${row.name} (${mbWords(row.bytes)}) cache valid against the lock`)
      else {
        stale++
        console.error(`fetch-whisper-models --check: STALE — ${row.name}: ${invalid}`)
      }
    }
    if (stale > 0) {
      console.error('  remedy: bun run scripts/vendor/fetch-whisper-models.ts (downloads the pinned files, verifies sha256)')
      process.exit(2)
    }
    process.exit(0)
  }
  for (const row of rows) {
    const invalid = cacheInvalidReason(row)
    if (invalid === null && !force) {
      console.log(`fetch-whisper-models: cache already valid for ${row.name} — nothing to do (--force re-fetches)`)
      continue
    }
    console.log(`fetch-whisper-models: downloading ${row.url} (${mbWords(row.bytes)})`)
    let lastMark = 0
    const result = await downloadWhisperModel(row, CACHE_DIR, {
      force,
      onProgress: (received, total) => {
        const mark = Math.floor((received / total) * 10)
        if (mark > lastMark) {
          lastMark = mark
          console.log(`  ${mark * 10}%`)
        }
      },
    }).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)))
    console.log(`fetch-whisper-models: verified sha256 ${result.sha256.slice(0, 12)}… (${result.bytes} bytes${result.reused ? ', reused' : ''}) → ${WHISPER_MODELS_VENDOR_PATH}/${row.file}`)
    const post = cacheInvalidReason(row)
    if (post !== null) fail(`post-download validation failed for ${row.name}: ${post}`)
    console.log(`fetch-whisper-models: DONE — ${row.name} ready for the provers (${statSync(result.path).size} bytes)`)
  }
  if (!existsSync(CACHE_DIR)) fail(`${WHISPER_MODELS_VENDOR_PATH} was not created`)
}

void main()
