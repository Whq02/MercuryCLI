import { basename } from 'node:path';
import { logForDebugging } from '../../../utils/debug.js';
import { getCwd } from '../../../utils/cwd.js';
import { getInitialEffortSetting } from '../../../utils/effort.js';
import { enterRootChat, surfaceGeneration } from '../../../context/surfaceRoute.js';
import { dispatchSeedInputs, readConcourseSeedOverrides, readHarnessGround } from '../../../services/concourse/concourseSnapshot.js';
import type { ConcourseCallbacks, ConcourseSnapshotV1, ControlNoteState } from '../contracts.js';

type LaunchControls = {
  noteControl: (control: string, state: ControlNoteState) => void
  splitFrameStands: () => boolean
  birthInFlightRef: { current: boolean }
  seedWriteChain: { current: Promise<unknown> }
  snapshotRef: { current: ConcourseSnapshotV1 | null }
}

export function newSession({ noteControl, splitFrameStands, birthInFlightRef, seedWriteChain }: LaunchControls, opts?: { contractText?: string }): void {
  if (birthInFlightRef.current) return
  birthInFlightRef.current = true
  const gen = surfaceGeneration()
  noteControl('board:new-session', { state: 'pending', reason: 'starting a session…' })
  void (async () => {
    try {
      await seedWriteChain.current
      const { ground, unread } = await readHarnessGround()
      const groundNote = unread === undefined ? '' : ` — the repo choice could not be read (${unread}), so it starts in ${basename(ground) || ground}`
      const { bornSession } = await import('../../../services/switchboard/bornSession.js')
      const born = await bornSession({ workspaceDir: ground })
      if (!born.ok) {
        noteControl('board:new-session', { state: 'refused', reason: born.reason, next: 'n retries' })
        return
      }
      let contractNote = ''
      const contractText = opts?.contractText?.trim() ?? ''
      if (contractText.length > 0) {
        try {
          const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
          const reply = await daemonControlRpc(
            { op: 'sessionControl', action: 'contract', sessionId: born.sessionId, by: 'operator', contract: { op: 'set', text: contractText } },
            { timeoutMs: 10_000 },
          )
          if (reply.ok !== true || reply.outcome !== 'applied') {
            contractNote = ` — the contract was not set (${(reply.ok ? reply.detail : undefined) ?? 'the daemon refused it'}); /contract retries`
          }
        } catch {
          contractNote = ' — the contract was not set (the daemon was unreachable); /contract retries'
        }
      }
      if (surfaceGeneration() === gen) {
        if (splitFrameStands()) {
          noteControl('board:new-session', { state: 'applied', reason: `${born.title} — in the chat pane${contractNote}${groundNote}` })
        } else {
          noteControl('board:new-session', { state: 'applied', reason: `entering ${born.title}${contractNote}${groundNote}` })
          enterRootChat()
        }
      }
    } catch (e) {
      logForDebugging(`[concourse] new session failed: ${e}`)
      noteControl('board:new-session', { state: 'failed', reason: 'the session could not start', next: 'n retries' })
    } finally {
      birthInFlightRef.current = false
    }
  })()
}

export async function previewLaunch({ seedWriteChain, snapshotRef }: LaunchControls): ReturnType<NonNullable<ConcourseCallbacks['previewLaunch']>> {
  await seedWriteChain.current
  const seeds = await readConcourseSeedOverrides()
  const si = dispatchSeedInputs(seeds, getCwd(), snapshotRef.current?.newSession.seeds.modelId, getInitialEffortSetting())
  const folder = basename(si.workspaceDir) || si.workspaceDir
  if (seeds.isolation !== undefined) return { folder, forks: false, mainHolderTitle: null }
  const { previewDefaultedLaunch } = await import('../../../daemon/concourseDispatch.js')
  const preview = previewDefaultedLaunch(si.workspaceDir)
  return { folder, forks: preview.forks, mainHolderTitle: preview.mainHolderTitle ?? null }
}
