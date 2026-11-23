import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mercuryLspEnabled } from '../../../../integrations/lsp/mercuryLsp.js'
import { mercuryLspServersInvalidNote, probeBuiltinTsServer } from '../../../../integrations/lsp/builtinServers.js'
import { compileDbRemedy, mercuryLspCppEnabled, probeBuiltinClangd, probeCompileDb } from '../../../../integrations/lsp/clangdLane.js'
import { probeGodotEditorReachable, probeGodotLane } from '../../../../integrations/lsp/godotLane.js'
import { getInitializationStatus, getLspServerManager } from '../../../../integrations/lsp/serverManagerLifecycle.js'
import { flagAsSet, type CheckSpec } from '../../healthReport.js'
import { passedOver } from '../../../errors/passedOver.js'

function readTsVersion(tsPath: string): string | null {
  try {
    const pkgPath = join(dirname(dirname(tsPath)), 'package.json')
    if (!existsSync(pkgPath)) return null
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return pkg.version ?? null
  } catch (error) {
    passedOver(error)
    return null
  }
}

export function lspCheck(): CheckSpec {
  return {
    id: 'lsp',
    label: 'IDE-hands (LspRead)',
    run: async () => {
      if (!mercuryLspEnabled()) {
        return {
          status: 'off',
          evidence: `${flagAsSet('MERCURY_LSP')} — IDE-hands bridge disabled by flag`,
        }
      }
      const probe = probeBuiltinTsServer()
      const tsEvidence = probe.typescriptPath
        ? `typescript@${readTsVersion(probe.typescriptPath) ?? '?'}`
        : 'no workspace typescript'
      const laneSegments: string[] = []
      if (!mercuryLspCppEnabled()) {
        laneSegments.push(`cpp lane off (${flagAsSet('MERCURY_LSP_CPP')})`)
      } else {
        const cpp = probeBuiltinClangd()
        if (!cpp.available || !cpp.clangdPath) {
          laneSegments.push('no clangd')
        } else {
          const db = probeCompileDb()
          laneSegments.push(
            db.compileDb
              ? 'clangd ok · compile DB found'
              : db.cmakeLists
                ? `clangd ok · ${compileDbRemedy(db)}`
                : 'clangd ok',
          )
        }
      }
      const godot = probeGodotLane()
      if (!godot.enabled) {
        laneSegments.push('godot lane off (MERCURY_GODOT)')
      } else if (!godot.projectRoot) {
        laneSegments.push('godot armed · no project.godot here')
      } else {
        const reachable = await probeGodotEditorReachable(godot.lspPort)
        laneSegments.push(
          reachable
            ? `godot editor listening :${godot.lspPort}`
            : `godot editor NOT listening :${godot.lspPort} — open the project in the Godot editor (or godot --editor --headless; macOS app bundle: <Godot.app>/Contents/MacOS/Godot)`,
        )
      }
      const lanes = laneSegments.join(' · ')
      const invalidEnv = mercuryLspServersInvalidNote()
      const init = getInitializationStatus()
      if (init.status === 'failed') {
        return {
          status: 'fail',
          evidence: `manager init failed: ${init.error.message.slice(0, 120)}`,
          fix: 'Check extension language-server configs / MERCURY_LSP_SERVERS JSON; /extensions reload re-inits.',
        }
      }
      if (init.status === 'not-started' || init.status === 'pending') {
        return {
          status: invalidEnv ? 'warn' : 'info',
          evidence: `${invalidEnv ? `${invalidEnv} · ` : ''}bridge armed · ${tsEvidence} · ${lanes} · manager ${init.status} (probe: builtinServers.probeBuiltinTsServer)`,
        }
      }
      const manager = getLspServerManager()
      const servers = manager ? [...manager.getAllServers().values()] : []
      if (servers.length === 0) {
        return {
          status: invalidEnv ? 'warn' : 'info',
          evidence: `${invalidEnv ? `${invalidEnv} · ` : ''}no LSP server source — ${probe.reason ?? tsEvidence}; ${lanes}`,
          fix: 'Add typescript to the workspace, install clangd, provide MERCURY_LSP_SERVERS, or install an extension that contributes a language server.',
        }
      }
      const errored = servers.filter(s => s.state === 'error')
      const roster = servers
        .map(s => `${s.name} ${s.state === 'stopped' ? 'idle' : s.state}`)
        .join(' · ')
      if (errored.length > 0) {
        return {
          status: 'warn',
          evidence: `${invalidEnv ? `${invalidEnv} · ` : ''}${roster} — ${errored[0]!.name}: ${errored[0]!.lastError?.message.slice(0, 100) ?? 'error'}`,
          fix: 'Server errored; it restarts on next use up to maxRestarts. MERCURY_LSP_DEBUG=1 for sidecar stderr.',
          link: '/trace',
        }
      }
      return {
        status: invalidEnv ? 'warn' : 'ok',
        evidence: `${invalidEnv ? `${invalidEnv} · ` : ''}${roster} · ${tsEvidence} · ${lanes} · post-edit diagnostics armed (servers lazy-start on first use)`,
        link: '/trace',
      }
    },
  }
}

export function editorDoorCheck(): CheckSpec {
  return {
    id: 'editor-door',
    label: 'Editor door',
    run: async () => {
      const { installedEditorExtensions } = await import('../../../../commands/verbs/editorExtensionPackage.js')
      const installed = installedEditorExtensions()
      const evidence = [
        installed.length > 0
          ? `extension installed: ${installed.map(i => `${i.editor} ${i.version}`).join(', ')}`
          : 'extension NOT installed in any VS Code-family editor',
        'acp: mercury acp',
      ].join(' · ')
      if (installed.length > 0) return { status: 'ok' as const, evidence }
      return {
        status: 'info' as const,
        evidence,
        fix: 'mercury bridge install (installs the extension from this build), then reload the editor window; any ACP editor runs mercury acp --stdio directly.',
      }
    },
  }
}
