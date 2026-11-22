import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, syncFileFromDisk } from './shared.js'
import { notBuilt } from '../../../pi/holes.js'

const RAW_RESULT_CHAR_CAP = 20_000

const RAW_REQUEST_EDIT_CLASS: Record<string, string> = {
  'textDocument/rename': 'use LspRename — its result rides the drift-safe apply transaction',
  'workspace/willRenameFiles': 'use LspMoveFile — the move and its import edits ride one transaction',
  'workspace/executeCommand': 'it runs a server-side command that can edit the workspace outside the transaction — use LspCodeAction with apply: true',
  'textDocument/codeAction': 'use LspCodeAction — resolved edits ride the apply transaction',
  'codeAction/resolve': 'use LspCodeAction — resolved edits ride the apply transaction',
  'textDocument/formatting': 'use LspFormat',
  'textDocument/rangeFormatting': 'use LspFormat',
  'workspace/applyEdit': 'a server→client request — a client cannot send it',
}

export async function opCapabilities(env: OpEnv): Promise<MercuryLspOpOutput> {
  const display = displayPathFor(env.cwd, env.absolutePath)
  const server = env.manager.getServerForFile(env.absolutePath)
  if (!server) {
    return {
      result: `No language server claims ${display} — nothing to dump. op:"serverStatus" lists the configured servers.`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'no-change', changedPaths: [], evidence: 'no claimant' },
    }
  }
  await env.manager.ensureServerStarted(env.absolutePath)
  const caps = server.capabilities
  if (!caps) {
    return {
      result: `${server.name} claims ${display} but reports no capabilities yet (state: ${server.state}).`,
      resultCount: 0,
      fileCount: 0,
      effect: { outcome: 'no-change', changedPaths: [], evidence: `no capabilities (state ${server.state})` },
    }
  }
  const text = JSON.stringify(caps, null, 2)
  const clipped = text.length > RAW_RESULT_CHAR_CAP
  return {
    result:
      `${server.name} capabilities for ${display}:\n` +
      (clipped ? `${text.slice(0, RAW_RESULT_CHAR_CAP)}\n… (${text.length - RAW_RESULT_CHAR_CAP} more chars)` : text),
    resultCount: Object.keys(caps).length,
    fileCount: 1,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: `dumped ${Object.keys(caps).length} capability key(s) from ${server.name}`,
    },
  }
}

export async function opRawRequest(env: OpEnv): Promise<MercuryLspOpOutput> {
  return notBuilt('src/tools/LSPTool/mercuryOps/rawRequest.ts:54')
}
