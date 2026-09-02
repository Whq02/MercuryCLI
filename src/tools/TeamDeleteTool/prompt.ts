import { displayConfigHome } from '../../utils/envUtils.js'
export function getPrompt(): string {
  return `
# TeamDelete

Tear down the team and task directories once the swarm work is done.

This operation:
- Deletes the team directory (\`${displayConfigHome()}/teams/{team-name}/\`)
- Deletes the task directory (\`${displayConfigHome()}/tasks/{team-name}/\`)
- Drops the session's team context

**IMPORTANT**: TeamDelete refuses while any member is still active. Shut teammates down gracefully first, and call TeamDelete only once every member has exited.

The moment for it: every teammate has finished and the team's resources should go. The team name derives from the session's own team context.
`.trim()
}
