import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { createElement } from 'react'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const cwdModule = await import('../../src/utils/cwd.js')
let cwd = homedir()
mock.module('../../src/utils/cwd.js', () => ({ ...cwdModule, getCwd: () => cwd }))
const { MercuryTrust } = await import('../../src/components/MercuryTrust.js')
const { renderToString } = await import('../../src/utils/staticRender.js')
const { toTildePath } = await import('../../src/utils/path.js')
for (const [path, expected] of [
  [homedir(), '~'],
  [join(homedir(), 'project'), toTildePath(join(homedir(), 'project'))],
  [join(`${homedir()}-other`, 'project'), join(`${homedir()}-other`, 'project')],
] as const) {
  cwd = path
  const frame = await renderToString(createElement(MercuryTrust))
  assert(frame.split('\n').some(line => line.trim().includes(expected)), `path label must name ${expected}: ${frame}`)
}
console.log('PASS trust path: home, home descendant, sibling with same prefix')
process.exit(0)
