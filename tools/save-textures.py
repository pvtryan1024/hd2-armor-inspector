# Blender: save each material's freshly decoded game textures from a filediver .blend, named by material resource
# (last word of the material name): <resource>.png (base colour), <resource>.mr.png (the image feeding Metallic and
# Roughness through a Separate Color, glTF order: G roughness, B metal) and <resource>.nrm.png (the image feeding the
# Normal Map node, followed through node groups). Existing files are kept.
# usage: blender -b unit.blend --python save-textures.py -- outdir
import bpy, sys, os
outdir = sys.argv[sys.argv.index('--') + 1]

def upstream_image(sock, depth=0):
    """The image texture behind a socket, through Separate Color, Normal Map and group nodes."""
    if depth > 6 or not sock.is_linked: return None
    l = sock.links[0]; n = l.from_node
    if n.type == 'TEX_IMAGE': return n.image
    if n.type in ('SEPARATE_COLOR', 'SEPARATE_RGB', 'NORMAL_MAP'):
        i = n.inputs.get('Color') or n.inputs.get('Image') or n.inputs[0]
        return upstream_image(i, depth + 1)
    if n.type == 'GROUP':
        # the group input whose name matches the output used (normal -> Normal, ...)
        want = l.from_socket.name.lower()
        for i in n.inputs:
            if i.is_linked and (want in i.name.lower() or i.name.lower() in want):
                img = upstream_image(i, depth + 1)
                if img: return img
    return None

def save(img, f):
    if not img or os.path.exists(f): return
    img.filepath_raw = f; img.file_format = 'PNG'; img.save()
    print('TEX', os.path.basename(f), img.size[0])

for m in bpy.data.materials:
    if not m.use_nodes: continue
    p = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not p: continue
    r = m.name.split(' ')[-1].replace('/', '__')
    bc = p.inputs['Base Color']
    if bc.is_linked and bc.links[0].from_node.type == 'TEX_IMAGE':
        save(bc.links[0].from_node.image, os.path.join(outdir, r + '.png'))
    elif bc.is_linked and bc.links[0].from_node.type == 'MIX':  # albedo x vertex colour masks (Illuminate)
        tex = next((i.links[0].from_node for i in bc.links[0].from_node.inputs if i.is_linked and i.links[0].from_node.type == 'TEX_IMAGE'), None)
        if tex: save(tex.image, os.path.join(outdir, r + '.png'))
    met, rough = p.inputs['Metallic'], p.inputs['Roughness']
    if met.is_linked and rough.is_linked and met.links[0].from_node == rough.links[0].from_node and met.links[0].from_node.type in ('SEPARATE_COLOR', 'SEPARATE_RGB'):
        save(upstream_image(met), os.path.join(outdir, r + '.mr.png'))
    save(upstream_image(p.inputs['Normal']), os.path.join(outdir, r + '.nrm.png'))
