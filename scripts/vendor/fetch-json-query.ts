import { resolve } from 'node:path'
import { checkJsonQuery, fetchJsonQuery } from './jsonQuery.ts'

const root = resolve(import.meta.dir, '../..')
if (process.argv.includes('--check')) checkJsonQuery(root)
else {
  const archives: Record<string, string> = {}
  for (const key of ['npm', 'jq']) {
    const value = process.argv.find(arg => arg.startsWith(`--${key}-archive=`))?.slice(key.length + 11)
    if (value) archives[key] = value
  }
  await fetchJsonQuery(root, archives)
}
console.log('JSON query vendor cache matches its lock')
