
import type { ContentBlockParam } from '../../types/wire.js'
import type { Command } from '../../commands.js'
import { getCwd } from '../../utils/cwd.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { listWorkflows } from './registry.js'
import type { WorkflowDescriptor } from './registry.js'
import { dynamicWorkflowsEnabled } from './workflowEnablement.js'

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

export async function getWorkflowCommands(
  _context?: unknown,
): Promise<Command[]> {
  if (!dynamicWorkflowsEnabled()) return []
  const all = await listWorkflows(getCwd())
  return all.filter(wf => !wf.hidden).map(createWorkflowCommand)
}
