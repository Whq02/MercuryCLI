
export class StatsHandleOwner {
  statsStore: { observe(name: string, value: number): void } | null = null
}
