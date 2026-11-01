import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256, type Acceptance, type Change, type Context } from './runtime.ts'
import { seed as seed1 } from './tasks/1/seed.ts'
import { accept as accept1 } from './tasks/1/accept.ts'
import { script as script1 } from './tasks/1/script.ts'

type Entry = { id: string; stratum: string; files: string[]; seed: (cwd: string) => void; evaluator: (ctx: Context) => Acceptance; script: (ctx: Context, changes: Change[]) => Promise<void> }
const entries: Entry[] = [
  { id: '1', stratum: 'parser', files: ['labels.mjs'], seed: seed1, evaluator: accept1, script: script1 },
]
export const pack = entries.map(entry => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'tasks', entry.id)
  const spec = join(dir, 'spec.md')
  const specBytes = readFileSync(spec)
  return {
    ...entry, spec, specHash: sha256(specBytes), seedPath: join(dir, 'seed.ts'),
    evaluatorVersion: sha256(Buffer.concat([specBytes, Buffer.from('\0'), readFileSync(join(dir, 'accept.ts'))])),
    controls: { reference: join(dir, 'reference.patch'), alternative: join(dir, 'alternative.patch'), wrong: [join(dir, 'wrong-1.patch'), join(dir, 'wrong-2.patch')] },
    expected: { reference: 'accept' as const, alternative: 'accept' as const, wrong: 'refuse' as const, staleAfterChange: true },
  }
})
