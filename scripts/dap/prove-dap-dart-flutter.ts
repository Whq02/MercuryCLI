import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'dap-dart-flutter-'))
const savedPath = process.env.PATH
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAP_ADAPTERS
process.env.MERCURY_DAP_ADAPTERS_FILE = join(scratch, 'absent.json')
process.env.MERCURY_JS_DEBUG_DAP = join(scratch, 'absent.js')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, passed: boolean, detail = ''): void {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!passed) failures++
}

try {
  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  process.env.PATH = bin
  const { resolveAdapter, dormantBuiltinAdapterHints, adapterKeyForExtension } = await import('../../src/services/dap/dapClient.js')
  const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
  const permission = async (program: string): Promise<{ message?: string }> => {
    const result = await DebugTool.checkPermissions({ op: 'launch', program } as never, {} as never)
    return 'message' in result ? { message: result.message } : {}
  }
  const plain = join(scratch, 'plain', 'bin', 'main.dart')
  const flutter = join(scratch, 'flutter', 'lib', 'main.dart')
  mkdirSync(join(scratch, 'plain', 'bin'), { recursive: true })
  mkdirSync(join(scratch, 'flutter', 'lib'), { recursive: true })
  writeFileSync(join(scratch, 'plain', 'pubspec.yaml'), 'name: plain\nflutter:\n  uses-material-design: true\n')
  writeFileSync(join(scratch, 'flutter', 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n')
  check('missing Dart remains dormant', resolveAdapter('dart') === null)
  check('missing Flutter names its SDK', dormantBuiltinAdapterHints().some(row => row.key === 'flutter' && row.hint.includes('Flutter SDK')))
  check('missing Dart still infers Dart rather than native', (await permission(plain)).message?.includes('adapter dart') === true)
  check('Flutter dependency infers Flutter even before SDK installation', (await permission(flutter)).message?.includes('adapter flutter') === true)
  check('relative Dart programs use the logical working directory', (await runWithCwdOverride(join(scratch, 'flutter'), () => permission('lib/main.dart'))).message?.includes('adapter flutter') === true)
  for (const name of ['dart', 'flutter']) {
    const file = join(bin, process.platform === 'win32' ? `${name}.exe` : name)
    writeFileSync(file, '#!/bin/sh\nexit 0\n')
    chmodSync(file, 0o755)
  }
  check('Dart SDK invokes stdio debug_adapter', resolveAdapter('dart')?.args.join(' ') === 'debug_adapter')
  check('Flutter SDK invokes stdio debug-adapter', resolveAdapter('flutter')?.args.join(' ') === 'debug-adapter' && resolveAdapter('flutter')?.connect !== 'tcp')
  check('plain Dart does not route to Flutter', (await permission(plain)).message?.includes('adapter dart') === true)
  check('installed Flutter wins only for Flutter dependency', (await permission(flutter)).message?.includes('adapter flutter') === true)
  const nested = join(scratch, 'flutter', 'packages', 'plain', 'bin', 'main.dart')
  mkdirSync(join(scratch, 'flutter', 'packages', 'plain', 'bin'), { recursive: true })
  writeFileSync(join(scratch, 'flutter', 'packages', 'plain', 'pubspec.yaml'), 'name: nested\n')
  check('nearest pubspec bounds Flutter detection', (await permission(nested)).message?.includes('adapter dart') === true)
  writeFileSync(join(scratch, 'plain', 'pubspec.yaml'), 'name: [broken\n')
  check('invalid pubspec does not break inference', (await permission(plain)).message?.includes('adapter dart') === true)
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ custom: { command: 'custom', args: [], fileTypes: ['.dart'] } })
  check('explicit extension overrides outrank Flutter detection', (await permission(flutter)).message?.includes('adapter custom') === true)
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ flutter: { command: 'operator-flutter', args: ['dap'] } })
  check('environment overrides the Flutter row', resolveAdapter('flutter')?.command === 'operator-flutter')
  delete process.env.MERCURY_DAP_ADAPTERS
  check('Dart extension lookup remains available without project context', adapterKeyForExtension('.dart') === 'dart')
} finally {
  process.env.PATH = savedPath
  rmSync(scratch, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
