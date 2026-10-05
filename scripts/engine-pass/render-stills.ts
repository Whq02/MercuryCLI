import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [family, out] = process.argv.slice(2)
assert.ok(family && out)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const files: Record<string, string> = {
  'face-doors': '../ui/face-door-stills.ts',
  'face-logins': '../ui/face-logins-stills.ts',
  'kit-menu': '../ui/kit-menu-stills.ts',
  'motion-menu': '../ui/motion-menu-stills.ts',
  'saturn-screen': '../ui/saturn-screen-stills.ts',
}
mkdirSync(out, { recursive: true })
const file = files[family]
assert.ok(file, `unknown still family ${family}`)
const writer = await import(file)
for (const still of [...writer.STILLS, ...(writer.MERGED_STILLS ?? [])]) {
  writeFileSync(join(out, `${still.id}.txt`), writer.renderStill(still.compose()))
}
console.log(`[PASS] ${family}: writer produced fresh frame bytes`)
