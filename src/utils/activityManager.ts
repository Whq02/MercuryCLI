function createActivityManager() {
  let lastUserActivity: number | null = null
  const active = new Set<string>()
  function endCLIActivity(id: string): void {
    active.delete(id)
  }
  function startCLIActivity(id: string): void {
    if (active.has(id)) endCLIActivity(id)
    active.add(id)
  }
  return {
    recordUserActivity() { lastUserActivity = Date.now() },
    startCLIActivity,
    endCLIActivity,
    async trackOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
      startCLIActivity(id)
      try {
        return await operation()
      } finally {
        endCLIActivity(id)
      }
    },
    getActivityStates() {
      return { isUserActive: lastUserActivity !== null && Date.now() - lastUserActivity < 5000, isCLIActive: active.size !== 0, activeOperationCount: active.size }
    },
  }
}

export const activityManager = createActivityManager()
