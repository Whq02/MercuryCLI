import { randomBytes } from 'node:crypto'

/**
 * Random word-slug generation for plan ids. The word lists are expression,
 * not contract — nothing downstream parses a slug back into words; they
 * only need to be lowercase, hyphen-joined and pleasant to read. The
 * membership is Mercury's own curation, cut whole and
 * pinned by the identity suite's footprint prover: grow it freely, revert
 * it never.
 */

// Plain and craft adjectives beside a computing-flavoured band.
const ADJECTIVES = [
  'able', 'acyclic', 'adaptive', 'affine', 'airy', 'aligned', 'amber', 'amortized', 'ample', 'applicative',
  'apricot', 'associative', 'auburn', 'autumn', 'azure', 'balanced', 'balmy', 'batched', 'bitwise', 'blissful',
  'blithe', 'bold', 'bonny', 'boolean', 'bounded', 'branchless', 'brave', 'briny', 'brisk', 'bronzed',
  'buffered', 'buoyant', 'burnished', 'candid', 'canonical', 'carefree', 'checksummed', 'cheery', 'chunked', 'citrine',
  'clear', 'coalesced', 'commutative', 'compiled', 'composable', 'congruent', 'constant', 'contiguous', 'convergent', 'cool',
  'cordial', 'cosy', 'crimson', 'crisp', 'cyclic', 'dandy', 'daring', 'debounced', 'decoupled', 'deft',
  'deterministic', 'dewy', 'digital', 'distributive', 'doughty', 'dulcet', 'early', 'earnest', 'easeful', 'easy',
  'elastic', 'elated', 'emerald', 'encoded', 'ephemeral', 'fabled', 'factored', 'fair', 'fault-tolerant', 'fearless',
  'feathered', 'fervent', 'festive', 'finite', 'flaxen', 'fleet', 'floral', 'fond', 'forthright', 'freehand',
  'frosty', 'gallant', 'gilded', 'glad', 'gladsome', 'glassy', 'gleeful', 'gossamer', 'grand', 'halcyon',
  'hale', 'hardy', 'hazel', 'hearty', 'hermetic', 'heuristic', 'hoisted', 'homespun', 'honest', 'honeyed',
  'hushed', 'indigo', 'inductive', 'injective', 'inline', 'integral', 'interned', 'invariant', 'isomorphic', 'ivory',
  'jade', 'jubilant', 'keyed', 'kindled', 'lambent', 'latched', 'leafy', 'limber', 'lissom', 'lithe',
  'lofty', 'lossless', 'lossy', 'loyal', 'lucid', 'lunar', 'lush', 'lustrous', 'madcap', 'mapped',
  'marbled', 'masked', 'mild', 'minty', 'mirthful', 'modest', 'monadic', 'monotonic', 'moonlit', 'nifty',
  'nimble', 'normalized', 'nullable', 'oaken', 'offhand', 'opal', 'opaline', 'optimal', 'ordered', 'orthogonal',
  'packed', 'paged', 'pale', 'partial', 'peachy', 'pearly', 'pebbled', 'peppy', 'perky', 'pipelined',
  'piquant', 'placid', 'plucky', 'plumed', 'poised', 'pooled', 'portable', 'prefixed', 'prime', 'prismatic',
  'puckish', 'quaint', 'quantized', 'quantum', 'queued', 'quick', 'quirky', 'rainy', 'reduced', 'reentrant',
  'reflexive', 'rehashed', 'relational', 'resolute', 'resumable', 'retryable', 'ringing', 'roomy', 'rounded', 'russet',
  'rustic', 'sable', 'saffron', 'sandy', 'saturating', 'scalar', 'scarlet', 'seaborne', 'seasoned', 'seeded',
  'sharded', 'signed', 'silent', 'silken', 'silver', 'sincere', 'skylit', 'sleek', 'snappy', 'snowy',
  'solar', 'sparse', 'spirited', 'spliced', 'spry', 'stable', 'stackless', 'staged', 'stalwart', 'starlit',
  'stellar', 'still', 'stochastic', 'stormy', 'streaming', 'strict', 'striped', 'sturdy', 'sunlit', 'supple',
  'symbolic', 'synchronized', 'tabular', 'tail-recursive', 'tawny', 'teal', 'threaded', 'throttled', 'tidal', 'tokenized',
  'total', 'transitive', 'trusty', 'tuneful', 'twilit', 'umber', 'unary', 'unhurried', 'unrolled', 'upbeat',
  'valiant', 'variadic', 'velveteen', 'verdant', 'vernal', 'versioned', 'weighted', 'willowy', 'windowed', 'windswept',
  'windy', 'winter', 'wintry', 'wooden', 'zeroed',
] as const

