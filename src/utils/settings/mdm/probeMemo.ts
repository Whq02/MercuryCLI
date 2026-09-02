import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getMercuryHome } from '../../envUtils.js'
import type { RawReadResult } from './rawRead.js'

export interface MdmProbeMemoV1 {
  schema: 1
  present: boolean
  checkedAt: number
}

export function mdmProbeMemoPath(home: string = getMercuryHome()): string {
  return join(home, 'mdm-probe.json')
}

export function readMdmProbeMemo(home?: string): MdmProbeMemoV1 | null {
  try {
    const raw = JSON.parse(readFileSync(mdmProbeMemoPath(home), 'utf8')) as Partial<MdmProbeMemoV1> | null
    if (!raw || raw.schema !== 1 || typeof raw.present !== 'boolean' || typeof raw.checkedAt !== 'number') return null
    return { schema: 1, present: raw.present, checkedAt: raw.checkedAt }
  } catch {
    return null
  }
}

export function writeMdmProbeMemo(present: boolean, home?: string): void {
  try {
    const path = mdmProbeMemoPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ schema: 1, present, checkedAt: Date.now() } satisfies MdmProbeMemoV1)}\n`)
  } catch {
  }
}

export function recordMdmProbeOutcome(raw: RawReadResult, platform: string = process.platform, home?: string): void {
  if (platform !== 'win32') return
  writeMdmProbeMemo(raw.hklmStdout !== null || raw.hkcuStdout !== null, home)
}

export function mdmBootAwaitsRawRead(platform: string = process.platform, home?: string): boolean {
  if (platform !== 'win32') return true
  const memo = readMdmProbeMemo(home)
  return memo === null || memo.present !== false
}
