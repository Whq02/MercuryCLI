export type NpmDistTags = {
  latest: string | null
  stable: string | null
}

export async function getNpmDistTags(): Promise<NpmDistTags> {
  return { latest: null, stable: null }
}

export async function getGcsDistTags(): Promise<NpmDistTags> {
  return { latest: null, stable: null }
}
