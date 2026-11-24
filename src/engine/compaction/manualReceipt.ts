import chalk from 'chalk'
import { getBindingDisplayText } from '../../screen/keys/resolver.js'
import { loadKeybindingsSync } from '../../screen/keys/loadUserBindings.js'
import { getUpgradeMessage } from '../../models/facts/contextWindowUpgradeCheck.js'
import { formatTokens } from '../../platform/text/format.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import type { FoldResult } from './fold/foldResult.js'

export function shouldEnrichForLiveDisplay(context: ToolUseContext): boolean {
  if (!context.options.isNonInteractiveSession) return true
  return flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
}

export function manualFoldDisplayText(
  context: ToolUseContext,
  result: FoldResult,
  messagesHandedIn: number,
): string {
  const kept = result.messagesToKeep?.length ?? 0
  const folded = Math.max(0, messagesHandedIn - kept)
  const pre = result.preFoldTokenCount
  const post = result.truePostFoldTokenCount
  const facts: string[] = []
  if (folded > 0) facts.push(`folded ${folded} message${folded === 1 ? '' : 's'} into the summary`)
  if (typeof pre === 'number' && pre > 0 && typeof post === 'number' && post >= 0) {
    facts.push(`context ${formatTokens(pre)} → ${formatTokens(post)} tokens`)
  }
  if (kept > 0) facts.push(`last ${kept} message${kept === 1 ? '' : 's'} kept verbatim`)
  const head = facts.length > 0 ? `Compacted — ${facts.join(' · ')}` : 'Compacted'
  const parts: string[] = []
  if (shouldEnrichForLiveDisplay(context) && !context.getAppState().verbose) {
    const chord =
      getBindingDisplayText('app:toggleTranscript', 'Global', loadKeybindingsSync()) ?? 'ctrl+o'
    parts.push(`(${chord} reads the full summary — what the agent retains)`)
  }
  for (const note of result.notes ?? []) parts.push(note)
  const tip = getUpgradeMessage(context.getAppState().engineModel)?.tip
  if (tip) parts.push(tip)
  const rest = parts.join('\n')
  return chalk.dim(rest ? `${head}\n${rest}` : head)
}
