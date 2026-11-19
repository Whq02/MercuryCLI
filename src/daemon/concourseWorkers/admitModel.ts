import { validateWorkerModelChoice, canonicalWorkerModelId } from '../../services/concourse/workerModels.js'
import { refreshSignInReads, describeSignInRead } from '../signInView.js'
import { sessionKindOfAsker } from '../../utils/sessionKind.js'
import { isLocalModelId, localWireId } from '../../services/providers/local/localCatalogue.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { recordToEntry } from '../../fabric/entryCodec.js'
import { sessionModelOfEntry, servedModelOfAssistantRow, billingSafeRetainedForm } from '../../utils/model/retainedModel.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'
import { scanTranscriptLinesBackward } from '../../utils/sessionStorage/transcriptReader.js'
import { rememberedTensorFoldRepos } from '../../services/providers/local/tensorfoldHosts.js'
import { tensorFoldShortName } from '../../services/tensorfold/starting.js'
import { canonicalWorkspaceId } from './admission.js'
import { readSessionWorkers } from './store.js'
import type { ConcourseAdmitDeps, ConcourseAdmitRequest, ConcourseAdmitResult } from './admit.js'

export function resumeModelKeyOf(sessionId: string, workspaceDir: string, dir?: string): string | undefined {
  const fromRecord = Object.values(readSessionWorkers(dir))
    .filter(r => r.sessionId === sessionId && r.modelKey !== undefined && r.keyless !== true)
    .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.modelKey
  if (fromRecord !== undefined) return fromRecord
  let workspaceId = workspaceDir
  try {
    workspaceId = canonicalWorkspaceId(workspaceDir)
  } catch {
  }
  const transcript = join(getProjectDir(workspaceId), `${sessionId}.jsonl`)
  if (!existsSync(transcript)) return undefined
  let retained: string | undefined
  try {
    scanTranscriptLinesBackward(transcript, line => {
      if (!line.includes('assistant') && !line.includes('output') && !line.includes('"metaKind":"model"')) return
      try {
        const row = JSON.parse(line) as Record<string, unknown>
        const entry = (
          typeof row.recordId === 'string' && row.payload !== undefined
            ? (recordToEntry(row as never) as Record<string, unknown>)
            : row
        ) as { type?: string; model?: unknown; message?: { model?: unknown } }
        const chosen = sessionModelOfEntry(entry)
        if (chosen !== undefined) {
          retained = chosen
          return true
        }
        const served = servedModelOfAssistantRow(entry)
        if (served !== undefined) {
          retained = billingSafeRetainedForm(served)
          return true
        }
      } catch {
      }
      return
    })
  } catch {
  }
  return retained
}

export function localModelNotServedNote(id: string): string {
  const wire = localWireId(id).toLowerCase()
  const servedHere = rememberedTensorFoldRepos().some(repo => tensorFoldShortName(repo).toLowerCase() === wire)
  return `${id} is not being served — ${servedHere ? '/tensorfold serves it again' : 'start a local server, or set MERCURY_LOCAL_BASE_URL'} · /model chooses another`
}

export async function admitModelOf(
  req: ConcourseAdmitRequest,
  deps: ConcourseAdmitDeps,
): Promise<ConcourseAdmitResult | { retainedNote: string | undefined; modelKey: string; modelDisplayName: string; keyless: boolean }> {
  const retainedModelKey =
    req.modelKey === undefined && req.resumeSessionId !== undefined
      ? resumeModelKeyOf(req.resumeSessionId, req.workspaceDir, deps.dir)
      : undefined
  refreshSignInReads(true)
  const validated = await validateWorkerModelChoice(req.modelKey ?? retainedModelKey, 'session')
  let admission = validated
  let retainedNote: string | undefined
  if (!validated.ok && req.modelKey === undefined && retainedModelKey !== undefined && validated.reason.startsWith('no-credential:')) {
    const unnamed = await validateWorkerModelChoice(undefined, 'session')
    if (unnamed.ok) {
      admission = unnamed
      retainedNote =
        unnamed.keyless === true
          ? `the session's model ${retainedModelKey} has no credential here — the first model send picks the neutral default; /model chooses`
          : `the session's model ${retainedModelKey} has no credential here — it continues on ${unnamed.entry.displayName} (the neutral default); /model chooses`
    }
  }
  const named = req.modelKey ?? retainedModelKey
  if (!admission.ok && admission.reason === 'unreachable:local' && named !== undefined && isLocalModelId(named) && sessionKindOfAsker(req.by) === 'oculus') {
    const id = await canonicalWorkerModelId(named)
    const arm = { availability: 'refused' as const, refusal: 'unreachable:local' as const, ...(admission.detail !== undefined ? { detail: admission.detail } : {}), ...(admission.action !== undefined ? { action: admission.action } : {}) }
    admission = { ok: true, entry: { modelId: id, displayName: id, session: arm, crew: arm } }
    retainedNote = localModelNotServedNote(id)
  }
  if (!admission.ok) {
    const read = admission.reason.startsWith('no-credential:') ? ` — ${describeSignInRead(admission.reason.slice('no-credential:'.length))}` : ''
    const error = `model refused (${admission.reason})${admission.action !== undefined ? ` · ${admission.action}` : ''}${admission.detail !== undefined ? ` — ${admission.detail}` : ''}${read} (got ${JSON.stringify(req.modelKey ?? retainedModelKey ?? '(unset → registry default)')}${retainedModelKey !== undefined && req.modelKey === undefined ? ' — the model this session ran on; --model picks another' : ''})`
    console.error(`[daemon] admission refused: ${error}`)
    return { ok: false, code: 'invalid-request', error }
  }
  const modelKey = admission.entry.modelId
  const modelDisplayName = admission.entry.displayName
  const keyless = admission.keyless === true
  if (keyless && admission.note !== undefined && retainedNote === undefined) retainedNote = admission.note
  return { retainedNote, modelKey, modelDisplayName, keyless }
}
