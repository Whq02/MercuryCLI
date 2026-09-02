/**
 * Shared team/teammate names and the per-process swarm socket.
 *
 * The tmux session/window/socket names are compat seams: the banner and the
 * teams dialog tell the user to attach with these exact names.
 */

export const TEAM_LEAD_NAME = 'team-lead'

export const SWARM_SESSION_NAME = 'claude-swarm'

export const SWARM_VIEW_WINDOW_NAME = 'swarm-view'

export const TMUX_COMMAND = 'tmux'

export const HIDDEN_SESSION_NAME = 'claude-hidden'

/**
 * The private tmux socket name for external-session mode: per-process so the
 * user's own tmux sessions are untouched and concurrent Mercury instances do
 * not collide.
 */
export function getSwarmSocketName(): string {
  return `claude-swarm-${process.pid}`
}

/** Override for the binary used to launch a teammate, when set. */
export const TEAMMATE_COMMAND_ENV_VAR = 'MERCURY_TEAMMATE_COMMAND'
/** The spawned teammate's badge tint, stamped by the launching executor. */
export const TEAMMATE_COLOR_ENV_VAR = 'MERCURY_AGENT_COLOR'
