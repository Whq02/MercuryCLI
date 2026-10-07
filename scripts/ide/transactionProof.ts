import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'transaction-proof-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_BARE = '1'
process.env.MERCURY_IDE_LOOP = '1'
process.env.MERCURY_TX_AUTOCAPTURE = '1'
process.env.MERCURY_CHANGE_RECEIPTS = '1'
process.env.MERCURY_VERIFY_EVIDENCE = '1'

export const tx = await import('../../src/services/ide/ideTransaction.js')
export const capture = await import('../../src/services/ide/txAutoCapture.js')
export const { TransactionTool } = await import('../../src/tools/TransactionTool/TransactionTool.js')
export const { observeToolTerminal } = await import('../../src/services/run/effectObserver.js')
export const ledger = await import('../../src/utils/verification/verificationState.js')
export const { receiptsFor } = await import('../../src/services/changeTransaction/receipts.js')
export const { projectHomeStore } = await import('../../src/utils/projectHomeStores.js')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

let sequence = 0
let failures = 0
export function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail ? ` — ${detail}` : ''}`)
}
export function fixture(files = ['one.txt'], verifiable = false) {
  const root = mkdtempSync(join(scratch, 'project-'))
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "transaction-proof"\n')
  for (const file of files) {
    const target = join(root, file)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, 'before\n')
  }
  if (verifiable) writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"bun test"}}')
  const owner = makeOwnerKey({ workspace: root, sessionId: `tx-${++sequence}`, lane: 'main' })
  return { root, owner, files: files.map(file => join(root, file)) }
}
export type Fixture = ReturnType<typeof fixture>
export function emit(f: Fixture, operation = 'file.edit', opts: {
  paths?: string[]; outcome?: 'succeeded' | 'no-change' | 'failed' | 'indeterminate';
  toolUseId?: string; ok?: boolean; toolName?: string; input?: unknown; cwd?: string
} = {}) {
  const id = opts.toolUseId ?? `event-${++sequence}`
  observeToolTerminal({
    owner: f.owner, cwd: opts.cwd ?? f.root, toolName: opts.toolName ?? 'Edit', toolUseId: id,
    input: opts.input ?? { file_path: f.files[0] }, ok: opts.ok ?? true, durationMs: 1,
    effect: { operation, outcome: opts.outcome ?? 'succeeded', changedPaths: opts.paths ?? f.files,
      evidence: 'fixture evidence', startedAt: Date.now() - 1, completedAt: Date.now() },
  })
  return id
}
export function evidence(f: Fixture, ok = true, scope: Parameters<typeof ledger.recordEvidence>[1]['scope'] = 'test') {
  ledger.recordEvidence(f.root, { command: 'bun test', ok, scope, coverage: 'tests' }, f.owner)
}
export async function call(f: Fixture, input: Record<string, unknown>) {
  return runWithCwdOverride(f.root, async () => {
    const context = { owner: f.owner, abortController: new AbortController(), readFileState: new Map(),
      getAppState: () => ({ tasks: {} }), setAppState: () => {}, options: { tools: [], isNonInteractiveSession: true } }
    return TransactionTool.call(input as never, context as never)
  })
}
export async function status(f: Fixture): Promise<string> {
  await capture._drainTxAutoCaptureForTesting()
  return (await call(f, { op: 'status' })).data.result
}
export async function finish(f: Fixture, verdict = 'completed', unresolved?: string[]) {
  return call(f, { op: 'finish', verdict, ...(unresolved ? { unresolved } : {}) })
}
export function done(name: string): never {
  rmSync(scratch, { recursive: true, force: true })
  console.log(`${name}: ${failures ? `${failures} RED` : 'GREEN'}`)
  process.exit(failures ? 1 : 0)
}
