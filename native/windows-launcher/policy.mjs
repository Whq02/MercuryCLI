import { readFileSync } from 'node:fs'
import { parseEnginesNode, SPLASH_SKIP_FLAGS, SPLASH_SKIP_VERBS } from '../../scripts/release/launcherTemplates.mjs'

const p = parseEnginesNode(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).engines.node)
const literal = value => JSON.stringify(value)
process.stdout.write([
  `const NODE_MINIMUM: (u32, u32, u32) = (${p.major}, ${p.minorFloor}, ${p.patchFloor});`,
  `const NODE_RANGE: &str = ${literal(p.range)};`,
  `const SKIP_VERBS: &[&str] = &[${SPLASH_SKIP_VERBS.map(literal).join(',')}];`,
  `const SKIP_FLAGS: &[&str] = &[${SPLASH_SKIP_FLAGS.map(literal).join(',')}];`,
].join('\n') + '\n')
