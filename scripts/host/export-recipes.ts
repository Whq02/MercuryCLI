import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { HOST_RECIPES } from '../../src/services/host/recipes.ts'
import { SHIPPED_HOST_RECIPES_PATH, exportHostRecipesJson } from '../../src/services/host/recipesFile.ts'

const root = resolve(import.meta.dir, '../..')
const outIndex = process.argv.indexOf('--out')
const targetPath = outIndex >= 0 && process.argv[outIndex + 1] ? resolve(process.argv[outIndex + 1]!) : resolve(root, SHIPPED_HOST_RECIPES_PATH)
const json = exportHostRecipesJson(HOST_RECIPES)

if (process.argv.includes('--stdout')) {
  process.stdout.write(json)
} else if (process.argv.includes('--check')) {
  const current = readFileSync(targetPath, 'utf8')
  if (current !== json) {
    console.error(`Recipes file drifted from HOST_RECIPES: ${targetPath}`)
    process.exit(1)
  }
} else {
  writeFileSync(targetPath, json)
}
