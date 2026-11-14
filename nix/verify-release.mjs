import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function verifyRelease(payload, version, target) {
  const { verifyPayloadDir } = await import(pathToFileURL(join(payload, 'verify-artifact.mjs')).href)
  const checked = verifyPayloadDir(payload, { depth: 'deep' })
  if (checked.verdict.state !== 'signed') throw new Error(`release is ${checked.verdict.state}, not signed`)
  const statement = checked.verdict.statement
  if (statement.version !== version || statement.target !== target) throw new Error(`signed identity is ${statement.version} ${statement.target}, expected ${version} ${target}`)
  const manifest = JSON.parse(readFileSync(join(payload, 'manifest.json'), 'utf8'))
  if (manifest.version !== version || manifest.target?.release !== target) throw new Error('the manifest and signed release identity disagree')
  const layout = manifest.releaseLayout
  if (layout?.schema !== 1 || !Array.isArray(layout.members) || layout.members.length === 0) throw new Error('the release has no complete member record')
  for (const member of layout.members) {
    if (typeof member.path !== 'string' || member.path.includes('/') || member.path === '..' || !existsSync(join(payload, member.path))) throw new Error('a declared release member is missing or malformed')
  }
  for (const name of ['mercury.mjs', 'mercury', 'verify-artifact.mjs', 'vendor', 'LICENSE.md', 'NOTICE', 'NOTICES.md']) {
    if (!existsSync(join(payload, name))) throw new Error(`release member ${name} is missing`)
  }
  if (!existsSync(join(payload, 'vendor/node/bin/node'))) throw new Error('the bundled Node runtime is missing')
  const grammars = readdirSync(join(payload, 'vendor/treesitter')).filter(name => name.startsWith('tree-sitter-') && name.endsWith('.wasm'))
  if (grammars.length === 0) throw new Error('the bundled structural grammars are missing')
  return { version, target, keyId: checked.verdict.keyId, grammars: grammars.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [payload, version, target] = process.argv.slice(2)
    if (!payload || !version || !target) throw new Error('usage: verify-release.mjs <payload> <version> <target>')
    const checked = await verifyRelease(resolve(payload), version, target)
    console.log(`Mercury ${checked.version} ${checked.target}: signed payload intact; ${checked.grammars} bundled grammars`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
