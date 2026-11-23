import type { Project, SidecarState } from './state.js'

export type RequireState = () => SidecarState

export type DocContext = (params: unknown) => {
  st: SidecarState
  file: string
  text: string
  project: Project
  offset: number
}
