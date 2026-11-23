import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as path from 'node:path'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { getMercuryHome } from '../../../platform/environment/envUtils.js'
import { subprocessEnv } from '../../../platform/processes/subprocessEnv.js'
import { projectPythonDebugAdapter } from '../../ide/pythonProject.js'
import { mercuryUnityEnabled } from '../../unity-protocol/unityProject.js'
import {
  findGodotProjectRoot,
  godotBridgeCommand,
  godotDapPort,
  godotEditorHint,
  mercuryGodotEnabled,
  GODOT_DAP_ADAPTER_KEY,
} from '../../lsp/godotLane.js'
import { jsDebugSourceLabel, resolveJsDebugServer } from '../jsDebugResolver.js'
import { installedOptionalAdapter, optionalAdapterPlan } from '../optionalAdapters.js'
import { buildUnityAttachArgs, resolveUnityDebugAdapter, unityEditorHint, UNITY_DAP_ADAPTER_KEY } from '../unityAdapter.js'
import {
  ELIXIR_DEBUG_ADAPTER_BINARIES,
  ELIXIR_DEBUG_ADAPTER_HINT,
  findOnPathLocal,
  GDB_DAP_MIN_MAJOR,
  gdbProbeFromMemo,
  KOTLIN_DEBUG_ADAPTER_HINT,
  lldbDapInstallHint,
  netcoredbgInstallHint,
  probeGdbDap,
  resolveLldbDap,
} from './probes.js'
import type { DapAdapterSpec, DapLaunchOptions } from './shared.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

function godotLaunchArgs(options: DapLaunchOptions): Record<string, unknown> {
  const programDir = options.program.endsWith('project.godot')
    ? path.dirname(options.program)
    : options.program
  const project =
    findGodotProjectRoot(programDir) ?? findGodotProjectRoot(options.cwd) ?? programDir
  const scene = options.args?.[0] ?? 'main'
  const playArgs = options.args?.slice(1) ?? []
  return {
    project,
    scene,
    noDebug: false,
    ...(playArgs.length ? { playArgs } : {}),
  }
}

function pythonAdapterSpec(): DapAdapterSpec {
  const python = projectPythonDebugAdapter()
  return python.state === 'ok'
    ? {
        command: python.command,
        args: python.args,
        ...(python.debuggee !== python.command ? { launchDefaults: { python: [python.debuggee] } } : {}),
        installHint:
          python.provenance.adapterSource === 'bundled'
            ? `bundled debugpy ${python.provenance.debugpyVersion ?? ''} via ${python.provenance.interpreter ?? 'python3'}`.trim()
            : 'pip install debugpy',
      }
    : {
        command: 'python3',
        args: ['-m', 'debugpy.adapter'],
        installHint: python.remedy,
        preflightError: python.reason,
      }
}

export function codelldbInstallHint(): string {
  return 'put codelldb on PATH (github.com/vadimcn/codelldb/releases)' + (optionalAdapterPlan('codelldb') ? ', or allow the pinned CodeLLDB download at Debug launch' : '')
}

export const PHP_DEBUG_HINT = 'allow the pinned PHP Debug download at Debug launch; install PHP and check that php -m lists xdebug; install Xdebug with pie install xdebug/xdebug (xdebug.org/docs/install) and enable zend_extension=xdebug'
let phpModulesMemo: { key: string; at: number; error?: string } | undefined

function phpDebugPreflight(): string | undefined {
  const php = findOnPathLocal('php')
  if (!php) return 'no php on PATH'
  const key = [php, statSync(php).mtimeMs, hostEnv().PHPRC, hostEnv().PHP_INI_SCAN_DIR].join('|')
  if (phpModulesMemo?.key === key && Date.now() - phpModulesMemo.at < 30_000) return phpModulesMemo.error
  const probe = spawnSync(php, ['-m'], { windowsHide: true, timeout: 5_000, encoding: 'utf8', env: subprocessEnv() })
  const error = probe.status === 0 && /^xdebug\s*$/im.test(probe.stdout ?? '')
    ? undefined
    : 'PHP with Xdebug is required — check that php -m lists xdebug'
  phpModulesMemo = { key, at: Date.now(), error }
  return error
}

export const BASH_DEBUG_HINT = 'provide bash-debug-adapter on PATH or unpack vscode-bash-debug under <configHome>/adapters/bash; bashdb and a compatible Bash are required (macOS /bin/bash 3.2 is unsupported); bashdb is maintained, but vscode-bash-debug last released in 2021 — no automatic download'
let bashVersionMemo: { key: string; at: number; compatible: boolean } | undefined

