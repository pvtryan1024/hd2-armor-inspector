# Blender: transfer the current game colours onto a site model's own UVs.
# The site models come from an older export: some pieces' UVs no longer match the game's current textures (Charger
# abdomen, Bile Titan sacs, spewer bellies), and the old textures were decoded too dark. This opens a fresh filediver
# .blend of the unit (current mesh, UVs and textures), imports the site model (plain glb, see plain-glb.mjs) and, for
# each of its materials, bakes the fresh model's base colour onto the site meshes by projection (selected to active),
# into the site model's UV0 (wrapped to 0..1, as the texture repeats per UDIM tile).
# usage: blender -b unit.blend --python bake-transfer.py -- site.glb outdir size [unit2.blend ...]
import bpy, bmesh, sys, os, math, mathutils
argv = sys.argv[sys.argv.index('--') + 1:]
site, outdir, size = argv[0], argv[1], int(argv[2])
extra_blends = argv[3:]
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.samples = 1
sc.cycles.device = 'CPU'
bk = sc.render.bake
bk.use_selected_to_active = True
bk.margin = 8
bk.use_clear = False

def res(name):
    import re as _re  # an imported material named like one already in the .blend gets .001 (Illuminate)
    return _re.sub(r'\.\d{3}$', '', name.split(' ')[-1])

# other units' objects (gear) come in too
for b in extra_blends:
    with bpy.data.libraries.load(b) as (src, dst):
        dst.objects = list(src.objects)
    for o in dst.objects:
        if o and o.type == 'MESH': sc.collection.objects.link(o)

def unexclude(lc):
    lc.exclude = False
    for ch in lc.children: unexclude(ch)
unexclude(bpy.context.view_layer.layer_collection)
for c in bpy.data.collections:
    c.hide_render = False; c.hide_viewport = False; c.hide_select = False
for o in bpy.data.objects:
    o.hide_select = False

fresh = [o for o in bpy.data.objects if o.type == 'MESH' and o.data.uv_layers and any(s.material for s in o.material_slots)]
# fresh materials show their base colour as emission
for m in {s.material for o in fresh for s in o.material_slots if s.material}:
    if not m.use_nodes: continue
    nt = m.node_tree
    p = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
    if not p or not out: continue
    em = nt.nodes.new('ShaderNodeEmission')
    bc = p.inputs['Base Color']
    if bc.is_linked: nt.links.new(bc.links[0].from_socket, em.inputs['Color'])
    else: em.inputs['Color'].default_value = bc.default_value
    nt.links.new(em.outputs[0], out.inputs['Surface'])
for o in fresh:
    if o.name not in bpy.context.view_layer.objects: sc.collection.objects.link(o)  # in a collection the scene does not use
    o.hide_render = False; o.hide_set(False); o.hide_viewport = False

# the Illuminate .blends carry an old "glTF Material Output" group (no Iridescence Factor) the importer would reuse
for ng in bpy.data.node_groups:
    if ng.name.startswith('glTF'): ng.name = 'old ' + ng.name
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=site)
targets = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
# the importer may pose / parent; evaluate everything in world space
bpy.context.view_layer.update()

# overall size for ray distances
mn = mathutils.Vector((1e9,) * 3); mx = -mn
for o in targets:
    for c in o.bound_box:
        w = o.matrix_world @ mathutils.Vector(c); mn = mathutils.Vector(map(min, mn, w)); mx = mathutils.Vector(map(max, mx, w))
diag = (mx - mn).length
bk.cage_extrusion = diag * 0.01
bk.max_ray_distance = diag * 0.03
print('XFER fresh', len(fresh), 'targets', len(targets), 'size', round(diag, 2))

import re
DMG = re.compile(r'damaged|gib|hurt|destroyed|burst|broken|dead', re.I)
SKIP = re.compile(r'shadow|collision', re.I)
# lower LODs only when a better one is there (the Overseers come with LOD1 meshes only)
def lod_of(o):
    m = re.search(r'lod(\d)', o.name, re.I)
    return int(m.group(1)) if m else None
tagged = [lod_of(o) for o in fresh]
if fresh and all(t is not None for t in tagged):
    best = min(tagged)
    fresh = [o for o in fresh if lod_of(o) == best]
else:
    fresh = [o for o in fresh if lod_of(o) in (None, 0)]
fresh = [o for o in fresh if not SKIP.search(o.name) and not any(s.material and SKIP.search(s.material.name) for s in o.material_slots)]
fresh_intact = [o for o in fresh if not DMG.search(o.name)]
print('XFERSRC', len(fresh), len(fresh_intact), [o.name for o in fresh][:6])
# damaged / gib pieces first: where they share texture space with intact ones, the intact bake comes last and wins
targets.sort(key=lambda o: 0 if DMG.search(o.name) else 1)
images = {}
for o in targets:
    if not o.data.uv_layers: continue
    # site materials: an image per resource, bake target in a wrapped copy of UV0
    for s in o.material_slots:
        m = s.material
        if not m: continue
        r = res(m.name)
        if r not in images:
            img = bpy.data.images.new(r.replace('/', '__'), size, size, alpha=True)
            img.pixels = [0.0] * (size * size * 4)
            img.filepath_raw = os.path.join(outdir, r.replace('/', '__') + '.png'); img.file_format = 'PNG'
            images[r] = img
        m.use_nodes = True
        nt = m.node_tree
        for n in nt.nodes: n.select = False
        tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = images[r]; tn.select = True; nt.nodes.active = tn
    me = o.data
    bm = bmesh.new(); bm.from_mesh(me)
    uv0 = bm.loops.layers.uv[0]
    wr = bm.loops.layers.uv.new('wrapped')
    for f in bm.faces:
        cu = sum(l[uv0].uv[0] for l in f.loops) / len(f.loops)
        cv = sum(l[uv0].uv[1] for l in f.loops) / len(f.loops)
        fu, fv = math.floor(cu), math.floor(cv)
        for l in f.loops: l[wr].uv = (l[uv0].uv[0] - fu, l[uv0].uv[1] - fv)
    bm.to_mesh(me); bm.free()
    o.hide_render = False; o.hide_set(False); o.hide_viewport = False

# one bake per group (a bake per piece rebuilds the ray structures every time and took ~10 min a model): the damaged /
# gib pieces joined into one object and baked first from every game piece, then the intact pieces from intact ones
ready = [o for o in targets if o.data.uv_layers and 'wrapped' in o.data.uv_layers and any(s.material for s in o.material_slots)]
for group, sources in (([o for o in ready if DMG.search(o.name)], fresh), ([o for o in ready if not DMG.search(o.name)], fresh_intact)):
    if not group: continue
    bpy.ops.object.select_all(action='DESELECT')
    for o in group: o.select_set(True)
    bpy.context.view_layer.objects.active = group[0]
    if len(group) > 1: bpy.ops.object.join()
    t = bpy.context.view_layer.objects.active
    bpy.ops.object.select_all(action='DESELECT')
    for f in sources: f.select_set(True)
    t.select_set(True)
    bpy.context.view_layer.objects.active = t
    try:
        bpy.ops.object.bake(type='EMIT', uv_layer='wrapped')
    except Exception as e:
        print('XFERFAIL', t.name, e)

for r, img in images.items():
    img.save()
print('XFERDONE', ' '.join(sorted(images)))
