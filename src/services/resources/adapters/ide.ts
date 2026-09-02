// resources/adapters/ide — the IDE-plane projections.
// mercury://ide/python/project is the shared Python project profile
// later slices add cpp/godot
// projections under the same kind. Registered like service/lane: from this
// module, imported by tools.ts.

import { buildCppProjectProfile } from '../../ide/cppProject.js'
import { buildGodotIdeSession } from '../../ide/godotSession.js'
import {
  getTransaction,
  ideLoopEnabled,
  latestTransaction,
  listTransactions,
} from '../../ide/ideTransaction.js'
import {
  discoverLaunchProfiles,
  getLaunchProfile,
  launchProfilesEnabled,
} from '../../ide/launchProfiles.js'
import { buildPythonProjectProfile } from '../../ide/pythonProject.js'
import { buildUnityBridgeIdeSession } from '../../ide/unityBridgeSession.js'
import { buildBlenderBridgeIdeSession } from '../../ide/blenderBridgeSession.js'
import { registerResourceAdapter } from '../registry.js'
import type { ParsedRef, ResourceAdapter, ResourceChild, ResourceResult } from '../contracts.js'

const KNOWN: ResourceChild[] = [
  {
    ref: 'mercury://ide/typescript/project',
    title: 'TypeScript / JavaScript project profile',
    summary: 'root · the in-bundle mercury-ts language-server lane (LSP tool) · resolved typescript package + version, or why the lane is unavailable',
  },
  {
    ref: 'mercury://ide/python/project',
    title: 'Python project profile',
    summary: 'root · interpreter (explicit>active-env>.venv>PATH, probed) · test frameworks · Pyright/Ruff · debugpy provenance',
  },
  {
    ref: 'mercury://ide/godot/session',
    title: 'Godot IDE session',
    summary: 'project identity · lane arming (MERCURY_GODOT / VULCAN) · LSP/DAP/VULCAN truth · editor state',
  },
  {
    ref: 'mercury://ide/unity/session',
    title: 'Unity IDE session',
    summary: 'project identity · lane arming (MERCURY_UNITY) · bridge install/reachability truth · editor state (play/scenes/console) · the durable test-results door',
  },
  {
    ref: 'mercury://ide/blender/session',
    title: 'Blender IDE session',
    summary: 'blend context · lane arming (MERCURY_BLENDER) · bridge addon-home/install/reachability truth · editor state (scene/render/report head)',
  },
  {
    ref: 'mercury://ide/cpp/project',
    title: 'C/C++ project profile',
    summary: 'root · compile DB (clangd walk truth) · CMake presets · build dirs · tidy/format evidence',
  },
  {
    ref: 'mercury://ide/launch',
    title: 'unified launch profiles',
    summary: 'content-stable profiles from launch.json · python tests · CMake presets · Godot scenes (the Launch tool executes them)',
  },
  {
    ref: 'mercury://ide/transaction',
    title: 'closed-loop IDE transactions',
    summary: 'durable evidence-bound coding loops with mechanically-gated verdicts (the Transaction tool writes them)',
  },
]

