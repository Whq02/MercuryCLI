import * as React from 'react';
import type { LocalJSXCommandContext } from '../catalogue/commands.js';
import { SessionSkillsDial } from '../../screen/skills/SessionSkillsDial.js';
import { SkillsMenu } from '../../screen/skills/SkillsMenu.js';
import type { LocalJSXCommandOnDone } from '../catalogue/command.js';

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  const { hasFocusedSession } = await import('../../engine/connector/focusedConnector.js');
  if (hasFocusedSession()) {
    return <SessionSkillsDial onExit={onDone} />;
  }
  return <SkillsMenu onExit={onDone} commands={context.options.commands} />;
}
