import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

type ShippedBlock = { context: string; bindings: Record<string, string | null> }
export type ShippedForm = { form: string; blocks: ShippedBlock[] }

const TABLE = join(import.meta.dir, '..', '..', 'src', 'keybindings', 'defaultBindings.ts')

const PLATFORMS: Array<[label: string, platform: string, bun: string | null]> = [
  ['darwin', 'darwin', null],
  ['linux', 'linux', null],
  ['windows with VT', 'win32', '1.2.23'],
  ['windows without VT', 'win32', '1.2.22'],
]

const SWITCHES: Array<[label: string, value: string | undefined]> = [
  ['no switch set', undefined],
  ['every switch 1', '1'],
  ['every switch 0', '0'],
  ['every switch true', 'true'],
  ['every switch false', 'false'],
]

async function readForms(table: string): Promise<ShippedForm[]> {
  const versions = process.versions
  const forms: ShippedForm[] = []
  for (const [platformLabel, platform, bun] of PLATFORMS) {
    for (const [switchLabel, value] of SWITCHES) {
      const env = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? value : undefined), has: () => value !== undefined })
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      Object.defineProperty(process, 'versions', { value: bun === null ? versions : { ...versions, bun }, configurable: true })
      Object.defineProperty(process, 'env', { value: env, configurable: true })
      const loaded = (await import(`${table}?form=${forms.length}`)) as { DEFAULT_BINDINGS: ShippedBlock[] }
      forms.push({ form: `${platformLabel}, ${switchLabel}`, blocks: JSON.parse(JSON.stringify(loaded.DEFAULT_BINDINGS)) })
    }
  }
  return forms
}

if (import.meta.main) {
  process.stdout.write(JSON.stringify(await readForms(process.argv[2] ?? TABLE)))
  process.exit(0)
}

export function shippedKeyForms(table = TABLE): ShippedForm[] {
  const run = spawnSync(process.execPath, [import.meta.path, table], { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  if (run.status !== 0) throw new Error(`the shipped key forms did not load (rc ${run.status}): ${run.stderr}`)
  return JSON.parse(run.stdout) as ShippedForm[]
}

export const formsMissing = (forms: ShippedForm[], context: string, chord: string, action: string): string[] =>
  forms.filter(form => form.blocks.find(block => block.context === context)?.bindings[chord] !== action).map(form => form.form)

export const rowsBinding = (forms: ShippedForm[], test: (action: string, chord: string, context: string) => boolean): string[] =>
  forms.flatMap(form =>
    form.blocks.flatMap(block =>
      Object.entries(block.bindings)
        .filter(([chord, action]) => typeof action === 'string' && test(action, chord, block.context))
        .map(([chord, action]) => `${form.form}: ${block.context} ${chord} → ${action}`),
    ),
  )
