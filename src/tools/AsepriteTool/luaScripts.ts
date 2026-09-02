// ============================================================================
//  AsepriteTool/luaScripts — the two BUNDLED Lua programs the tool feeds to
//  `aseprite -b --script` (written to a private temp file per run, removed
//  after). String constants, not assets: small enough that the bundle IS
//  the pipeline, and content-fixed at build time — op:"run-script" is the
//  only road for foreign Lua and it asks permission every time. Both
//  scripts print ONE JSON line on stdout (hand-rolled escaping — the json
//  global is newer than the versions the store builds still ship, and a
//  probe must not be the thing that version-gates the door).
// ============================================================================

/** Read-only sprite census: size, mode, frames + durations, layer tree,
 *  tags, slices, palette size. Bounded (layer/tag lists capped in-script). */
export const SPRITE_PROBE_LUA = `-- Mercury sprite census probe (read-only)
local spr = app.activeSprite
if spr == nil then
  print('{"error":"no sprite opened - the probe needs the sprite file on the command line"}')
  return
end
local function esc(s)
  s = tostring(s)
  s = s:gsub('\\\\', '\\\\\\\\'):gsub('"', '\\\\"'):gsub('\\n', '\\\\n'):gsub('\\r', '\\\\r'):gsub('\\t', '\\\\t')
  return s
end
local CAP = 200
local function modeName(m)
  if m == ColorMode.RGB then return 'rgb' end
  if m == ColorMode.INDEXED then return 'indexed' end
  if m == ColorMode.GRAY then return 'gray' end
  return tostring(m)
end
local out = {}
table.insert(out, '"filename":"' .. esc(spr.filename) .. '"')
table.insert(out, '"width":' .. spr.width)
table.insert(out, '"height":' .. spr.height)
table.insert(out, '"colorMode":"' .. modeName(spr.colorMode) .. '"')
table.insert(out, '"frames":' .. #spr.frames)
local durs = {}
for i, f in ipairs(spr.frames) do
  if i > CAP then break end
  table.insert(durs, string.format('%.4f', f.duration))
end
table.insert(out, '"frameDurationsSeconds":[' .. table.concat(durs, ',') .. ']')
local layers = {}
local count = 0
local function walkLayers(list, prefix)
  for _, l in ipairs(list) do
    if count >= CAP then return end
    count = count + 1
    local kind = l.isGroup and 'group' or 'layer'
    table.insert(layers, '{"name":"' .. esc(prefix .. l.name) .. '","kind":"' .. kind .. '","visible":' .. tostring(l.isVisible) .. '}')
    if l.isGroup then walkLayers(l.layers, prefix .. l.name .. '/') end
  end
end
walkLayers(spr.layers, '')
table.insert(out, '"layers":[' .. table.concat(layers, ',') .. ']')
local tags = {}
for i, t in ipairs(spr.tags) do
  if i > CAP then break end
  local dir = tostring(t.aniDir)
  table.insert(tags, '{"name":"' .. esc(t.name) .. '","from":' .. (t.fromFrame.frameNumber - 1) .. ',"to":' .. (t.toFrame.frameNumber - 1) .. ',"aniDir":"' .. esc(dir) .. '"}')
end
table.insert(out, '"tags":[' .. table.concat(tags, ',') .. ']')
local slices = {}
for i, s in ipairs(spr.slices) do
  if i > CAP then break end
  table.insert(slices, '"' .. esc(s.name) .. '"')
end
table.insert(out, '"slices":[' .. table.concat(slices, ',') .. ']')
local okPal, pal = pcall(function() return #spr.palettes[1] end)
if okPal then table.insert(out, '"paletteSize":' .. pal) end
print('{' .. table.concat(out, ',') .. '}')
`

/** Sprite birth: Sprite(w, h, mode) saved to app.params.output. The frame
 *  numbers the CLI's own census would print start at 1; the caller verifies
 *  the file's bytes landed. */
export const SPRITE_CREATE_LUA = `-- Mercury sprite create (writes exactly app.params.output)
local p = app.params
local w = tonumber(p.width)
local h = tonumber(p.height)
if w == nil or h == nil or w < 1 or h < 1 or p.output == nil or p.output == '' then
  print('{"error":"create needs width, height and output params"}')
  return
end
local mode = ColorMode.RGB
if p.mode == 'indexed' then mode = ColorMode.INDEXED end
if p.mode == 'gray' then mode = ColorMode.GRAY end
local spr = Sprite(w, h, mode)
spr:saveAs(p.output)
print('{"created":"' .. p.output:gsub('\\\\', '\\\\\\\\'):gsub('"', '\\\\"') .. '","width":' .. w .. ',"height":' .. h .. '}')
`
