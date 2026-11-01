import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256, type Acceptance, type Change, type Context } from './runtime.ts'
import { seed as seed1 } from './tasks/1/seed.ts'
import { accept as accept1 } from './tasks/1/accept.ts'
import { script as script1 } from './tasks/1/script.ts'
import { seed as seed2 } from './tasks/2/seed.ts'
import { accept as accept2 } from './tasks/2/accept.ts'
import { script as script2 } from './tasks/2/script.ts'
import { seed as seed3 } from './tasks/3/seed.ts'
import { accept as accept3 } from './tasks/3/accept.ts'
import { script as script3 } from './tasks/3/script.ts'
import { seed as seed4 } from './tasks/4/seed.ts'
import { accept as accept4 } from './tasks/4/accept.ts'
import { script as script4 } from './tasks/4/script.ts'
import { seed as seed5 } from './tasks/5/seed.ts'
import { accept as accept5 } from './tasks/5/accept.ts'
import { script as script5 } from './tasks/5/script.ts'
import { seed as seed6 } from './tasks/6/seed.ts'
import { accept as accept6 } from './tasks/6/accept.ts'
import { script as script6 } from './tasks/6/script.ts'

type Entry = { id: string; stratum: string; files: string[]; seed: (cwd: string) => void; evaluator: (ctx: Context) => Acceptance; script: (ctx: Context, changes: Change[]) => Promise<void> }
const entries: Entry[] = [
  { id: '1', stratum: 'parser', files: ['labels.mjs'], seed: seed1, evaluator: accept1, script: script1 },
  { id: '2', stratum: 'CLI', files: ['greet.mjs'], seed: seed2, evaluator: accept2, script: script2 },
  { id: '3', stratum: 'multi-file edit', files: ['config.mjs', 'view.mjs'], seed: seed3, evaluator: accept3, script: script3 },
  { id: '4', stratum: 'check/tree binding', files: ['score.mjs'], seed: seed4, evaluator: accept4, script: script4 },
  { id: '5', stratum: 'authority', files: ['receipt.mjs'], seed: seed5, evaluator: accept5, script: script5 },
  { id: '6', stratum: 'persistence/replay', files: ['result.mjs'], seed: seed6, evaluator: accept6, script: script6 },
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
