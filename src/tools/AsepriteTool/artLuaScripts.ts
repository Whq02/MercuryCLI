export const SPRITE_ART_LUA = String.raw`
local f = assert(io.open(app.params.request, 'rb'))
local p = json.decode(f:read('*a'))
f:close()
local spr = assert(app.activeSprite, 'no sprite opened')
local function layerAt(name)
  local found = nil
  local function walk(layers, prefix)
    for _, layer in ipairs(layers) do
      local full = prefix .. layer.name
      if full == name then
        assert(found == nil, 'ambiguous layer: ' .. name)
        found = layer
      end
      if layer.isGroup then walk(layer.layers, full .. '/') end
    end
  end
  walk(spr.layers, '')
  return assert(found, 'no layer: ' .. name)
end
local function frameAt(n)
  return assert(spr.frames[n + 1], 'no frame: ' .. n)
end
local function paletteAt(n)
  local pal = spr.palettes[1]
  for i=1,#spr.palettes do
    local candidate = spr.palettes[i]
    if candidate.frame.frameNumber <= n + 1 then pal = candidate end
  end
  return pal
end
local function colourAt(c, frame)
  local pal = paletteAt(frame)
  if c.index ~= nil then
    assert(c.index < #pal, 'palette index out of range: ' .. c.index)
    if spr.colorMode == ColorMode.INDEXED then return Color{index=c.index} end
    return pal:getColor(c.index)
  end
  local colour = Color{r=c.r, g=c.g, b=c.b, a=c.a or 255}
  if spr.colorMode == ColorMode.INDEXED then
    for i=0,#pal-1 do
      if pal:getColor(i).rgbaPixel == colour.rgbaPixel then return Color{index=i} end
    end
    error('RGBA colour is outside the indexed palette; use a palette index or an exact palette colour')
  end
  return colour
end
local function draw()
  spr.selection:deselect()
  app.preferences.symmetry_mode.enabled = false
  app.preferences.document(spr).tiled.mode = 0
  local bucket = app.preferences.tool('paint_bucket')
  bucket.floodfill.pixel_connectivity = 0
  bucket.floodfill.stop_at_grid = 0
  bucket.floodfill.refer_to = 0
  local names = {pixel='pencil', line='line', rect='rectangle', ellipse='ellipse', circle='ellipse', ['flood-fill']='paint_bucket'}
  for _, op in ipairs(p.ops) do
    local layer = layerAt(op.layer)
    assert(layer.isImage and not layer.isTilemap, 'drawing needs an image layer: ' .. op.layer)
    assert(layer.isEditable, 'layer is locked: ' .. op.layer)
    local frame = frameAt(op.frame)
    app.activeFrame = frame
    local x, y, x2, y2 = op.x, op.y, op.x2, op.y2
    if op.kind == 'circle' then
      x, y, x2, y2 = x-op.radius, y-op.radius, x+op.radius, y+op.radius
    end
    assert(x >= 0 and y >= 0 and x < spr.width and y < spr.height, 'point outside canvas')
    local points = {Point(x, y)}
    if x2 ~= nil then
      assert(x2 >= 0 and y2 >= 0 and x2 < spr.width and y2 < spr.height, 'point outside canvas')
      points[2] = Point(x2, y2)
    end
    local tool = names[op.kind]
    if op.fill then tool = 'filled_' .. tool end
    app.useTool{tool=tool, layer=layer, frame=frame, color=colourAt(op.colour, op.frame),
      brush=Brush(1), ink=Ink.SIMPLE, opacity=255, tolerance=0, contiguous=true,
      freehandAlgorithm=0, points=points}
  end
  return {op=p.op, applied=#p.ops}
end
local function render()
  local first, last = 0, #spr.frames - 1
  if p.frame ~= nil then
    frameAt(p.frame)
    first, last = p.frame, p.frame
  elseif p.tag ~= nil then
    local found = nil
    for _, tag in ipairs(spr.tags) do
      if tag.name == p.tag then
        assert(found == nil, 'ambiguous tag: ' .. p.tag)
        found = tag
      end
    end
    assert(found, 'no tag: ' .. p.tag)
    first, last = found.fromFrame.frameNumber - 1, found.toFrame.frameNumber - 1
  end
  local image = Image(spr.width * (last-first+1), spr.height, ColorMode.RGB)
  image:clear()
  local frames = {}
  for frame=first,last do
    image:drawSprite(spr, frame+1, Point((frame-first)*spr.width, 0))
    frames[#frames+1] = frame
  end
  local scale = p.scale or 1
  if scale ~= 1 then image:resize(image.width * scale, image.height * scale) end
  assert(image:saveAs(p.render), 'PNG render failed')
  return {width=image.width, height=image.height, frames=frames}
end
local report = {op=p.op}
if p.op == 'draw' then
  app.transaction(function() report = draw() end)
end
if p.render then report.render = render() end
if p.save then assert(spr:saveAs(p.save), 'sprite save failed') end
local out = assert(io.open(p.report, 'wb'))
out:write(json.encode(report))
out:close()
`
