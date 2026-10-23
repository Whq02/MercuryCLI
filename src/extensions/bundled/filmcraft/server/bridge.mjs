import { runCraftBridge } from '../shared/bootstrap.mjs'
import { adapter } from './install.mjs'

await runCraftBridge(adapter).catch(error => {
  console.error(`FilmCraft: ${error.message}`)
  process.exitCode = 1
})
