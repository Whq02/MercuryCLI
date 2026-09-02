
export const TEAM_LEAD_NAME = 'team-lead'

export const SWARM_SESSION_NAME = 'claude-swarm'

export const SWARM_VIEW_WINDOW_NAME = 'swarm-view'

export const TMUX_COMMAND = 'tmux'

export const HIDDEN_SESSION_NAME = 'claude-hidden'

export function getSwarmSocketName(): string {
  return `claude-swarm-${process.pid}`
}

export const TEAMMATE_COMMAND_ENV_VAR = 'MERCURY_TEAMMATE_COMMAND'
export const TEAMMATE_COLOR_ENV_VAR = 'MERCURY_AGENT_COLOR'
