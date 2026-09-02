import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { SessionSkillsDial } from '../../components/skills/SessionSkillsDial.js';
import { SkillsMenu } from '../../components/skills/SkillsMenu.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  const { hasFocusedSession } = await import('../../services/engine-connector/focusedConnector.js');
  if (hasFocusedSession()) {
    return <SessionSkillsDial onExit={onDone} />;
  }
  return <SkillsMenu onExit={onDone} commands={context.options.commands} />;
}
