-- Fake Resolve Media Pool. Clips: v1 in root, v3 already sits in a subfolder "Old", one unknown clip,
-- "/r/odd]]name.mp4" reported with that exact path. v2 and v4 are NOT in the pool.
local function folder(name) return {name=name, clips={}, subs={}} end
local root = folder("Master")
local old = folder("Old"); table.insert(root.subs, old)
local function clip(p) return {p=p} end
table.insert(root.clips, clip("/r/S/takes/1a_x_v1.mp4"))
table.insert(old.clips, clip("/r/S/takes/2a_x_v3.mp4"))
table.insert(root.clips, clip("/elsewhere/unknown.mp4"))
table.insert(root.clips, clip("/r/odd]]name.mp4"))
LOG = {}
local F = {}; F.__index = F
function F:GetName() return self.name end
-- Like the real Resolve on Shawn's Mac: lists come back with a stray number
-- entry beside the objects (here under key "n").
local function withJunk(t) local c = {}; for i, v in ipairs(t) do c[i] = v end; c.n = #t; return c end
function F:GetClipList() return withJunk(self.clips) end
function F:GetSubFolderList() return withJunk(self.subs) end
setmetatable(root, F); setmetatable(old, F)
local C = {}; C.__index = C
function C:GetClipProperty(k) assert(k == "File Path"); return self.p end
for _, f in ipairs({root, old}) do for _, c in ipairs(f.clips) do setmetatable(c, C) end end
local MP = {}
function MP:GetRootFolder() return root end
function MP:AddSubFolder(parent, name) local f = setmetatable(folder(name), F); table.insert(parent.subs, f); table.insert(LOG, "bin:"..name); return f end
function MP:MoveClips(list, target)
  for _, c in ipairs(list) do
    for _, f in ipairs({root, old}) do for i = #f.clips, 1, -1 do if f.clips[i] == c then table.remove(f.clips, i) end end end
    table.insert(target.clips, c); table.insert(LOG, "move:"..c.p.." -> "..target.name)
  end
  return true
end
function MP:SetCurrentFolder(f) self.cur = f; return true end
function MP:ImportMedia(paths) for _, p in ipairs(paths) do table.insert(LOG, "import:"..p.." -> "..self.cur.name) end; return paths end
function Resolve() return { GetProjectManager = function() return { GetCurrentProject = function() return { GetMediaPool = function() return MP end } end } end } end

-- Menu scripts get a `resolve` global; set it unless a test clears it.
resolve = Resolve()
