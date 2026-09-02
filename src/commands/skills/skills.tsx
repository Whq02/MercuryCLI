import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { SessionSkillsDial } from '../../components/skills/SessionSkillsDial.js';
import { SkillsMenu } from '../../components/skills/SkillsMenu.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';

/**
 * /skills IS THE FOCUSED SESSION'S DIAL (ledger L24(3)): the
 * session's own roster with per-row tri-state cycling through the one
 * connector verb — never the screen's command table (the old read-only
 * menu listed the SCREEN's estate: the two-estates confusion, skills
 * edition). The screen-table listing survives only for the resting slot
 * (no chat open — a landing edge; slash lines otherwise always run inside
 * a chat).
 */
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  const { hasFocusedSession } = await import('../../services/engine-connector/focusedConnector.js');
  if (hasFocusedSession()) {
    return <SessionSkillsDial onExit={onDone} />;
  }
  return <SkillsMenu onExit={onDone} commands={context.options.commands} />;
}
