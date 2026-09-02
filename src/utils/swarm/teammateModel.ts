import { getDefaultMainLoopModel } from '../model/model.js'

// When the user has never set teammateDefaultModel in /config and the leader
// model is unknown, a new teammate follows the FOREGROUND default — the
// frontier-operator decision (a hardcoded constant is an accidental
// universal that drifts behind the foreground frontier; a generic
// teammate with no role reason to pin
// inherits the frontier-operator slot). Provider-awareness rides the default
// resolvers; the never-Haiku floor still applies at the spawn chokepoint.
export function getHardcodedTeammateModelFallback(): string {
  return getDefaultMainLoopModel()
}