// Landscape, sky and water; creatures and instruments; metals, minerals
// and the workshop.
const NOUNS = [
  'abacus', 'accordion', 'acrobat', 'agate', 'airship', 'alcove', 'alloy', 'alp', 'alpenglow', 'amethyst',
  'anemone', 'antler', 'anvil', 'archipelago', 'argent', 'arroyo', 'ash', 'aspen', 'aster', 'atoll',
  'axolotl', 'bandicoot', 'banjo', 'basalt', 'basin', 'bassoon', 'bay', 'bayou', 'beach', 'bell',
  'bellows', 'beryl', 'bicycle', 'birch', 'bittern', 'blizzard', 'bluff', 'bobcat', 'bobolink', 'bough',
  'boulder', 'bowsprit', 'bracken', 'bramble', 'branch', 'brass', 'briar', 'brigantine', 'bronze', 'bud',
  'bugle', 'buoy', 'butte', 'butterfly', 'cairn', 'caldera', 'calliope', 'camel', 'canary', 'canoe',
  'canopy', 'cape', 'capstan', 'caracal', 'caravel', 'cardinal', 'caribou', 'carillon', 'carousel', 'catamaran',
  'cattail', 'cavern', 'cedar', 'cello', 'chamois', 'chickadee', 'chime', 'chisel', 'chrome', 'cinder',
  'cinnabar', 'clavichord', 'cliff', 'cloudbank', 'coast', 'coastline', 'cobalt', 'cockatoo', 'compass', 'condor',
  'constellation', 'copper', 'coppice', 'coracle', 'corgi', 'cormorant', 'corundum', 'cove', 'cowslip', 'crag',
  'crater', 'crest', 'cricket', 'crocus', 'crow', 'crucible', 'cub', 'cuckoo', 'curlew', 'current',
  'cygnet', 'cypress', 'dale', 'dell', 'delta', 'dew', 'dhow', 'dinghy', 'dolomite', 'dormouse',
  'downpour', 'drift', 'driftwood', 'drum', 'duck', 'dulcimer', 'dune', 'echidna', 'eddy', 'egret',
  'eider', 'elk', 'elm', 'emery', 'equinox', 'estuary', 'eyot', 'fawn', 'feldspar', 'ferret',
  'field', 'fife', 'filigree', 'firth', 'fjord', 'flare', 'flint', 'floe', 'flood', 'flower',
  'foam', 'foothill', 'forge', 'fossil', 'foxglove', 'freshet', 'frond', 'gale', 'galena', 'galleon',
  'gannet', 'garnet', 'gazelle', 'gecko', 'geyser', 'glen', 'glider', 'gloaming', 'gondola', 'gorge',
  'gorse', 'granite', 'graphite', 'grasshopper', 'grotto', 'gulf', 'gull', 'gully', 'gypsum', 'gyrfalcon',
  'handbell', 'harvest', 'hawk', 'headland', 'heath', 'heather', 'hematite', 'heron', 'hill', 'hillock',
  'hollow', 'hollyhock', 'ibex', 'ibis', 'iceberg', 'icefall', 'ingot', 'inlet', 'iridium', 'isle',
  'islet', 'ivy', 'jackdaw', 'jasper', 'jay', 'jerboa', 'juniper', 'kalimba', 'katydid', 'kayak',
  'kelp', 'kestrel', 'kiln', 'kingfisher', 'kinkajou', 'knoll', 'lakeshore', 'larch', 'lathe', 'laurel',
  'lava', 'lea', 'ledge', 'lichen', 'light', 'lily', 'lodestar', 'lodestone', 'loom', 'lorikeet',
  'lotus', 'lowland', 'lugger', 'lute', 'lyrebird', 'malachite', 'mandola', 'mandolin', 'margay', 'marimba',
  'marmot', 'marsh', 'merganser', 'mesa', 'mesquite', 'mica', 'mill', 'mistral', 'mole', 'monsoon',
  'moor', 'moorland', 'moose', 'moraine', 'moss', 'mudflat', 'muskox', 'nautilus', 'nectar', 'nightfall',
  'nightingale', 'nightjar', 'nimbus', 'nook', 'numbat', 'nutmeg', 'oak', 'oarlock', 'obsidian', 'ocarina',
  'ocelot', 'okapi', 'olivine', 'onyx', 'orca', 'orchard', 'orchid', 'oriole', 'osier', 'osmium',
  'osprey', 'oud', 'outcrop', 'overlook', 'oxbow', 'oxlip', 'paddle', 'palladium', 'palm', 'pampas',
  'pangolin', 'pass', 'patina', 'peak', 'peninsula', 'petrel', 'pewter', 'phoebe', 'piccolo', 'pika',
  'pinecone', 'pinewood', 'pintail', 'pipefish', 'pipit', 'pippin', 'plain', 'plateau', 'platinum', 'plover',
  'poppy', 'porphyry', 'prairie', 'ptarmigan', 'pulsar', 'pumice', 'pyrite', 'quartzite', 'quokka', 'quoll',
  'rapids', 'ravine', 'redstart', 'redwood', 'reindeer', 'rhodium', 'ridge', 'rill', 'rivet', 'rock',
  'rockpool', 'rooster', 'root', 'rowan', 'rowboat', 'saddle', 'sagebrush', 'sailboat', 'saltmarsh', 'sampan',
  'sand', 'sandbar', 'sandgrouse', 'sandpiper', 'sandstone', 'sapling', 'sapphire', 'savanna', 'sea', 'seagrass',
  'seamount', 'sedge', 'serval', 'shade', 'shale', 'shearwater', 'shingle', 'shoal', 'shrub', 'sierra',
  'sitar', 'skerry', 'skiff', 'skink', 'slate', 'sled', 'sleet', 'sloop', 'slope', 'smithy',
  'snow', 'snowmelt', 'solder', 'solstice', 'sorrel', 'spinel', 'sprig', 'springtide', 'spyglass', 'starling',
  'steppe', 'sterling', 'stoat', 'stone', 'stonechat', 'stonecrop', 'stork', 'strait', 'sunbird', 'sundew',
  'sunshower', 'surf', 'swale', 'swallow', 'swell', 'tailwind', 'tamarin', 'tanager', 'tantalum', 'tarn',
  'tern', 'thaw', 'theremin', 'thicket', 'thistle', 'tidepool', 'timber', 'toboggan', 'topaz', 'tourmaline',
  'trail', 'travertine', 'tree', 'treeline', 'trellis', 'tributary', 'trimaran', 'trolley', 'trout', 'tuatara',
  'tugboat', 'tundra', 'tungsten', 'turnstone', 'turquoise', 'ukulele', 'vale', 'vapor', 'vaquita', 'vermeil',
  'vine', 'viola', 'vole', 'wagtail', 'wallaby', 'warbler', 'waterline', 'wavelet', 'waxwing', 'weasel',
  'weathervane', 'wellspring', 'wetland', 'whetstone', 'whimbrel', 'wildflower', 'willowherb', 'windlass', 'wintergreen', 'wood',
  'woodland', 'woodlark', 'xebec', 'yak', 'yarrow', 'yawl', 'zenith', 'zeppelin', 'zircon', 'zither',
] as const

