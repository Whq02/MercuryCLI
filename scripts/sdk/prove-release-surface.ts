import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const index = process.argv.indexOf('--package-root')
const root = index < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[index + 1]!)
const sdk = await import(join(root, 'sdk/src/index.ts'))
const pkg = JSON.parse(readFileSync(join(root, 'sdk/package.json'), 'utf8'))
const checks: Array<[string, boolean]> = [
  ['publishable mercury-cli-sdk 0.2.0 under Apache-2.0', pkg.name === 'mercury-cli-sdk' && pkg.version === '0.2.0' && sdk.VERSION === pkg.version && pkg.license === 'Apache-2.0' && pkg.private !== true],
  ['Python distribution, import and both README versions match', readFileSync(join(root, 'sdk-py/pyproject.toml'), 'utf8').includes(`version = "${pkg.version}"`) && readFileSync(join(root, 'sdk-py/src/mercury_cli_sdk/version.py'), 'utf8').includes(`__version__ = '${pkg.version}'`) && ['sdk', 'sdk-py'].every(dir => readFileSync(join(root, dir, 'README.md'), 'utf8').includes('`mercury-cli-sdk` ' + pkg.version))],
  ['public run, runner and inline helper exports', ['run', 'connect', 'defineTool', 'serveTools', 'defineAgent'].every(k => typeof sdk[k] === 'function')],
  ['streaming input methods on run', ['sendPrompt', 'sendShell', 'sendNote', 'closeInput'].every(k => typeof sdk.MercuryRun.prototype[k] === 'function')],
  ['unknown rows are delivered', sdk.rowOf({ type: 'future_row' }).ok === true && sdk.rowOf({ type: 'future_row' }).row?.type === 'unknown_row'],
  ['generated Python typed package and testing module', ['sdk-py/pyproject.toml', 'sdk-py/src/mercury_cli_sdk/generated.py', 'sdk-py/src/mercury_cli_sdk/testing.py', 'sdk-py/src/mercury_cli_sdk/py.typed'].every(p => existsSync(join(root, p)))],
  ['TypeScript testing subpath', Boolean(pkg.exports?.['./testing']?.types)],
]
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
if (checks.some(([, ok]) => !ok)) process.exit(1)
