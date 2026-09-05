


import { projectConfigCandidates } from '../../utils/projectConfig.js'
import { projectHomeStore } from '../../utils/projectHomeStores.js'
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { themisActive } from './level.js'
import { logForDebugging } from '../../utils/debug.js'
import { durableAtomicPublish } from '../durablePublish.js'

export interface ThemisAuditRow {
  ts: string
  seq: number
  actor: string
  action: string
  cwd: string
  details?: string
  prev: string
  hash: string
}

const CAP = { actor: 60, action: 60, cwd: 300, details: 500 } as const
const clamp = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export const GENESIS = 'genesis'

export function canonicalRowBody(row: Omit<ThemisAuditRow, 'hash'>): string {
  return JSON.stringify([row.ts, row.seq, row.actor, row.action, row.cwd, row.details ?? '', row.prev])
}

export function hashRowBody(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

export function themisDir(cwd: string = process.cwd()): string {
  return projectHomeStore(cwd, 'themis')
}

export function themisDirs(cwd: string = process.cwd()): string[] {
  const home = themisDir(cwd)
  const existing = projectConfigCandidates(cwd, 'themis').filter(dir => dir !== home)
  return [home, ...existing]
}

interface ChainState {
  file: string
  headFile: string
  seq: number
  prev: string
  queue: Promise<void>
  dirEnsured: boolean
}
let chain: ChainState | null = null
let bootEpoch = 0

function bootChainState(): ChainState {
  if (chain) return chain
  const boot = `${Date.now().toString(36)}-${(++bootEpoch).toString(36)}`
  const dir = themisDir()
  const file = join(dir, `audit-${process.pid}-${boot}.jsonl`)
  chain = {
    file,
    headFile: `${file}.head`,
    seq: 0,
    prev: GENESIS,
    queue: Promise.resolve(),
    dirEnsured: false,
  }
  return chain
}

export function resetAuditChainForTests(): void {
  chain = null
}

export function appendAuditRow(input: {
  actor: string
  action: string
  details?: string
  cwd?: string
}): Promise<void> {
  if (!themisActive()) return Promise.resolve()
  const st = bootChainState()
  const run = async (): Promise<void> => {
    try {
      if (!st.dirEnsured) {
        await mkdir(dirname(st.file), { recursive: true })
        st.dirEnsured = true
      }
      const body: Omit<ThemisAuditRow, 'hash'> = {
        ts: new Date().toISOString(),
        seq: st.seq + 1,
        actor: clamp(String(input.actor || 'main'), CAP.actor),
        action: clamp(String(input.action || 'event'), CAP.action),
        cwd: clamp(String(input.cwd ?? process.cwd()), CAP.cwd),
        details: input.details ? clamp(String(input.details), CAP.details) : undefined,
        prev: st.prev,
      }
      const hash = hashRowBody(canonicalRowBody(body))
      const row: ThemisAuditRow = { ...body, hash }
      await appendFile(st.file, JSON.stringify(row) + '\n', { encoding: 'utf8' })
      st.seq = body.seq
      st.prev = hash
      await durableAtomicPublish(st.headFile, JSON.stringify({ seq: st.seq, hash: st.prev }))
    } catch (e) {
      logForDebugging(`themis audit append failed: ${String(e)}`)
      const code = (e as NodeJS.ErrnoException | null)?.code
      if ((code === 'ENOENT' || code === 'ENOTDIR') && chain === st) {
        chain = null
        logForDebugging('themis audit chain re-booted: parent dir vanished; next row starts a fresh chain')
      }
    }
  }
  st.queue = st.queue.then(run, run)
  return st.queue
}

export type ChainVerdict =
  | { ok: true; rows: number; note?: 'head-behind' | 'no-head' }
  | {
      ok: false
      rows: number
      tamperedAt: number
      kind: 'edited' | 'broken' | 'truncated' | 'head-mismatch' | 'malformed'
      detail: string
    }

export async function verifyAuditChainFile(file: string): Promise<ChainVerdict> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { ok: false, rows: 0, tamperedAt: 0, kind: 'malformed', detail: 'unreadable file' }
  }
  const lines = raw.split('\n').filter(l => l.trim().length > 0)
  let prev = GENESIS
  let lastSeq = 0
  let lastHash = GENESIS
  for (let i = 0; i < lines.length; i++) {
    let row: ThemisAuditRow
    try {
      row = JSON.parse(lines[i]!) as ThemisAuditRow
    } catch {
      return { ok: false, rows: lines.length, tamperedAt: i + 1, kind: 'malformed', detail: 'unparseable row' }
    }
    const body: Omit<ThemisAuditRow, 'hash'> = {
      ts: row.ts, seq: row.seq, actor: row.actor, action: row.action,
      cwd: row.cwd, details: row.details, prev: row.prev,
    }
    const expect = hashRowBody(canonicalRowBody(body))
    if (expect !== row.hash) {
      return { ok: false, rows: lines.length, tamperedAt: i + 1, kind: 'edited', detail: `row ${i + 1} hash mismatch` }
    }
    if (row.prev !== prev) {
      return { ok: false, rows: lines.length, tamperedAt: i + 1, kind: 'broken', detail: `row ${i + 1} prev-link broken (deletion/reorder upstream)` }
    }
    if (row.seq !== lastSeq + 1) {
      return { ok: false, rows: lines.length, tamperedAt: i + 1, kind: 'broken', detail: `row ${i + 1} seq gap (${lastSeq} → ${row.seq})` }
    }
    prev = row.hash
    lastSeq = row.seq
    lastHash = row.hash
  }
  let head: { seq: number; hash: string } | null = null
  try {
    head = JSON.parse(await readFile(`${file}.head`, 'utf8')) as { seq: number; hash: string }
  } catch {
    head = null
  }
  if (!head) {
    return { ok: true, rows: lines.length, note: 'no-head' }
  }
  if (head.seq > lastSeq) {
    return { ok: false, rows: lines.length, tamperedAt: lines.length + 1, kind: 'truncated', detail: `head records seq ${head.seq}, file ends at ${lastSeq} — tail removed` }
  }
  if (head.seq === lastSeq && head.hash !== lastHash) {
    return { ok: false, rows: lines.length, tamperedAt: lines.length, kind: 'head-mismatch', detail: 'head hash differs at equal seq — tail swapped' }
  }
  if (head.seq < lastSeq) {
    return { ok: true, rows: lines.length, note: 'head-behind' }
  }
  return { ok: true, rows: lines.length }
}