// Unhurried gerunds.
const VERBS = [
  'ambling', 'angling', 'banking', 'basking', 'blooming', 'bobbing', 'bounding', 'braiding', 'breezing', 'brewing',
  'bridging', 'brightening', 'budding', 'canoeing', 'caroling', 'charting', 'chiming', 'chirping', 'chugging', 'clambering',
  'coasting', 'cobbling', 'cresting', 'curling', 'cycling', 'darting', 'dashing', 'doodling', 'dovetailing', 'dozing',
  'drumming', 'easing', 'ebbing', 'echoing', 'etching', 'fathoming', 'ferrying', 'fledging', 'flitting', 'flocking',
  'flowing', 'foraging', 'fording', 'furling', 'galloping', 'gardening', 'gazing', 'gleaning', 'glinting', 'grazing',
  'gusting', 'hatching', 'hiking', 'homing', 'honing', 'huddling', 'inking', 'jesting', 'jigging', 'journeying',
  'kayaking', 'kneading', 'lacing', 'larking', 'lilting', 'listening', 'lofting', 'looping', 'loping', 'lulling',
  'marveling', 'mending', 'migrating', 'mingling', 'moseying', 'mulling', 'munching', 'murmuring', 'nesting', 'nodding',
  'nuzzling', 'orbiting', 'panning', 'parading', 'pattering', 'pedaling', 'perching', 'piping', 'plaiting', 'playing',
  'pottering', 'preening', 'questing', 'quilting', 'rafting', 'rambling', 'ranging', 'reeling', 'roosting', 'roving',
  'rowing', 'running', 'rushing', 'sailing', 'saluting', 'sauntering', 'scaling', 'scampering', 'schooling', 'scudding',
  'sculling', 'shoaling', 'simmering', 'skating', 'sketching', 'sleighing', 'sliding', 'smiling', 'snoozing', 'sounding',
  'splicing', 'springing', 'sprinting', 'steeping', 'stitching', 'striding', 'strumming', 'summiting', 'sunning', 'surfing',
  'surging', 'swaying', 'swooping', 'tacking', 'tallying', 'tending', 'threading', 'thriving', 'tilling', 'tinkering',
  'touring', 'trekking', 'trilling', 'trotting', 'trundling', 'tunneling', 'twining', 'vaulting', 'veering', 'venturing',
  'volleying', 'voyaging', 'wading', 'waltzing', 'warbling', 'waving', 'wayfaring', 'wheeling', 'whittling', 'winding',
  'winnowing', 'wintering', 'wreathing', 'yodeling',
] as const

/** Uniform-ish cryptographic pick: four random bytes as a big-endian u32, reduced modulo the list length (the modulo bias is accepted). */
function pickWord(list: readonly string[]): string {
  const index = randomBytes(4).readUInt32BE(0) % list.length
  return list[index] as string
}

/** `adjective-verb-noun`, always lowercase with single hyphens. */
export function generateWordSlug(): string {
  return `${pickWord(ADJECTIVES)}-${pickWord(VERBS)}-${pickWord(NOUNS)}`
}
