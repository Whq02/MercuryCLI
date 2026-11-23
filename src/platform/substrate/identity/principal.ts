export interface Principal {
  id: string
  kind: 'operator' | 'guest' | 'agent'
  name?: string
}
