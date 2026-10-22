import { isIP } from 'node:net'
import { runpodOnly } from './vendors/client.js'
import type { HostVendor } from './vendors/vendor.js'
import { HostCreateError } from './vendors/http.js'
import { setTimeout as delay } from 'node:timers/promises'
import { RunpodClient, cents, clusterCreateRefusal, createRefusal, type HostCluster, type HostClusterPod, type HostOffer, type HostPod, type HostVolumeMount } from './runpod.js'
import { recipeFits, type HostRecipe } from './recipes.js'
import { hostNotice } from './notices.js'
import { patchHostRecord, readHostRecord, type HostRecord } from './store.js'
import { sshArguments, startHostEngine, waitHostEngine, type HostRunner, type SshTarget } from './ssh.js'
import { hostJobReadOnly, HostTerminationUnconfirmed, type HostReadOnly } from './retry.js'

export class HostClusterEnded extends Error {}
const clusterPlacementMs = 30 * 60_000
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"

export const hostShape = (recipe: HostRecipe): string => ((recipe.nodes ?? 1) > 1 ? recipe.nodes + ' nodes × ' : '') + recipe.count + '× ' + recipe.gpu
export const hostCreateRefusal = (recipe: HostRecipe, error: unknown) => error instanceof HostCreateError && error.outcome === 'refused' ? { status: error.status, detail: error.message, retryAfterSeconds: undefined } : (recipe.nodes ?? 1) > 1 ? clusterCreateRefusal(error) : createRefusal(error)
export const hostResourceKind = (recipe: HostRecipe): string => (recipe.nodes ?? 1) > 1 ? 'cluster' : 'pod'
export const hostClusterRecord = (pod: HostPod): Pick<HostRecord, 'cluster' | 'nodes'> => pod.family ? { cluster: pod.family, nodes: pod.nodes ?? [] } : {}
export const hostResourceLabel = (pod: HostPod): string => pod.name + (pod.family ? ' · ' + pod.family.compute.podCount + ' nodes × ' + pod.family.compute.gpuCountPerPod + '× ' + pod.family.compute.gpuTypeId.replace(/^NVIDIA /, '') : '')

function familyPod(cluster: HostCluster, nodes: HostClusterPod[], price?: number): HostPod {
  const all = nodes.length === cluster.compute.podCount
  const status = nodes.some(node => node.status === 'ERROR') ? 'ERROR' : all && nodes.every(node => node.status === 'RUNNING') ? 'RUNNING' : all && nodes.every(node => node.status === 'EXITED') ? 'EXITED' : 'PROVISIONING'
  return { id: cluster.id, name: cluster.name, status, cost: all ? nodes.reduce((sum, node) => sum + node.cost, 0) : price ?? nodes.reduce((sum, node) => sum + node.cost, 0), createdAt: cluster.createdAt, family: cluster, nodes }
}

export async function createHostResource(api: RunpodClient | HostVendor, offer: HostOffer, publicKey: string, name: string, volume?: HostVolumeMount): Promise<HostPod> {
  if (volume) runpodOnly(api, 'Network and global volumes')
  if ((offer.recipe.nodes ?? 1) === 1) return api.create(offer, publicKey, name, volume)
  if (volume) throw new Error('A kept weights disk mounts on one pod; a cluster downloads its weights on every node.')
  const client = runpodOnly(api, 'Clusters')
  const cluster = await client.createCluster(offer, publicKey, name)
  const nodes = await client.clusterPods(cluster.id).catch(() => [])
  return familyPod(cluster, nodes, offer.price)
}

export async function listHostResources(api: RunpodClient | HostVendor, signal?: AbortSignal, onIncomplete?: (words: string) => void): Promise<HostPod[]> {
  const pods = await api.pods(signal)
  if ('vendor' in api && api.vendor !== 'runpod') return pods
  try {
    const client = runpodOnly(api, 'Clusters')
    const clusters = await client.clusters(signal)
    const families = await Promise.all(clusters.map(async cluster => familyPod(cluster, await client.clusterPods(cluster.id, signal), readHostRecord(cluster.id)?.price)))
    return [...pods.filter(pod => !families.some(family => family.nodes?.some(node => node.id === pod.id))), ...families]
  } catch (error) {
    if (!onIncomplete || signal?.aborted) throw error
    onIncomplete('The cluster list is incomplete; showing standalone pods only. Check the key’s Clusters read permission. ' + String(error))
    return pods
  }
}

