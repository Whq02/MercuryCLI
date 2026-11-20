import type { HealthSectionRows } from './healthReport.js'
import { identityChecks } from './sections/identity.js'
import { proofsChecks } from './sections/proofs.js'
import { gitChecks } from './sections/git.js'
import { crewChecks } from './sections/crew.js'
import { memoryChecks } from './sections/memory.js'
import { settingsChecks } from './sections/settings.js'
import { authChecks } from './sections/auth.js'
import { interfaceChecks } from './sections/interface.js'
import { runtimeChecks } from './sections/runtime.js'
import { durabilityChecks } from './sections/durability.js'
import { nativeOwnershipChecks } from './sections/native-ownership.js'
import { profileChecks } from './sections/profile.js'
import { codingLoopFastChecks } from './sections/coding-loop-fast.js'
import { fluxChecks } from './sections/flux.js'
import { toolCapabilityFastChecks } from './sections/tool-capability-fast.js'
import { architectureFastChecks } from './sections/architecture-fast.js'
import { runKernelChecks } from './sections/run-kernel.js'
import { contextLifecycleChecks } from './sections/context-lifecycle.js'
import { ideLoopChecks } from './sections/ide-loop.js'
import { axiomDeepChecks } from './sections/axiom-deep.js'
import { vanguardChecks } from './sections/vanguard.js'
import { arsenalDeepChecks } from './sections/arsenal-deep.js'

const sections: HealthSectionRows[] = [
  { id: 'identity', title: 'IDENTITY', checks: identityChecks },
  { id: 'proofs', title: 'PROOFS', checks: proofsChecks },
  { id: 'git', title: 'GIT', checks: gitChecks },
  { id: 'crew', title: 'CREW & DAEMONS', checks: crewChecks },
  { id: 'memory', title: 'MEMORY & CONTEXT', checks: memoryChecks },
  { id: 'settings', title: 'SETTINGS & FLAGS', checks: settingsChecks },
  { id: 'auth', title: 'AUTH', checks: authChecks },
  { id: 'interface', title: 'INTERFACE', checks: interfaceChecks },
  { id: 'runtime', title: 'RUNTIME', checks: runtimeChecks },
  { id: 'durability', title: 'DURABILITY', checks: durabilityChecks },
  { id: 'native-ownership', title: 'TERMINAL RUNTIME', checks: nativeOwnershipChecks },
  { id: 'profile', title: 'PROFILE', checks: profileChecks },
  { id: 'coding-loop-fast', title: 'CODING LOOP', checks: codingLoopFastChecks },
  { id: 'flux', title: 'TERMINAL FLUIDITY', checks: fluxChecks },
  { id: 'tool-capability-fast', title: 'TOOL CAPABILITY', checks: toolCapabilityFastChecks },
  { id: 'architecture-fast', title: 'ARCHITECTURE PRIMITIVES', checks: architectureFastChecks },
  { id: 'run-kernel', title: 'AUTONOMOUS RUN', checks: runKernelChecks },
  { id: 'context-lifecycle', title: 'CONTEXT', checks: contextLifecycleChecks },
  { id: 'ide-loop', title: 'IDE LOOP', checks: ideLoopChecks },
  { id: 'axiom-deep', title: 'ARCHITECTURE', checks: axiomDeepChecks },
  { id: 'vanguard', title: 'CODING LOOP', checks: vanguardChecks },
  { id: 'arsenal-deep', title: 'TOOL CAPABILITY', checks: arsenalDeepChecks },
]

export const HEALTH_SECTIONS: readonly Readonly<HealthSectionRows>[] = Object.freeze(sections.map(section => Object.freeze(section)))