function bashDebugSpec(command: string, args: string[], bash: string, bashdb: string): DapAdapterSpec {
  const key = `${bash}|${statSync(bash).mtimeMs}`
  if (bashVersionMemo?.key !== key || Date.now() - bashVersionMemo.at >= 30_000) {
    const probe = spawnSync(bash, ['--version'], { windowsHide: true, timeout: 5_000, encoding: 'utf8', env: subprocessEnv() })
    bashVersionMemo = { key, at: Date.now(), compatible: probe.status === 0 && Number(/version (\d+)\./.exec(probe.stdout ?? '')?.[1] ?? 0) >= 4 }
  }
  const directory = path.dirname(realpathSync(bashdb))
  const library = [directory, path.resolve(directory, '../share/bashdb'), path.resolve(directory, '../lib/bashdb')].find(candidate => existsSync(path.join(candidate, 'dbg-main.sh')))
  return {
    command,
    args,
    fileTypes: ['.sh', '.bash'],
    installHint: BASH_DEBUG_HINT,
    preflightError: !bashVersionMemo.compatible
      ? 'Bash 4 or newer is required; macOS /bin/bash 3.2 is not supported by vscode-bash-debug'
      : library === undefined ? 'no bashdb library beside bashdb or under its prefix/share/bashdb; set pathBashdbLib in a custom adapter row' : undefined,
    launchDefaults: {
      type: 'bashdb',
      pathBash: bash,
      pathBashdb: bashdb,
      pathBashdbLib: library,
      pathCat: findOnPathLocal('cat') ?? 'cat',
      pathMkfifo: findOnPathLocal('mkfifo') ?? 'mkfifo',
      pathPkill: process.platform === 'darwin' ? '/usr/bin/pkill' : findOnPathLocal('pkill') ?? 'pkill',
      argsString: '',
      env: {},
      terminalKind: 'debugConsole',
    },
  }
}