export async function getHostResource(api: RunpodClient | HostVendor, id: string, signal?: AbortSignal, family?: HostCluster): Promise<HostPod> {
  if (!family && !readHostRecord(id)?.cluster) return api.get(id, signal)
  const client = runpodOnly(api, 'Clusters')
  const [cluster, nodes] = await Promise.all([client.getCluster(id, signal), client.clusterPods(id, signal)])
  return familyPod(cluster, nodes, readHostRecord(id)?.price)
}

export async function terminateHostResource(api: RunpodClient | HostVendor, pod: HostPod, readOnly?: HostReadOnly): Promise<void> {
  if (pod.family) {
    const client = runpodOnly(api, 'Clusters')
    await client.terminateCluster(pod.id)
    let clusters
    try { clusters = await (readOnly ? readOnly('cluster listing', signal => client.clusters(signal)) : client.clusters()) } catch (error) { if (readOnly) throw new HostTerminationUnconfirmed('Runpod', error); throw error }
    if (clusters.some(row => row.id === pod.id)) throw new Error('Runpod accepted termination but still lists this cluster. Check it again; deletion is not yet verified.')
  } else {
    const label = 'label' in api ? api.label : 'Runpod'
    if ('vendor' in api) await api.terminate(pod.id, readOnly); else await api.terminate(pod.id)
    let pods
    try { pods = await (readOnly ? readOnly('pod listing', signal => api.pods(signal)) : api.pods()) } catch (error) { if (readOnly) throw new HostTerminationUnconfirmed(label, error); throw error }
    if (pods.some(row => row.id === pod.id && row.status !== 'TERMINATED')) throw new Error(label + ' accepted termination but still lists this pod. Check it again; deletion is not yet verified.')
  }
}

function privateIp(value?: string): value is string {
  if (!value || isIP(value) !== 4) return false
  const parts = value.split('.').map(Number)
  return parts[0] === 10 || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31 || parts[0] === 192 && parts[1] === 168
}

async function endHostCluster(api: RunpodClient, record: HostRecord, cluster: HostCluster, reason: string, detail: string, cleanupRead: HostReadOnly): Promise<never> {
  const current = readHostRecord(record.id) ?? record
  const minutes = Math.max(0, (Date.now() - Date.parse(current.startedAt)) / 60_000)
  const cost = 'about $' + (current.price * minutes / 60).toFixed(2) + ' billed over ' + Math.ceil(minutes) + ' min at $' + current.price.toFixed(2) + '/hr, storage extra'
  try {
    await terminateHostResource(api, { id: record.id, name: record.name, status: 'ERROR', cost: current.price, createdAt: current.startedAt, family: cluster }, cleanupRead)
  } catch (error) {
    if (error instanceof HostTerminationUnconfirmed) throw error
    throw new Error('Cluster ' + record.id + ' ' + reason + '. Terminating it failed, so it still bills $' + current.price.toFixed(2) + '/hr · ' + cost + ' · /llmhost → Pods I’m paying for → Terminate · ' + String(error) + (detail ? ' · ' + detail : ''))
  }
  throw new HostClusterEnded('Cluster ' + record.id + ' ' + reason + '. Mercury terminated it through the clusters API and Runpod no longer lists it · ' + cost + (detail ? ' · ' + detail : ''))
}

