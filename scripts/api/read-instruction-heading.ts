#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'

export const USER_CONTEXT_OPEN = '<system-reminder>\nThe material below is available to you while you answer the user.'
export const CLASSIFIER_PREFIX_LINE = "The following is the user's project configuration"

export interface HeadingReport {
  seq: number | undefined
  url: string
  model: string
  headings: string[]
  classifierTag: string | undefined
}

export function harvestStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.length >= 8) out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) harvestStrings(item, out)
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) harvestStrings(item, out)
  }
  return out
}

export function userContextHeadings(text: string): string[] {
  const start = text.indexOf(USER_CONTEXT_OPEN)
  if (start === -1) return []
  const end = text.indexOf('</system-reminder>', start)
  const block = text.slice(start, end === -1 ? undefined : end)
  const headings: string[] = []
  for (const line of block.split('\n')) {
    const match = /^# (\S+)$/.exec(line)
    if (match) headings.push(match[1]!)
  }
  return headings
}

export function classifierTagOf(text: string): string | undefined {
  const at = text.indexOf(CLASSIFIER_PREFIX_LINE)
  if (at === -1) return undefined
  const match = /\n<([A-Za-z_][\w-]*)>\n/.exec(text.slice(at))
  return match ? match[1] : undefined
}

export function reportRow(row: { seq?: number; url?: string; model?: string; body?: unknown }): HeadingReport {
  const texts = harvestStrings(row.body)
  const headings = new Set<string>()
  let classifierTag: string | undefined
  for (const text of texts) {
    for (const heading of userContextHeadings(text)) headings.add(heading)
    classifierTag ??= classifierTagOf(text)
  }
  return { seq: row.seq, url: row.url ?? '', model: row.model ?? '', headings: [...headings], classifierTag }
}

export function readRows(file: string): Array<{ seq?: number; url?: string; model?: string; body?: unknown }> {
  const rows: Array<{ seq?: number; url?: string; model?: string; body?: unknown }> = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as { kind?: string; body?: unknown }
      if (row && typeof row === 'object' && row.body !== undefined) rows.push(row)
    } catch {
      continue
    }
  }
  return rows
}

function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--expect-heading' && argv[i - 1] !== '--expect-tag')
  const expectHeading = arg(argv, '--expect-heading')
  const expectTag = arg(argv, '--expect-tag')
  if (files.length === 0) {
    console.log('usage: read-instruction-heading.ts <capture.jsonl>... [--expect-heading instructions] [--expect-tag project_instructions]')
    process.exit(2)
  }
  let headingSeen = false
  let tagSeen = false
  for (const file of files) {
    if (!existsSync(file)) {
      console.log(`no such capture: ${file}`)
      continue
    }
    console.log(`${file}`)
    for (const row of readRows(file)) {
      const report = reportRow(row)
      if (expectHeading !== undefined && report.headings.includes(expectHeading)) headingSeen = true
      if (expectTag !== undefined && report.classifierTag === expectTag) tagSeen = true
      const headings = report.headings.length > 0 ? report.headings.join(', ') : '-'
      console.log(`  #${report.seq ?? '?'} ${report.url} model=${report.model || '?'} headings=[${headings}] classifier_tag=${report.classifierTag ?? '-'}`)
    }
  }
  let failed = false
  if (expectHeading !== undefined) {
    console.log(`${headingSeen ? 'OK  ' : 'FAIL'} a request carries the user-context heading '# ${expectHeading}'`)
    failed ||= !headingSeen
  }
  if (expectTag !== undefined) {
    console.log(`${tagSeen ? 'OK  ' : 'FAIL'} a classifier request wraps the instructions in <${expectTag}>`)
    failed ||= !tagSeen
  }
  process.exit(failed ? 1 : 0)
}
