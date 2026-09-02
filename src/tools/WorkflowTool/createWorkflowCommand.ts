// =============================================================================
// Dynamic workflows as slash commands.
//
// Rather than one generic launcher command, each workflow the session can
// see — built-in or from a local workflows directory —
// is surfaced as its own prompt command, carrying `kind: 'workflow'` so
// pickers can badge it. Running the command produces an instruction telling
// the model to call the Workflow tool by name (with the typed arguments,
// when the user supplied any).
//
// The command catalogue's loader merge awaits `getWorkflowCommands` and folds
// the result in; while the dynamic-workflows feature is off, the fold is
// empty.
// =============================================================================

import type { ContentBlockParam } from '../../types/wire.js'
import type { Command } from '../../commands.js'
import { getCwd } from '../../utils/cwd.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { listWorkflows } from './registry.js'
import type { WorkflowDescriptor } from './registry.js'
import { dynamicWorkflowsEnabled } from './workflowEnablement.js'

// -----------------------------------------------------------------------------
// Descriptor source → command provenance. Built-ins read as bundled content,
// directory-loaded ones
// carry their settings scope with the skills-style load label.
// -----------------------------------------------------------------------------
function commandProvenance(s: WorkflowDescriptor['source']): {
  source: Extract<Command, { type: 'prompt' }>['source']
  loadedFrom: NonNullable<Command['loadedFrom']>
} {
  switch (s) {
    case 'built-in':
      return { source: 'bundled', loadedFrom: 'bundled' }
    case 'userSettings':
    case 'projectSettings':
      return { source: s, loadedFrom: 'skills' }
  }
}

/**
 * Wrap one workflow definition as a dynamic prompt command whose expansion
 * directs the model at the Workflow tool.
 */
export function createWorkflowCommand(wf: WorkflowDescriptor): Command {
  const { source, loadedFrom } = commandProvenance(wf.source)

  const command: Command = {
    type: 'prompt',
    name: wf.name,
    description: wf.description,
    hasUserSpecifiedDescription: true,
    whenToUse: wf.whenToUse,
    progressMessage: 'running dynamic workflow',
    contentLength: wf.script.length,
    source,
    loadedFrom,
    // Pickers key on this tag to append the "(dynamic workflow)" badge.
    kind: 'workflow',
    async getPromptForCommand(rawArgs: string): Promise<ContentBlockParam[]> {
      const phaseText = wf.phases?.length
        ? '\n\nPhases:\n' +
          wf.phases
            .map(p => `- ${p.title}${p.detail ? `: ${p.detail}` : ''}`)
            .join('\n')
        : ''
      const args = rawArgs.trim()
      const nameJson = JSON.stringify(wf.name)
      // The raw argument string is JSON-encoded so it survives being embedded
      // in the instruction text and arrives in the script as a string value.
      const invocation = args
        ? `{ name: ${nameJson}, args: ${JSON.stringify(args)} }`
        : `{ name: ${nameJson} }`
      return [
        {
          type: 'text',
          text:
            `Run the "${wf.name}" workflow.\n\n` +
            `${wf.description}${wf.whenToUse ? `\n\n${wf.whenToUse}` : ''}${phaseText}\n\n` +
            `Invoke: ${WORKFLOW_TOOL_NAME}(${invocation})`,
        },
      ]
    },
  }

  return command
}

/**
 * The session's workflow commands: everything the registry lists (minus
 * hidden entries), each wrapped by createWorkflowCommand — or nothing at all
 * while the feature is off. The context parameter exists to satisfy the
 * loader signature; lookup keys off the current working directory.
 */
export async function getWorkflowCommands(
  _context?: unknown,
): Promise<Command[]> {
  if (!dynamicWorkflowsEnabled()) return []
  const all = await listWorkflows(getCwd())
  return all.filter(wf => !wf.hidden).map(createWorkflowCommand)
}