export const ideAdapter: ResourceAdapter = {
  kind: 'ide',
  describe: 'IDE-plane projections: python/project · godot/session · unity/session · cpp/project · launch (unified profiles)',
  async resolve(ref: ParsedRef, ctx): Promise<ResourceResult> {
    if (ref.id === '') {
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://ide',
          kind: 'ide',
          title: 'IDE plane',
          summary: `${KNOWN.length} projection(s)`,
          mutable: false,
          children: KNOWN,
        },
      }
    }
    if (ref.id === 'typescript/project') {
      // The TS/JS lane is the in-bundle mercury-ts sidecar surfaced through
      // the LSP tool (services/lsp/builtinServers); this projection states
      // its live truth so the map never reads as "no JS lane".
      const { probeBuiltinTsServer } = await import('../../lsp/builtinServers.js')
      const { mercuryLspEnabled } = await import('../../lsp/mercuryLsp.js')
      if (!mercuryLspEnabled()) {
        return {
          state: 'ok',
          resource: {
            ref: 'mercury://ide/typescript/project',
            kind: 'ide',
            title: 'TypeScript / JavaScript project',
            summary: 'the language-server lane is disabled (MERCURY_LSP=0)',
            mutable: false,
          },
        }
      }
      const probe = probeBuiltinTsServer()
      const summary = probe.available
        ? `mercury-ts lane available · typescript ${probe.typescriptVersion ?? '(version unknown)'}` +
          `${probe.typescriptSource ? ` (${probe.typescriptSource})` : ''} — diagnostics/definitions/references over .ts/.tsx/.js/.jsx via the LSP tool`
        : `mercury-ts lane unavailable — ${probe.reason ?? 'no resolvable typescript package'}`
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://ide/typescript/project',
          kind: 'ide',
          title: 'TypeScript / JavaScript project',
          summary,
          mutable: false,
          structured: probe,
        },
      }
    }
    if (ref.id === 'python/project') {
      const profile = buildPythonProjectProfile(ctx.cwd)
      const it = profile.interpreter
      const summary =
        it.state === 'ok'
          ? `${it.command} ${it.version} (${it.envKind}) · debugpy ${profile.debugger.adapterSource}` +
            ` · pytest ${profile.testFrameworks.pytest.detected ? 'detected' : '—'}` +
            ` · pyright ${profile.pyright.configured ? 'configured' : '—'}` +
            ` · ruff ${profile.ruff.available ? (profile.ruff.version ?? 'available') : '—'}`
          : `no interpreter — ${it.detail.slice(0, 120)}`
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://ide/python/project',
          kind: 'ide',
          title: `Python project · ${profile.projectRoot}`,
          summary,
          mutable: false,
          structured: profile,
          text: JSON.stringify(profile, null, 2),
        },
      }
    }
    if (ref.id === 'transaction' || ref.id.startsWith('transaction/')) {
      if (!ideLoopEnabled()) {
        return { state: 'unavailable', note: 'IDE transactions are disabled (MERCURY_IDE_LOOP=0)' }
      }
      if (ref.id === 'transaction') {
        const rows = listTransactions(ctx.cwd)
        return {
          state: 'ok',
          resource: {
            ref: 'mercury://ide/transaction',
            kind: 'ide',
            title: 'closed-loop IDE transactions',
            summary: `${rows.length} recorded transaction(s)`,
            mutable: false,
            children: rows.slice(0, 25).map(r => ({
              ref: `mercury://ide/transaction/${r.id}`,
              title: r.intent,
              summary: `[${r.verdict}]`,
            })),
          },
        }
      }
      const id = ref.id.slice('transaction/'.length)
      const record = id === 'latest' ? latestTransaction(ctx.cwd) : getTransaction(id, ctx.cwd)
      if (!record) return { state: 'absent', note: `no IDE transaction '${id}'` }
      return {
        state: 'ok',
        resource: {
          ref: `mercury://ide/transaction/${record.id}`,
          kind: 'ide',
          title: `IDE transaction · ${record.intent.slice(0, 60)}`,
          summary: `[${record.verdict}] ${record.steps.length} step(s)${record.unresolved.length ? ` · ${record.unresolved.length} unresolved` : ''}`,
          version: `${record.steps.length}`,
          mutable: record.verdict === 'open',
          structured: record,
          text: JSON.stringify(record, null, 2),
        },
      }
    }
    if (ref.id === 'launch' || ref.id.startsWith('launch/')) {
      if (!launchProfilesEnabled()) {
        return { state: 'unavailable', note: 'launch profiles are disabled (MERCURY_LAUNCH=0)' }
      }
      if (ref.id === 'launch') {
        const d = await discoverLaunchProfiles(ctx.cwd)
        return {
          state: 'ok',
          resource: {
            ref: 'mercury://ide/launch',
            kind: 'ide',
            title: 'unified launch profiles',
            summary: `${d.profiles.length} profile(s) · ${d.skipped.length} skipped launch.json config(s) · ${d.sourceErrors.length} source note(s)`,
            mutable: false,
            structured: d,
            children: d.profiles.slice(0, 40).map(p => ({
              ref: `mercury://ide/launch/${p.id}`,
              title: p.label,
              summary: `[${p.kind}/${p.language}] ${p.provenance}`,
            })),
          },
        }
      }
      const profile = await getLaunchProfile(ref.id.slice('launch/'.length), ctx.cwd)
      if (!profile) {
        return { state: 'absent', note: `no launch profile '${ref.id}' in the current discovery (ids are content-stable — re-list)` }
      }
      return {
        state: 'ok',
        resource: {
          ref: `mercury://ide/launch/${profile.id}`,
          kind: 'ide',
          title: profile.label,
          summary: `[${profile.kind}/${profile.language}] ${profile.provenance}`,
          mutable: false,
          structured: profile,
          text: JSON.stringify(profile, null, 2),
        },
      }
    }
    if (ref.id === 'cpp/project') {
      const profile = buildCppProjectProfile(ctx.cwd)
      const db = profile.compileDb
      const summary =
        `${profile.projectRoot} · compile DB ${db.state === 'ok' ? db.path : 'ABSENT'}` +
        ` · ${profile.cmake.presets.length} preset(s)` +
        ` · tidy ${profile.clangTidy.configured ? 'configured' : '—'} · format ${profile.clangFormat.configured ? 'configured' : '—'}`
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://ide/cpp/project',
          kind: 'ide',
          title: `C/C++ project · ${profile.projectRoot}`,
          summary,
          mutable: false,
          structured: profile,
          text: JSON.stringify(profile, null, 2),
        },
      }
    }
    if (ref.id === 'unity/session') {
      const session = await buildUnityBridgeIdeSession(ctx.cwd)
      const summary =
        session.project.state === 'ok'
          ? `${session.project.root} · lane ${session.unityLane.state} · bridge ${session.bridge.state}`
          : session.project.detail
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://ide/unity/session',
          kind: 'ide',
          title: `Unity session · ${session.project.state === 'ok' ? session.project.root : 'no project'}`,
          summary,
          mutable: false,
          structured: session,
          text: JSON.stringify(session, null, 2),
        },
      }
    }
    if (ref.id === 'blender/session') {
      const session = await buildBlenderBridgeIdeSession(ctx.cwd)
      const summary =
        `${session.context.blendFiles.total} .blend file(s) · lane ${session.blenderLane.state} · bridge ${session.bridge.state}`
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://ide/blender/session',
          kind: 'ide',
          title: `Blender session · ${session.context.blender?.path ?? 'no Blender located'}`,
          summary,
          mutable: false,
          structured: session,
          text: JSON.stringify(session, null, 2),
        },
      }
    }
    if (ref.id === 'godot/session') {
      const session = await buildGodotIdeSession(ctx.owner, ctx.cwd)
      const summary =
        session.project.state === 'ok'
          ? `${session.project.name ?? session.project.root} · lanes ${session.godotLane.state}/${session.vulcanLane.state} · vulcan ${session.vulcan.state} · ${session.dap.sessions.length} debug session(s)`
          : session.project.detail
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://ide/godot/session',
          kind: 'ide',
          title: `Godot session · ${session.project.state === 'ok' ? session.project.root : 'no project'}`,
          summary,
          mutable: false,
          structured: session,
          text: JSON.stringify(session, null, 2),
        },
      }
    }
    return {
      state: 'absent',
      note: `unknown ide projection '${ref.id}' — known: ${KNOWN.map(k => k.ref).join(', ')}`,
    }
  },
  async list(): Promise<ResourceChild[]> {
    return KNOWN
  },
}

registerResourceAdapter(ideAdapter)
