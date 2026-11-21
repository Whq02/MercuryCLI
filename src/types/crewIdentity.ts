export type CrewAgentId = string & { readonly __brand: 'CrewAgentId' }

export type ActorRefV1 =
  | { kind: 'agent'; agentId: CrewAgentId }
  | { kind: 'operator' | 'guest'; principalId: string }