export async function verifyAllChains(
  dir?: string,
): Promise<{ ok: boolean; chains: Array<{ file: string; verdict: ChainVerdict }> }> {
  const dirs = dir !== undefined ? [dir] : themisDirs()
  const merged: { ok: boolean; chains: Array<{ file: string; verdict: ChainVerdict }> } = { ok: true, chains: [] }
  for (const d of dirs) {
    const one = await verifyChainsInDir(d)
    merged.ok = merged.ok && one.ok
    merged.chains.push(...one.chains)
  }
  return merged
}

async function verifyChainsInDir(
  dir: string,
): Promise<{ ok: boolean; chains: Array<{ file: string; verdict: ChainVerdict }> }> {
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter(n => /^audit-.*\.jsonl$/.test(n))
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { ok: true, chains: [] }
    }
    return {
      ok: false,
      chains: [{
        file: dir,
        verdict: { ok: false, rows: 0, tamperedAt: 0, kind: 'malformed', detail: `themis dir unreadable: ${String((e as NodeJS.ErrnoException | null)?.code ?? e)}` },
      }],
    }
  }
  const chains: Array<{ file: string; verdict: ChainVerdict }> = []
  for (const n of names.sort()) {
    const file = join(dir, n)
    chains.push({ file, verdict: await verifyAuditChainFile(file) })
  }
  return { ok: chains.every(c => c.verdict.ok), chains }
}
