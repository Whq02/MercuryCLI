export interface GitWorktreeInfo {
  path: string
  head: string
  branch: string | null
  isMain: boolean
}

export interface GitUnavailable {
  failure?: string
  state: 'unavailable'
  note: string
}
