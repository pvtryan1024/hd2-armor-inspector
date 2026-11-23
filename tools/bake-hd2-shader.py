# Blender: bake the accurate HD2 shader's Bake_Color for every material in this unit that the layout lists, into
# one atlas per material resource (a cell per UDIM tile), adding to what earlier units already baked there.
# usage: blender -b unit.blend --python bake2.py -- layout.json outdir
import bpy, bmesh, sys, json, os, math
argv = sys.argv[sys.argv.index('--') + 1:]
layout = json.load(open(argv[0]))
outdir = argv[1]
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.samples = 4
sc.cycles.device = 'CPU'
sc.render.bake.margin = 6
sc.render.bake.use_clear = False

def res_of(m):
    if not m: return None
    tok = m.name.split(' ')[-1]
    if tok in layout or len(m.name) < 63: return tok
    hits = [k for k in layout if k.startswith(tok)]  # Blender cuts names at 63 characters
    return hits[0] if len(hits) == 1 else tok

def safe(r):
    return r.replace('/', '__')

images, groups = {}, {}
for m in bpy.data.materials:
    r = res_of(m)
    if r not in layout or not m.use_nodes:
        continue
    g = next((n for n in m.node_tree.nodes if n.type == 'GROUP' and 'Bake_Color' in n.outputs), None)
    if not g:
        print('NOBAKE', m.name, [n.type for n in m.node_tree.nodes][:8])
        continue
    if r not in images:
        L = layout[r]
        p = os.path.join(outdir, safe(r) + '.png')
        if os.path.exists(p):
            img = bpy.data.images.load(p)
        else:
            img = bpy.data.images.new(safe(r), L['size'], L['size'], alpha=True)
            img.pixels = [0.0] * (L['size'] * L['size'] * 4)
        img.filepath_raw = p
        img.file_format = 'PNG'
        images[r] = img
    nt = m.node_tree
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(g.outputs['Bake_Color'], em.inputs['Color'])
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = images[r]
    for n in nt.nodes:
        n.select = False
    tn.select = True
    nt.nodes.active = tn
    groups[m.name] = r

for c in bpy.data.collections:
    c.hide_render = False
    c.hide_viewport = False
def unexclude(lc):
    lc.exclude = False
    for ch in lc.children: unexclude(ch)
unexclude(bpy.context.view_layer.layer_collection)

baked = 0
for o in list(bpy.data.objects):
    if o.type != 'MESH' or not o.data.uv_layers:
        continue
    slots = [groups.get(s.material.name) if s.material else None for s in o.material_slots]
    if not any(slots):
        continue
    o.data = o.data.copy()
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uv0 = bm.loops.layers.uv[0]
    at = bm.loops.layers.uv.new('atlas')
    kill = []
    for f in bm.faces:
        r = slots[f.material_index] if f.material_index < len(slots) else None
        if not r:
            kill.append(f); continue
        L = layout[r]
        us = [l[uv0].uv[0] for l in f.loops]
        vs = [1 - l[uv0].uv[1] for l in f.loops]
        fu, fv = math.floor(sum(us) / len(us)), math.floor(sum(vs) / len(vs))
        t = fu + 10 * fv
        if t not in L['tiles']:
            kill.append(f); continue
        i = L['tiles'].index(t)
        G = L['grid']
        cx, cy = i % G, i // G
        for l, u, v in zip(f.loops, us, vs):
            l[at].uv = ((cx + (u - fu)) / G, 1 - (cy + (v - fv)) / G)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    if not bm.faces:
        bm.free(); continue
    bm.to_mesh(me)
    bm.free()
    o.hide_render = False
    o.hide_set(False)
    o.hide_viewport = False
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    try:
        bpy.ops.object.bake(type='EMIT', uv_layer='atlas')
        baked += 1
    except Exception as e:
        print('BAKEFAIL', o.name, e)

for r, img in images.items():
    img.save()
print('BAKED', baked, 'objects;', 'materials:', ' '.join(sorted(images)))
