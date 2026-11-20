import { localWireId } from '../../services/providers/local/localCatalogue.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { recordToEntry } from '../../fabric/entryCodec.js'
import type { MercuryRecord } from '../../fabric/record.js'
import { sessionModelOfEntry, servedModelOfAssistantRow, billingSafeRetainedForm } from '../../utils/model/retainedModel.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'
import { scanTranscriptLinesBackward } from '../../utils/sessionStorage/transcriptReader.js'
import { rememberedTensorFoldRepos } from '../../services/providers/local/tensorfoldHosts.js'
import { tensorFoldShortName } from '../../services/tensorfold/starting.js'
import { canonicalWorkspaceId } from './admission.js'
import { readSessionWorkers } from './store.js'
import { passedOver } from '../../utils/passedOver.js'

export function resumeModelKeyOf(sessionId: string, workspaceDir: string, dir?: string): string | undefined {
  const fromRecord = Object.values(readSessionWorkers(dir))
    .filter(r => r.sessionId === sessionId && r.modelKey !== undefined && r.keyless !== true)
    .sort((a, b) => b.spawnedAt - a.spawnedAt)[0]?.modelKey
  if (fromRecord !== undefined) return fromRecord
  let workspaceId = workspaceDir
  try {
    workspaceId = canonicalWorkspaceId(workspaceDir)
  } catch (error) {
    passedOver(error)
  }
  const transcript = join(getProjectDir(workspaceId), `${sessionId}.jsonl`)
  if (!existsSync(transcript)) return undefined
  let retained: string | undefined
  try {
    scanTranscriptLinesBackward(transcript, line => {
      if (!line.includes('assistant') && !line.includes('output') && !line.includes('"metaKind":"model"')) return
      try {
        const row = JSON.parse(line) as Partial<MercuryRecord> & { type?: unknown; model?: unknown; message?: { model?: unknown } }
        const entry = (
          typeof row.recordId === 'string' && row.payload !== undefined
            ? recordToEntry(row as MercuryRecord)
            : row
        ) as { type?: unknown; model?: unknown; message?: { model?: unknown } }
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
      } catch (error) {
        passedOver(error)
      }
      return
    })
  } catch (error) {
    passedOver(error)
  }
  return retained
}

export function localModelNotServedNote(id: string): string {
  const wire = localWireId(id).toLowerCase()
  const servedHere = rememberedTensorFoldRepos().some(repo => tensorFoldShortName(repo).toLowerCase() === wire)
  return `${id} is not being served — ${servedHere ? '/tensorfold serves it again' : 'start a local server, or set MERCURY_LOCAL_BASE_URL'} · /model chooses another`
}