export async function startHostCluster(api: RunpodClient, record: HostRecord, recipe: HostRecipe, runner: HostRunner, signal: AbortSignal, pauseMs: number, timeoutMs: number, onStep: (step: string) => void, onHead: (target: SshTarget) => void = () => {}): Promise<SshTarget> {
  const deadline = Date.now() + timeoutMs
  const readOnly = hostJobReadOnly({ label: 'Runpod', pauseMs, timeoutMs, signal, deadline, mark: onStep })
  const cleanupRead = hostJobReadOnly({ label: 'Runpod', pauseMs, timeoutMs, signal, mark: onStep })
  const cluster = await readOnly('cluster', readSignal => api.getCluster(record.id, readSignal))
  if (cluster.compute.podCount !== recipe.nodes || cluster.compute.gpuCountPerPod !== recipe.count || !recipeFits(recipe, cluster.compute.gpuTypeId, recipe.vramGb, cluster.compute.gpuCountPerPod, cluster.compute.podCount)) throw new Error('The cluster shape does not match the saved recipe.')
  const placementMs = Math.min(timeoutMs, clusterPlacementMs)
  const placed = Date.now() + placementMs
  let last = 'Cluster nodes have not all received private addresses and SSH access.'
  let rated = false
  while (!signal.aborted && Date.now() < placed) {
    const nodes = (await readOnly('cluster node', readSignal => api.clusterPods(record.id, readSignal))).sort((a, b) => (a.cluster.rank ?? Infinity) - (b.cluster.rank ?? Infinity))
    patchHostRecord(record.id, { nodes, cluster })
    const failed = nodes.find(node => ['ERROR', 'EXITED', 'TERMINATED'].includes(node.status))
    if (failed) await endHostCluster(api, record, cluster, 'lost node ' + failed.id + ' (' + failed.status + ') before setup began', await readOnly('log', readSignal => api.logs(failed.id, readSignal)), cleanupRead)
    if (nodes.length === recipe.nodes && nodes.every((node, rank) => node.cluster.id === cluster.id && node.cluster.rank === rank && privateIp(node.cluster.ip) && node.status === 'RUNNING' && node.ssh?.direct)) {
      const billed = nodes.reduce((sum, node) => sum + node.cost, 0)
      const confirmed = readHostRecord(record.id)
      if (!rated && billed > 0 && confirmed && cents(billed) !== cents(confirmed.price)) {
        const repriced = patchHostRecord(record.id, { price: billed })
        if (repriced && cents(billed) > cents(confirmed.price)) hostNotice(repriced, 'rate', repriced.name + ' · Runpod bills this cluster at $' + billed.toFixed(2) + '/hr, above the $' + confirmed.price.toFixed(2) + '/hr catalogue figure that was confirmed · setup continues · /llmhost → Pods I’m paying for → Terminate stops it')
      }
      rated = true
      const targets = nodes.map(node => ({ host: node.ssh!.direct!.host, port: node.ssh!.direct!.port, user: node.ssh!.direct!.username, key: record.sshKey ?? record.target?.key }))
      const floor = recipe.cuda.split('.').map(Number)
      for (const node of nodes) {
        const cuda = node.cudaVersion?.split('.').map(Number)
        if (!cuda || cuda[0]! < floor[0]! || cuda[0] === floor[0] && cuda[1]! < floor[1]!) await endHostCluster(api, record, cluster, 'was placed on node ' + node.id + ' reporting CUDA ' + (node.cudaVersion ?? 'unknown') + ', below the recipe’s ' + recipe.cuda, '', cleanupRead)
      }
      try { await Promise.all(targets.map(target => runner.run('ssh', [...sshArguments(target), 'true'], signal))) } catch (error) { last = String(error); await delay(pauseMs, undefined, { signal }); continue }
      const head = nodes[0]!.cluster.ip!
      onHead(targets[0]!)
      onStep('installing on ' + nodes.length + ' nodes')
      await Promise.all(targets.map((target, rank) => startHostEngine(target, recipe, runner, signal, false, true, undefined, undefined, { nodes: nodes.length, rank, head, address: nodes[rank]!.cluster.ip! })))
      onStep('waiting for cluster head ' + head)
      const dir = '/workspace/mercury-host/' + recipe.id
      for (;;) {
        try {
          await waitHostEngine(targets[0]!, recipe, runner, signal, pauseMs, Math.max(1, Math.min(deadline - Date.now(), pauseMs * 12)))
          return targets[0]!
        } catch (error) {
          if (signal.aborted || Date.now() >= deadline || !String(error).includes('Engine not ready.')) throw error
        }
        for (const [rank, target] of targets.entries()) {
          if (rank === 0) continue
          const state = await runner.run('ssh', [...sshArguments(target), 'if kill -0 "$(cat ' + quote(dir + '/engine.pid') + ')" 2>/dev/null; then echo MERCURY_ENGINE_ALIVE; else echo MERCURY_ENGINE_GONE; tail -n 12 ' + quote(dir + '/engine.log') + '; fi'], signal).catch(() => '')
          if (/^MERCURY_ENGINE_GONE\b/m.test(state)) throw new Error('Cluster node ' + nodes[rank]!.id + ' (rank ' + rank + ') stopped its engine, so the head cannot finish loading. ' + state.replace(/^MERCURY_ENGINE_GONE\b/m, '').trim())
        }
      }
    }
    await delay(pauseMs, undefined, { signal })
  }
  signal.throwIfAborted()
  return endHostCluster(api, record, cluster, 'did not bring all ' + recipe.nodes + ' nodes up with SSH within ' + Math.max(1, Math.round(placementMs / 60_000)) + ' min', last, cleanupRead)
}
