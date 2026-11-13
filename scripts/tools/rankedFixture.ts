import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const UPLOAD_QUEUE = [
  "import { computeDelay } from './backoff'",
  "import { send } from './httpClient'",
  '',
  'export type QueuedFile = { name: string; bytes: Uint8Array; attempts: number }',
  '',
  'const MAX_ATTEMPTS = 5',
  '',
  'export class UploadQueue {',
  '  private readonly pending: QueuedFile[] = []',
  '',
  '  enqueue(name: string, bytes: Uint8Array): void {',
  '    this.pending.push({ name, bytes, attempts: 0 })',
  '  }',
  '',
  '  size(): number {',
  '    return this.pending.length',
  '  }',
  '',
  '  async drain(): Promise<string[]> {',
  '    const done: string[] = []',
  '    while (this.pending.length > 0) {',
  '      const next = this.pending.shift()!',
  '      done.push(await this.sendOrWait(next))',
  '    }',
  '    return done',
  '  }',
  '',
  '  private async sendOrWait(file: QueuedFile): Promise<string> {',
  '    for (;;) {',
  '      try {',
  "        return await send('/upload', file.name, file.bytes)",
  '      } catch (error) {',
  '        file.attempts++',
  '        if (file.attempts >= MAX_ATTEMPTS) {',
  '          throw new Error(`upload of ${file.name} failed after ${file.attempts} attempts`, { cause: error })',
  '        }',
  '        const retryIn = computeDelay(file.attempts)',
  '        await new Promise(resolve => setTimeout(resolve, retryIn))',
  '      }',
  '    }',
  '  }',
  '}',
]

const RETRY_POLICY = [
  'export type Job = { id: string; retries: number; lastError?: string }',
  '',
  'const MAX_RETRIES = 3',
  '',
  'export function shouldRetry(job: Job): boolean {',
  '  return job.retries < MAX_RETRIES',
  '}',
  '',
  'export function noteRetry(job: Job, reason: string): Job {',
  '  return { ...job, retries: job.retries + 1, lastError: reason }',
  '}',
  '',
  'export function retryLabel(job: Job): string {',
  '  return `retry ${job.retries} of ${MAX_RETRIES}`',
  '}',
]

const UPLOAD_BUTTON = [
  "import * as React from 'react'",
  '',
  'export function UploadButton(props: { onUpload: () => void; busy: boolean }): React.ReactNode {',
  "  const label = props.busy ? 'Uploading' : 'Upload a file'",
  '  return <button onClick={props.onUpload} disabled={props.busy}>{label}</button>',
  '}',
]

const TOAST = [
  'export function failureToast(what: string): string {',
  '  return `${what} failed`',
  '}',
  '',
  'export function savedToast(what: string): string {',
  '  return `${what} saved`',
  '}',
]

const QUEUE_TEST = [
  "import { UploadQueue } from '../src/net/uploadQueue'",
  '',
  "test('a failed upload is retried', async () => {",
  '  const queue = new UploadQueue()',
  "  queue.enqueue('a.txt', new Uint8Array(1))",
  '  expect(await queue.drain()).toHaveLength(1)',
  '})',
  '',
  "test('the queue reports its size', () => {",
  '  expect(new UploadQueue().size()).toBe(0)',
  '})',
]

const SYSTEM = [
  'export type SystemState = { system: string; systemLoad: number }',
  '',
  'export function describeSystem(state: SystemState): string {',
  '  return `system ${state.system} at load ${state.systemLoad}`',
  '}',
  '',
  'export const SYSTEM_DEFAULT: SystemState = { system: "idle", systemLoad: 0 }',
]

const STEMMER = [
  'export function stemWord(word: string): string {',
  "  if (word.endsWith('ing')) return word.slice(0, -3)",
  "  if (word.endsWith('s')) return word.slice(0, -1)",
  '  return word',
  '}',
  '',
  'export function stemAll(words: string[]): string[] {',
  '  return words.map(stemWord)',
  '}',
]

function changelog(): string[] {
  const lines = ['# Changelog', '', '## 2.4.0', '', '- Uploads that fail are retried up to five times.']
  for (let entry = 0; entry < 40; entry++) lines.push(`- Entry ${entry}: the settings page keeps its scroll position.`)
  return lines
}

function everything(): string[] {
  const lines: string[] = []
  for (let line = 1; line <= 300; line++) {
    if (line >= 10 && line < 16) lines.push(`export const retryBudget${line} = ${line}`)
    else if (line >= 150 && line < 156) lines.push(`export const uploadLimit${line} = ${line}`)
    else if (line >= 290 && line < 296) lines.push(`export const failureCode${line} = ${line}`)
    else lines.push(`export const legacyValue${line} = ${line}`)
  }
  return lines
}

function filler(index: number): string[] {
  const name = String(index).padStart(2, '0')
  return [
    `export function total${name}(values: number[]): number {`,
    '  let sum = 0',
    '  for (const value of values) sum += value',
    index % 5 === 0 ? "  if (Number.isNaN(sum)) throw new Error('the sum failed')" : '  if (Number.isNaN(sum)) return 0',
    '  return sum',
    '}',
  ]
}

export const RANKED_FIXTURE_DESCRIPTION = 'where do we retry a failed upload'

export function writeRankedFixture(root: string): { implementation: string; signature: number; failure: number; files: number } {
  const tree: Record<string, string[]> = {
    'src/net/uploadQueue.ts': UPLOAD_QUEUE,
    'src/net/backoff.ts': ['export function computeDelay(attempt: number): number {', '  return Math.min(30_000, 250 * 2 ** attempt)', '}'],
    'src/net/httpClient.ts': ['export async function send(route: string, name: string, bytes: Uint8Array): Promise<string> {', '  return `${route}/${name}:${bytes.length}`', '}'],
    'src/jobs/retryPolicy.ts': RETRY_POLICY,
    'src/ui/UploadButton.tsx': UPLOAD_BUTTON,
    'src/ui/Toast.tsx': TOAST,
    'src/store/system.ts': SYSTEM,
    'src/text/stemmer.ts': STEMMER,
    'src/legacy/everything.ts': everything(),
    'test/uploadQueue.test.ts': QUEUE_TEST,
    'docs/CHANGELOG.md': changelog(),
    'dist/bundle.min.js': ['retry upload failed;'.repeat(200)],
    'ignored/generated.ts': ['export const retryUploadFailed = "retry a failed upload"', 'export const again = "retry upload failed"'],
    '.gitignore': ['ignored/'],
    '.git/HEAD': ['retry upload failed'],
  }
  for (let index = 0; index < 30; index++) tree[`src/misc/module${String(index).padStart(2, '0')}.ts`] = filler(index)
  for (const [path, lines] of Object.entries(tree)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${lines.join('\n')}\n`)
  }
  return {
    implementation: join(root, 'src/net/uploadQueue.ts'),
    signature: UPLOAD_QUEUE.findIndex(line => line.includes('private async sendOrWait')) + 1,
    failure: UPLOAD_QUEUE.findIndex(line => line.includes('failed after')) + 1,
    files: Object.keys(tree).length,
  }
}