export function builtinAdapters(read: 'live' | 'memo' = 'live'): Record<string, () => DapAdapterSpec> {
  const table: Record<string, () => DapAdapterSpec> = {
    python: () => ({ ...pythonAdapterSpec(), attachShape: 'connect', fileTypes: ['.py'] }),
    lldb: () => {
      const resolved = resolveLldbDap()
      return {
        command: resolved?.path ?? 'lldb-dap',
        args: [],
        envShape: 'pairs',
        installHint: resolved
          ? `lldb-dap via ${resolved.source === 'xcrun' ? 'the darwin toolchain (xcrun -f lldb-dap)' : 'PATH'}: ${resolved.path}`
          : lldbDapInstallHint(),
      }
    },
  }
  const bash = findOnPathLocal('bash')
  const bashdb = findOnPathLocal('bashdb')
  const bashAdapter = findOnPathLocal('bash-debug-adapter')
  const bashEntry = join(getMercuryHome(), 'adapters', 'bash', 'extension', 'out', 'bashDebug.js')
  if (bash && bashdb && (bashAdapter || existsSync(bashEntry))) {
    table.bash = () => bashDebugSpec(bashAdapter ?? process.execPath, bashAdapter ? [] : [bashEntry], bash, bashdb)
  }
  const phpDebug = installedOptionalAdapter('php')
  if (phpDebug) {
    table.php = () => ({
      command: process.execPath,
      args: [phpDebug],
      fileTypes: ['.php'],
      rootMarkers: ['composer.json'],
      installHint: PHP_DEBUG_HINT,
      preflightError: phpDebugPreflight(),
      launchDefaults: {
        hostname: '127.0.0.1',
        port: 0,
        runtimeArgs: ['-dxdebug.start_with_request=yes'],
        env: { XDEBUG_MODE: 'debug,develop', XDEBUG_CONFIG: 'client_host=127.0.0.1 client_port=${port}' },
      },
    })
  }
  const codelldb = findOnPathLocal('codelldb') ?? installedOptionalAdapter('codelldb')
  if (codelldb) {
    table.codelldb = () => ({
      command: codelldb,
      args: [],
      rootMarkers: ['Cargo.toml'],
      launchDefaults: { terminal: 'console' },
      installHint: codelldbInstallHint(),
    })
  }
  if (findOnPathLocal('dlv')) {
    table.go = () => ({
      command: 'dlv',
      args: ['dap', '--listen=127.0.0.1:${port}'],
      connect: 'tcp',
      fileTypes: ['.go'],
      rootMarkers: ['go.mod'],
      installHint: 'go install github.com/go-delve/delve/cmd/dlv@latest',
    })
  }
  const jsDebug = resolveJsDebugServer()
  if (jsDebug) {
    table.js = () => ({
      command: process.execPath,
      args: [jsDebug.path, '${port}', '127.0.0.1'],
      connect: 'tcp',
      fileTypes: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'],
      rootMarkers: ['package.json'],
      launchDefaults: { type: 'pwa-node' },
      attachDefaults: { type: 'pwa-node' },
      installHint: `js-debug via ${jsDebugSourceLabel(jsDebug.source)}: ${jsDebug.path}`,
    })
  }
  if (findOnPathLocal('netcoredbg')) {
    table.dotnet = () => ({
      command: 'netcoredbg',
      args: ['--interpreter=vscode'],
      fileTypes: ['.cs'],
      rootMarkers: ['*.csproj', '*.sln'],
      installHint: netcoredbgInstallHint(),
    })
  }
  if (findOnPathLocal('rdbg')) {
    table.ruby = () => ({
      command: 'rdbg',
      args: ['--open', '--port', '${port}', '--stop-at-load', '--', '${program}'],
      connect: 'tcp',
      startRequest: 'attach',
      fileTypes: ['.rb'],
      rootMarkers: ['Gemfile'],
      installHint: 'gem install debug (provides rdbg)',
    })
  }
  if (findOnPathLocal('dart')) {
    table.dart = () => ({
      command: 'dart',
      args: ['debug_adapter'],
      fileTypes: ['.dart'],
      rootMarkers: ['pubspec.yaml'],
      installHint: 'dart debug_adapter ships with the Dart SDK (dart.dev/get-dart)',
    })
  }
  if (findOnPathLocal('flutter')) {
    table.flutter = () => ({
      command: 'flutter',
      args: ['debug-adapter'],
      fileTypes: ['.dart'],
      rootMarkers: ['pubspec.yaml'],
      installHint: 'flutter debug-adapter ships with the Flutter SDK (docs.flutter.dev/install)',
    })
  }
  if (findOnPathLocal('kotlin-debug-adapter')) {
    table.kotlin = () => ({
      command: 'kotlin-debug-adapter',
      args: [],
      fileTypes: ['.kt'],
      rootMarkers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
      installHint: KOTLIN_DEBUG_ADAPTER_HINT,
    })
  }
  const elixirDebugAdapter = ELIXIR_DEBUG_ADAPTER_BINARIES.find(name => findOnPathLocal(name))
  if (elixirDebugAdapter !== undefined) {
    table.elixir = () => ({
      command: elixirDebugAdapter,
      args: [],
      fileTypes: ['.ex', '.exs'],
      rootMarkers: ['mix.exs'],
      installHint: ELIXIR_DEBUG_ADAPTER_HINT,
    })
  }
  const gdb = read === 'memo' ? gdbProbeFromMemo() : probeGdbDap()
  if (gdb.viable) {
    table.gdb = () => ({
      command: 'gdb',
      args: ['-i=dap'],
      installHint: `gdb ${gdb.version ?? ''} -i=dap (native DAP floor: gdb ${GDB_DAP_MIN_MAJOR}+)`.trim(),
    })
  } else if (gdb.reason && gdb.reason !== 'no gdb on PATH') {
    logForDebugging(`dap: gdb adapter not registered: ${gdb.reason}`)
  }
  if (mercuryGodotEnabled()) {
    const port = godotDapPort()
    const hint = godotEditorHint(port)
    const bridge = godotBridgeCommand(port, hint)
    if (!('reason' in bridge)) {
      table[GODOT_DAP_ADAPTER_KEY] = () => ({
        command: bridge.command,
        args: bridge.args,
        installHint: hint,
        buildLaunchArgs: godotLaunchArgs,
      })
    } else {
      logForDebugging(`dap: godot adapter unavailable: ${bridge.reason}`)
    }
  }
  if (mercuryUnityEnabled()) {
    const unity = resolveUnityDebugAdapter()
    if (!('reason' in unity)) {
      table[UNITY_DAP_ADAPTER_KEY] = () => ({
        command: unity.dotnet,
        args: [unity.dll],
        startRequest: 'attach',
        fileTypes: ['.cs'],
        rootMarkers: ['Assets', 'ProjectSettings'],
        installHint: `${unityEditorHint()} (adapter: ${unity.source} ${unity.dll})`,
        buildAttachArgs: buildUnityAttachArgs,
      })
    } else {
      logForDebugging(`dap: unity adapter unavailable: ${unity.reason}`)
    }
  }
  return table
}
