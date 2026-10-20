import type { HostBox } from './boxes.js'

export interface BoxRecipe {
  id: string
  label: string
  model: string
  engine: 'ollama' | 'llamacpp'
  memoryGb: number
  downloadGb: number
  contextPerSlot?: number
  slots?: number
  files?: string[]
  revision?: string
  hashes?: Record<string, string>
  verified: { by: 'measured' | 'documented'; source: string; on?: string; note?: string }
}
const ollama = (id: string, label: string, model: string, downloadGb: number, memoryGb: number): BoxRecipe => ({ id, label, model, engine: 'ollama', memoryGb, downloadGb, verified: { by: 'documented', source: 'https://ollama.com/library/' + model, note: 'Weights fit; context and working memory are verified when the engine loads.' } })
export const BOX_RECIPES: readonly BoxRecipe[] = [
  { ...ollama('nemotron35-bolt', 'Nemotron 3.5 Bolt 74B · IQ2_XXS', 'nemotron-3.5-bolt:74b-a9b', 25, 32), contextPerSlot: 262144, verified: { by: 'measured', on: '2026-10-19', source: 'https://ollama.com/library/nemotron-3.5-bolt:74b-a9b', note: '7–11 tok/s in one measured run; upstream still labels Apple Silicon unsupported. Not a general compatibility claim.' } },
  ollama('qwen38-27b', 'Qwen3.8 27B · Q4_K_M', 'qwen3.8:27b-mtp-q4_K_M', 18, 26),
  ollama('gemma4-26b', 'Gemma 4 26B', 'gemma4:26b', 19, 28),
  ollama('gemma4-31b', 'Gemma 4 31B', 'gemma4:31b', 20, 32),
  ollama('qwen36-35b', 'Qwen3.6 35B A3B · coding', 'qwen3.6:35b-a3b-coding', 24, 32),
  { id: 'qwen38-27b-gguf', label: 'Qwen3.8 27B · GGUF Q4_K_M', model: 'unsloth/Qwen3.8-27B-GGUF', engine: 'llamacpp', memoryGb: 26, downloadGb: 17, contextPerSlot: 262144, slots: 1, files: ['Qwen3.8-27B-UD-Q4_K_M.gguf'], revision: '4ca720788d1e01f1bff70c033e0d0028fd02e502', hashes: { 'Qwen3.8-27B-UD-Q4_K_M.gguf': '322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482' }, verified: { by: 'documented', source: 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF', note: 'Metal on Apple Silicon; weights fit, runtime allocation verified at start.' } },
  { id: 'glm53-flash-gguf', label: 'GLM-5.3-Flash · GGUF UD-Q4_K_XL', model: 'unsloth/GLM-5.3-Flash-GGUF', engine: 'llamacpp', memoryGb: 200, downloadGb: 200, contextPerSlot: 131072, slots: 4, files: Array.from({ length: 6 }, (_, n) => 'UD-Q4_K_XL/GLM-5.3-Flash-UD-Q4_K_XL-' + String(n + 1).padStart(5, '0') + '-of-00006.gguf'), verified: { by: 'documented', source: 'https://unsloth.ai/docs/models/glm-5.3-flash', note: '200 GB weights requirement; additional runtime memory depends on context.' } },
]
export function boxMemory(box: HostBox): number { return box.unifiedMemory ? box.memoryGb : Math.max(box.memoryGb, ...box.gpus.map(gpu => gpu.memory)) }
export function fitsBox(recipe: BoxRecipe, box: HostBox): boolean { return boxMemory(box) >= recipe.memoryGb && (recipe.engine === 'ollama' || box.os !== 'windows' || box.engines.some(engine => engine.kind === 'llamacpp')) }
export function boxFitWords(recipe: BoxRecipe, box: HostBox): string {
  if (boxMemory(box) < recipe.memoryGb) return 'needs ' + recipe.memoryGb + ' GB; this box has ' + Math.round(boxMemory(box))
  if (!fitsBox(recipe, box)) return 'install llama-server on this Windows box first'
  return 'weights fit · ' + (box.engines.some(engine => engine.kind === recipe.engine) ? recipe.engine + ' found' : 'install ' + recipe.engine) + ' · runtime memory checked at start'
}
export function boxWeightsWords(recipe: BoxRecipe, destination: string, bank: boolean): string {
  return bank ? 'Use ' + destination + ' on this box · verify SHA256SUMS before starting; no weights download' : 'Download up to ~' + recipe.downloadGb + ' GB to ' + destination + ' on this box · ' + (recipe.engine === 'ollama' ? 'Ollama pull ' : 'hf download ') + recipe.model
}
