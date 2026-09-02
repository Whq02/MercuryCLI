// ============================================================================
//  scripts/mission-runner/corpus/manifest.ts — the generated corpus manifest.
// ----------------------------------------------------------------------------
//  ONE derivation from tasks.ts + the repo modules: schema version, task
//  rows, family/partition counts, per-repo DETERMINISTIC refs (captured by
//  actually seeding into a scratch root) and the corpus content digest that
//  every qualification result binds to.
//
//  CLI: bun scripts/mission-runner/corpus/manifest.ts [--write]   (writes the
//  committed scripts/mission-runner/fixtures/corpus-manifest.json)
// ============================================================================
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  CORPUS_PREREQUISITES,
  CORPUS_SCHEMA_VERSION,
  HELIX_FAMILIES,
  HELIX_PARTITIONS,
  type HelixFamilyId,
} from './contracts.js'
import { HELIX_TASKS } from './tasks.js'
import { INLINE_REPOS, seedAll } from './seed.js'

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
  }
  return JSON.stringify(value)
}

export function corpusDigest(): string {
  const material = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    repos: INLINE_REPOS.map(repo => ({
      id: repo.id,
      files: repo.files ?? {},
      branches: repo.branches ?? {},
    })),
    tasks: HELIX_TASKS,
  }
  return 'hc1-' + createHash('sha256').update(stableStringify(material)).digest('hex').slice(0, 24)
}

export function buildManifest(): Record<string, unknown> {
  const repoRoot = resolve(new URL('../../..', import.meta.url).pathname)
  const scratch = mkdtempSync(join(tmpdir(), 'helix-manifest-'))
  let seeded
  try {
    seeded = seedAll(scratch, repoRoot)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const familyCounts: Record<string, number> = {}
  const partitionCounts: Record<string, number> = {}
  for (const task of HELIX_TASKS) {
    const family = HELIX_FAMILIES[task.family as HelixFamilyId]
    familyCounts[family] = (familyCounts[family] ?? 0) + 1
    partitionCounts[task.partition] = (partitionCounts[task.partition] ?? 0) + 1
  }
  return {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    generatedFrom: 'scripts/mission-runner/corpus/tasks.ts',
    corpusDigest: corpusDigest(),
    prerequisites: CORPUS_PREREQUISITES,
    repos: Object.fromEntries(seeded.map(repo => [repo.id, repo.refs])),
    counts: {
      tasks: HELIX_TASKS.length,
      repos: seeded.length,
      families: Object.keys(familyCounts).length,
      byFamily: familyCounts,
      byPartition: partitionCounts,
    },
    partitions: Object.fromEntries(
      HELIX_PARTITIONS.map(partition => [
        partition,
        HELIX_TASKS.filter(t => t.partition === partition).map(t => t.id),
      ]),
    ),
    tasks: HELIX_TASKS.map(task => ({
      id: task.id,
      family: task.family,
      familyName: HELIX_FAMILIES[task.family as HelixFamilyId],
      title: task.title,
      repo: task.repo,
      ref: task.ref,
      partition: task.partition,
      timeCeilingSec: task.timeCeilingSec,
      humanEstimate: task.humanEstimate ?? null,
      sourceClass: task.sourceClass,
      variability: task.variability,
      runner: task.runner ?? null,
    })),
  }
}

export const MANIFEST_PATH = 'scripts/mission-runner/fixtures/corpus-manifest.json'

if (import.meta.main) {
  const manifest = buildManifest()
  const serialized = JSON.stringify(manifest, null, 2) + '\n'
  if (process.argv.includes('--write')) {
    const repoRoot = resolve(new URL('../../..', import.meta.url).pathname)
    writeFileSync(join(repoRoot, MANIFEST_PATH), serialized, 'utf8')
    console.log('wrote ' + MANIFEST_PATH + ' (' + manifest.corpusDigest + ')')
  } else {
    console.log(serialized)
  }
}
