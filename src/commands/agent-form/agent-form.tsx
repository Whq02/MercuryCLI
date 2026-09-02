import * as React from 'react';
import { AgentStudio } from '../../components/agents/studio/AgentStudio.js';
import type { ToolUseContext } from '../../Tool.js';
import { getTools } from '../../tools.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext): Promise<React.ReactNode> {
  const appState = context.getAppState();
  const tools = getTools(appState.toolPermissionContext);
  return <AgentStudio tools={tools} initialMode="create" onExit={onDone} />;
}
