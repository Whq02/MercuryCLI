import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { RunpodClient, clusterCreateRefusal, createRefusal, type HostCluster, type HostClusterPod, type HostOffer, type HostPod } from './runpod.js'
import { recipeFits, type HostRecipe } from './recipes.js'
import { patchHostRecord, readHostRecord, type HostRecord } from './store.js'
import { sshArguments, startHostEngine, waitHostEngine, type HostRunner, type SshTarget } from './ssh.js'

export const hostShape = (recipe: HostRecipe): string => ((recipe.nodes ?? 1) > 1 ? recipe.nodes + ' nodes × ' : '') + recipe.count + '× ' + recipe.gpu
export const hostCreateRefusal = (recipe: HostRecipe, error: unknown) => (recipe.nodes ?? 1) > 1 ? clusterCreateRefusal(error) : createRefusal(error)
export const hostResourceKind = (recipe: HostRecipe): string => (recipe.nodes ?? 1) > 1 ? 'cluster' : 'pod'
export const hostClusterRecord = (pod: HostPod): Pick<HostRecord, 'cluster' | 'nodes'> => pod.family ? { cluster: pod.family, nodes: pod.nodes ?? [] } : {}
export const hostResourceLabel = (pod: HostPod): string => pod.name + (pod.family ? ' · ' + pod.family.compute.podCount + ' nodes × ' + pod.family.compute.gpuCountPerPod + '× ' + pod.family.compute.gpuTypeId.replace(/^NVIDIA /, '') : '')

function familyPod(cluster: HostCluster, nodes: HostClusterPod[], price?: number): HostPod {
  const all = nodes.length === cluster.compute.podCount
  const status = nodes.some(node => node.status === 'ERROR') ? 'ERROR' : all && nodes.every(node => node.status === 'RUNNING') ? 'RUNNING' : all && nodes.every(node => node.status === 'EXITED') ? 'EXITED' : 'PROVISIONING'
  return { id: cluster.id, name: cluster.name, status, cost: all ? nodes.reduce((sum, node) => sum + node.cost, 0) : price ?? nodes.reduce((sum, node) => sum + node.cost, 0), createdAt: cluster.createdAt, family: cluster, nodes }
}

export async function createHostResource(api: RunpodClient, offer: HostOffer, publicKey: string, name: string): Promise<HostPod> {
  if ((offer.recipe.nodes ?? 1) === 1) return api.create(offer, publicKey, name)
  const cluster = await api.createCluster(offer, publicKey, name)
  const nodes = await api.clusterPods(cluster.id).catch(() => [])
  return familyPod(cluster, nodes, offer.price)
}

export async function listHostResources(api: RunpodClient, signal?: AbortSignal, onIncomplete?: (words: string) => void): Promise<HostPod[]> {
  const pods = await api.pods(signal)
  try {
    const clusters = await api.clusters(signal)
    const families = await Promise.all(clusters.map(async cluster => familyPod(cluster, await api.clusterPods(cluster.id, signal), readHostRecord(cluster.id)?.price)))
    return [...pods.filter(pod => !families.some(family => family.nodes?.some(node => node.id === pod.id))), ...families]
  } catch (error) {
    if (!onIncomplete || signal?.aborted) throw error
    onIncomplete('The cluster list is incomplete; showing standalone pods only. Check the key’s Clusters read permission. ' + String(error))
    return pods
  }
}

export async function getHostResource(api: RunpodClient, id: string, signal?: AbortSignal, family?: HostCluster): Promise<HostPod> {
  if (!family && !readHostRecord(id)?.cluster) return api.get(id, signal)
  const [cluster, nodes] = await Promise.all([api.getCluster(id, signal), api.clusterPods(id, signal)])
  return familyPod(cluster, nodes, readHostRecord(id)?.price)
}

export async function terminateHostResource(api: RunpodClient, pod: HostPod): Promise<void> {
  if (pod.family) {
    await api.terminateCluster(pod.id)
    if ((await api.clusters()).some(row => row.id === pod.id)) throw new Error('Runpod accepted termination but still lists this cluster. Check it again; deletion is not yet verified.')
  } else {
    await api.terminate(pod.id)
    if ((await api.pods()).some(row => row.id === pod.id)) throw new Error('Runpod accepted termination but still lists this pod. Check it again; deletion is not yet verified.')
  }
}

function privateIp(value?: string): value is string {
  if (!value || isIP(value) !== 4) return false
  const parts = value.split('.').map(Number)
  return parts[0] === 10 || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31 || parts[0] === 192 && parts[1] === 168
}

export async function startHostCluster(api: RunpodClient, record: HostRecord, recipe: HostRecipe, runner: HostRunner, signal: AbortSignal, pauseMs: number, timeoutMs: number, onStep: (step: string) => void): Promise<SshTarget> {
  const cluster = await api.getCluster(record.id, signal)
  if (cluster.compute.podCount !== recipe.nodes || cluster.compute.gpuCountPerPod !== recipe.count || !recipeFits(recipe, cluster.compute.gpuTypeId, recipe.vramGb, cluster.compute.gpuCountPerPod, cluster.compute.podCount)) throw new Error('The cluster shape does not match the saved recipe.')
  const deadline = Date.now() + timeoutMs
  let last = 'Cluster nodes have not all received private addresses and SSH access.'
  while (!signal.aborted && Date.now() < deadline) {
    const nodes = (await api.clusterPods(record.id, signal)).sort((a, b) => (a.cluster.rank ?? Infinity) - (b.cluster.rank ?? Infinity))
    patchHostRecord(record.id, { nodes, cluster })
    const failed = nodes.find(node => ['ERROR', 'EXITED', 'TERMINATED'].includes(node.status))
    if (failed) throw new Error('Cluster node ' + failed.id + ' is ' + failed.status + '. ' + await api.logs(failed.id))
    if (nodes.length === recipe.nodes && nodes.every((node, rank) => node.cluster.id === cluster.id && node.cluster.rank === rank && privateIp(node.cluster.ip) && node.status === 'RUNNING' && node.ssh?.direct)) {
      const targets = nodes.map(node => ({ host: node.ssh!.direct!.host, port: node.ssh!.direct!.port, user: node.ssh!.direct!.username, key: record.sshKey ?? record.target?.key }))
      const floor = recipe.cuda.split('.').map(Number)
      for (const node of nodes) {
        const cuda = node.cudaVersion?.split('.').map(Number)
        if (!cuda || cuda[0]! < floor[0]! || cuda[0] === floor[0] && cuda[1]! < floor[1]!) throw new Error('Cluster node ' + node.id + ' does not report CUDA ' + recipe.cuda + ' or later. The cluster is still billable; terminate it or choose a compatible placement.')
      }
      try { await Promise.all(targets.map(target => runner.run('ssh', [...sshArguments(target), 'true'], signal))) } catch (error) { last = String(error); await delay(pauseMs, undefined, { signal }); continue }
      const head = nodes[0]!.cluster.ip!
      onStep('installing on ' + nodes.length + ' nodes')
      await Promise.all(targets.map((target, rank) => startHostEngine(target, recipe, runner, signal, false, true, undefined, { nodes: nodes.length, rank, head, address: nodes[rank]!.cluster.ip! })))
      onStep('waiting for cluster head ' + head)
      await waitHostEngine(targets[0]!, recipe, runner, signal, pauseMs, Math.max(1, deadline - Date.now()))
      return targets[0]!
    }
    await delay(pauseMs, undefined, { signal })
  }
  signal.throwIfAborted()
  throw new Error(last)
}
