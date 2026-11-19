import { basename, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MercuryLspOpOutput, OpEnv } from './types.js'
import { displayPathFor, isMethodNotFoundError, syncFileFromDisk } from './shared.js'

export async function opSwitchSourceHeader(env: OpEnv): Promise<MercuryLspOpOutput> {
  const display = displayPathFor(env.cwd, env.absolutePath)
  const claimant = env.manager.getServerForFile(env.absolutePath)
  if (!claimant) {
    const extension = extname(env.absolutePath) || basename(env.absolutePath)
    return {
      result:
        `No language server claims ${extension} files, so switchSourceHeader is unavailable for ${display}. ` +
        `The C/C++ lane (mercury-clangd) provides it when a workspace clangd is present and MERCURY_LSP_CPP is not disabled.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'failed',
        changedPaths: [],
        evidence: 'no claimant for the C/C++ lane',
      },
    }
  }
  await syncFileFromDisk(env.manager, env.absolutePath)
  const uri = pathToFileURL(resolve(env.absolutePath)).href
  let response: string | null | undefined
  try {
    response = await env.manager.sendRequest<string | null>(
      env.absolutePath,
      'textDocument/switchSourceHeader',
      { uri },
    )
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      return {
        result: `The ${claimant.name} server does not support switchSourceHeader (the request is a clangd extension).`,
        resultCount: 0,
        fileCount: 0,
        effect: {
          outcome: 'no-change',
          changedPaths: [],
          evidence: 'server does not support switchSourceHeader',
        },
      }
    }
    throw error
  }
  if (!response) {
    return {
      result:
        `No source/header counterpart found for ${display}. ` +
        `A compile_commands.json in the workspace usually lets clangd resolve counterparts across directories.`,
      resultCount: 0,
      fileCount: 0,
      effect: {
        outcome: 'no-change',
        changedPaths: [],
        evidence: 'no counterpart (a real answer)',
      },
    }
  }
  return {
    result: `Counterpart: ${displayPathFor(env.cwd, response)}`,
    resultCount: 1,
    fileCount: 1,
    effect: {
      outcome: 'succeeded',
      changedPaths: [],
      evidence: 'counterpart resolved',
    },
  }
}
