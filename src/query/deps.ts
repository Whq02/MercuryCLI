import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type QueryDeps = Unbuilt

export function productionDeps(): QueryDeps {
  return notBuilt('src/query/deps.ts:15')
}
