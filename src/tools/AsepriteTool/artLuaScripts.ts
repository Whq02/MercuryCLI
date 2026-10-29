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
local function editable(layer)
  local current = layer
  while current ~= spr do
    assert(current.isEditable, 'layer is locked: ' .. current.name)
    current = current.parent
  end
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
    editable(layer)
    local frame = frameAt(op.frame)
    app.activeFrame = frame
    app.activeLayer = layer
    app.range.layers = {layer}
    app.range.frames = {frame}
    app.command.UnlinkCel()
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
local function copyPart(layer, source, target)
  if layer.isGroup then
    for _, child in ipairs(layer.layers) do copyPart(child, source, target) end
    return
  end
  assert(layer.isImage and not layer.isTilemap, 'duplicate needs image layers: ' .. layer.name)
  editable(layer)
  if source == target then return end
  local cel = layer:cel(source + 1)
  local old = layer:cel(target + 1)
  if old then spr:deleteCel(old) end
  if cel then
    local copy = spr:newCel(layer, target + 1, Image(cel.image), cel.position)
    copy.opacity = cel.opacity
    copy.zIndex = cel.zIndex
  end
end
local function parts()
  for _, op in ipairs(p.ops) do
    if op.kind == 'create' then
      local parent = spr
      if op.parent then
        parent = layerAt(op.parent)
        assert(parent.isGroup and parent.isEditable, 'parent must be an editable group')
      end
      for _, child in ipairs(parent.layers) do assert(child.name ~= op.name, 'part already exists: ' .. op.name) end
      local layer = op.group and spr:newGroup() or spr:newLayer()
      layer.name = op.name
      layer.parent = parent
    else
      local layer = layerAt(op.part)
      if op.kind == 'show' then layer.isVisible = true
      elseif op.kind == 'hide' then layer.isVisible = false
      elseif op.kind == 'reorder' then
        assert(op.index < #layer.parent.layers, 'part index out of range')
        layer.stackIndex = op.index + 1
      elseif op.kind == 'duplicate' then
        frameAt(op.fromFrame)
        for _, target in ipairs(op.toFrames) do
          while #spr.frames <= target do spr:newEmptyFrame() end
          copyPart(layer, op.fromFrame, target)
        end
      end
    end
  end
  return {op=p.op, applied=#p.ops}
end
local function describe()
  local rows = {}
  local function walk(layers, prefix)
    for _, layer in ipairs(layers) do
      local name = prefix .. layer.name
      local row = {path=name, kind=layer.isGroup and 'group' or (layer.isTilemap and 'tilemap' or 'layer'),
        visible=layer.isVisible, editable=layer.isEditable, index=layer.stackIndex-1, opacity=layer.opacity}
      if layer.isImage then
        row.cels = {}
        for _, cel in ipairs(layer.cels) do
          row.cels[#row.cels+1] = {frame=cel.frame.frameNumber-1, x=cel.position.x, y=cel.position.y,
            width=cel.image.width, height=cel.image.height, opacity=cel.opacity}
        end
      end
      rows[#rows+1] = row
      if layer.isGroup then walk(layer.layers, name .. '/') end
    end
  end
  walk(spr.layers, '')
  local frames, tags = {}, {}
  for _, frame in ipairs(spr.frames) do frames[#frames+1] = frame.duration end
  for _, tag in ipairs(spr.tags) do tags[#tags+1] = {name=tag.name, from=tag.fromFrame.frameNumber-1, to=tag.toFrame.frameNumber-1} end
  return {op=p.op, width=spr.width, height=spr.height, colourMode=spr.colorMode == ColorMode.RGB and 'rgb' or (spr.colorMode == ColorMode.INDEXED and 'indexed' or 'gray'),
    frames=frames, tags=tags, parts=rows, paletteSize=#spr.palettes[1]}
end
local function paletteCheck()
  local pc = app.pixelColor
  local external = nil
  if p.paletteFile then external = Palette{fromFile=p.paletteFile} end
  if p.colours then
    external = Palette(#p.colours)
    for i,c in ipairs(p.colours) do external:setColor(i-1, Color{r=c.r, g=c.g, b=c.b, a=c.a or 255}) end
  end
  if external then assert(#external > 0, 'palette contains no colours') end
  local rows, byColour = {}, {}
  local scanned, transparent, outside = 0, 0, 0
  local function key(c)
    return string.format('#%02x%02x%02x%02x', c.red, c.green, c.blue, c.alpha)
  end
  local function walk(layers, prefix)
    for _, layer in ipairs(layers) do
      local name = prefix .. layer.name
      if layer.isGroup then walk(layer.layers, name .. '/')
      else
        assert(not layer.isTilemap, 'palette-check needs image layers; tilemap: ' .. name)
        for _, cel in ipairs(layer.cels) do
          local frame = cel.frame.frameNumber - 1
          local palette = paletteAt(frame)
          local allowed = {}
          local reference = external or palette
          for i=0,#reference-1 do allowed[key(reference:getColor(i))] = true end
          local positions = {}
          for pixel in cel.image:pixels() do
            local value = pixel()
            local c, invalid, skip = nil, nil, false
            if spr.colorMode == ColorMode.INDEXED then
              if value == spr.transparentColor and not layer.isBackground then skip = true
              elseif value >= #palette then invalid = value
              else c = palette:getColor(value) end
            elseif spr.colorMode == ColorMode.GRAY then
              local v = pc.grayaV(value)
              c = Color{r=v, g=v, b=v, a=pc.grayaA(value)}
            else c = Color{r=pc.rgbaR(value), g=pc.rgbaG(value), b=pc.rgbaB(value), a=pc.rgbaA(value)} end
            scanned = scanned + 1
            if skip or (c and c.alpha == 0) then transparent = transparent + 1
            else
              local colour = c and key(c) or nil
              if invalid or not allowed[colour] then
                outside = outside + 1
                local id = invalid and ('index:' .. invalid) or colour
                local row = byColour[id]
                if not row then
                  row = {colour=colour, index=invalid, count=0, positions={}}
                  byColour[id] = row
                  rows[#rows+1] = row
                end
                row.count = row.count + 1
                local x, y = cel.position.x + pixel.x, cel.position.y + pixel.y
                local pos = positions[id]
                if not pos then
                  pos = {layer=name, frame=frame, count=0, first={x=x,y=y}, bounds={x=x,y=y,width=1,height=1}}
                  positions[id] = pos
                  row.positions[#row.positions+1] = pos
                end
                pos.count = pos.count + 1
                local b = pos.bounds
                local right, bottom = math.max(b.x+b.width-1,x), math.max(b.y+b.height-1,y)
                b.x, b.y = math.min(b.x,x), math.min(b.y,y)
                b.width, b.height = right-b.x+1, bottom-b.y+1
              end
            end
          end
        end
      end
    end
  end
  walk(spr.layers, '')
  return {op=p.op, palette=p.paletteFile and p.palette or (p.colours and 'list' or 'sprite'),
    scannedPixels=scanned, transparentPixels=transparent, outsidePixels=outside, colours=rows}
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
elseif p.op == 'parts' then
  app.transaction(function() report = parts() end)
elseif p.op == 'describe' then report = describe()
elseif p.op == 'palette-check' then report = paletteCheck()
end
if p.render then report.render = render() end
if p.save then assert(spr:saveAs(p.save), 'sprite save failed') end
local out = assert(io.open(p.report, 'wb'))
out:write(json.encode(report))
out:close()
`
