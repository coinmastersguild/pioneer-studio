// Hermetic check for meshy2vrm: the bone map (esp. the reversed spine), the flip,
// and BIN passthrough. No network, no three-vrm, no real asset — a synthetic GLB
// with the 24 Meshy joint names is enough to catch the logic breaking.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { injectVrm0 } from './meshy2vrm.mjs'

const JOINTS = [
  'Hips', 'Spine02', 'Spine01', 'Spine', 'neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
]
const REQUIRED = [
  'hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'leftUpperArm',
  'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
]

function buildGlb(bin) {
  // node 0 = Armature (scene root), then the 22 joints.
  const nodes = [{ name: 'Armature', scale: [0.01, 0.01, 0.01] }, ...JOINTS.map((name) => ({ name }))]
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes }
  let jb = Buffer.from(JSON.stringify(json))
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const chunks = [[0x4e4f534a, jb]]
  if (bin) {
    let bb = bin
    if (bb.length % 4) bb = Buffer.concat([bb, Buffer.alloc(4 - (bb.length % 4), 0)])
    chunks.push([0x004e4942, bb])
  }
  let total = 12
  for (const [, d] of chunks) total += 8 + d.length
  const out = Buffer.alloc(total)
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8)
  let w = 12
  for (const [t, d] of chunks) { out.writeUInt32LE(d.length, w); out.writeUInt32LE(t, w + 4); d.copy(out, w + 8); w += 8 + d.length }
  return out
}

function parseJson(glb) {
  let off = 12
  while (off < glb.length) {
    const len = glb.readUInt32LE(off), type = glb.readUInt32LE(off + 4)
    if (type === 0x4e4f534a) return JSON.parse(glb.slice(off + 8, off + 8 + len).toString('utf8'))
    off += 8 + len
  }
  throw new Error('no json')
}

test('injects a valid VRM0 humanoid map with the spine reversal handled', () => {
  const out = injectVrm0(buildGlb())
  const j = parseJson(out)
  assert.ok(j.extensionsUsed.includes('VRM'), 'extensionsUsed has VRM')
  const hb = j.extensions.VRM.humanoid.humanBones
  const nameOf = (boneName) => j.nodes[hb.find((b) => b.bone === boneName).node].name

  for (const r of REQUIRED) assert.ok(hb.some((b) => b.bone === r), `required bone ${r} present`)

  // the load-bearing assertion: Meshy's spine names are reversed, map by position.
  assert.equal(nameOf('spine'), 'Spine02', 'spine = lowest joint')
  assert.equal(nameOf('chest'), 'Spine01', 'chest = middle joint')
  assert.equal(nameOf('upperChest'), 'Spine', 'upperChest = highest joint')
  assert.equal(nameOf('hips'), 'Hips')
  assert.equal(nameOf('leftUpperArm'), 'LeftArm')
})

test('un-normalized path yaws the Armature; normalized path leaves it (facing baked into the rig)', () => {
  // normalize:false is the legacy path — a 180° yaw on the scene root.
  const flipped = parseJson(injectVrm0(buildGlb(), { normalize: false }))
  assert.deepEqual(flipped.nodes[0].rotation, [0, 1, 0, 0], 'normalize:false yaws the root 180°')

  // default (normalize) folds facing into the skeleton, so the Armature is untouched.
  const normalized = parseJson(injectVrm0(buildGlb()))
  assert.equal(normalized.nodes[0].rotation, undefined, 'normalized path does not rotate the Armature')
})

test('preserves the BIN chunk byte-for-byte', () => {
  const bin = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
  const out = injectVrm0(buildGlb(bin))
  let off = 12, got = null
  while (off < out.length) {
    const len = out.readUInt32LE(off), type = out.readUInt32LE(off + 4)
    if (type === 0x004e4942) got = out.slice(off + 8, off + 8 + len)
    off += 8 + len
  }
  assert.ok(got, 'BIN chunk survives')
  assert.deepEqual([...got.slice(0, 8)], [1, 2, 3, 4, 5, 6, 7, 8])
})

test('normalizes every skin joint to an identity local rest rotation', () => {
  // a skinned fixture: Armature(scale 0.01) -> all 22 named joints, each given a
  // non-identity local rotation + identity inverse-bind matrices in a BIN chunk.
  const joints = JOINTS.map((_, i) => i + 1)
  const nodes = [{ name: 'Armature', scale: [0.01, 0.01, 0.01], children: joints }]
  JOINTS.forEach((name, i) => nodes.push({ name, translation: [i + 1, 10 + i, 1], rotation: [0.5, 0.5, 0.5, 0.5] }))
  const ibm = new Float32Array(joints.length * 16) // identity mat4 per joint
  for (let k = 0; k < joints.length; k++) { ibm[k * 16] = ibm[k * 16 + 5] = ibm[k * 16 + 10] = ibm[k * 16 + 15] = 1 }
  const bin = Buffer.from(ibm.buffer)
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes,
    skins: [{ joints, inverseBindMatrices: 0 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: joints.length, type: 'MAT4' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  }
  let jb = Buffer.from(JSON.stringify(json))
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const glb = Buffer.alloc(12 + 8 + jb.length + 8 + bin.length)
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(jb.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); jb.copy(glb, 20)
  let w = 20 + jb.length
  glb.writeUInt32LE(bin.length, w); glb.writeUInt32LE(0x004e4942, w + 4); bin.copy(glb, w + 8)

  const out = parseJson(injectVrm0(glb))
  for (const j of joints) {
    const r = out.nodes[j].rotation
    assert.ok(r && Math.abs(r[0]) < 1e-5 && Math.abs(r[1]) < 1e-5 && Math.abs(r[2]) < 1e-5 && Math.abs(r[3] - 1) < 1e-5,
      `joint ${out.nodes[j].name} local rotation is identity after normalize (got ${JSON.stringify(r)})`)
  }
})

test('lifts Meshy A-pose arms to a horizontal T-pose rest', () => {
  // 22-joint rig with the arm chains NESTED and drooped ~45° down-out, plus a 2-vertex
  // skin so tposeArms runs (identity inverse-binds are fine — we assert BONE geometry).
  const N = {}; JOINTS.forEach((nm, i) => (N[nm] = i + 1))
  const nodes = [{ name: 'Armature', scale: [1, 1, 1], children: [] }]
  JOINTS.forEach((nm) => nodes.push({ name: nm, translation: [0, 1, 0] }))
  const meshNodeIdx = nodes.push({ name: 'meshNode', mesh: 0 }) - 1
  const set = (nm, t, kids) => { nodes[N[nm]].translation = t; if (kids) nodes[N[nm]].children = kids.map((k) => N[k]) }
  set('LeftShoulder', [0.1, 1.5, 0], ['LeftArm']); set('LeftArm', [0.1, 0, 0], ['LeftForeArm']); set('LeftForeArm', [0.2, -0.2, 0], ['LeftHand']); set('LeftHand', [0.2, -0.2, 0])
  set('RightShoulder', [-0.1, 1.5, 0], ['RightArm']); set('RightArm', [-0.1, 0, 0], ['RightForeArm']); set('RightForeArm', [-0.2, -0.2, 0], ['RightHand']); set('RightHand', [-0.2, -0.2, 0])
  set('Hips', [0, 1, 0]); set('Head', [0, 1.6, 0]); set('LeftFoot', [0.1, 0.1, 0]); set('RightFoot', [-0.1, 0.1, 0])
  const armChain = new Set(['LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'])
  nodes[0].children = [...JOINTS.filter((nm) => !armChain.has(nm)).map((nm) => N[nm]), meshNodeIdx]

  const nj = 22, ibmLen = nj * 64, posOff = ibmLen, norOff = posOff + 24, jntOff = norOff + 24, wgtOff = jntOff + 8, binLen = wgtOff + 32
  const bin = Buffer.alloc(binLen)
  for (let k = 0; k < nj; k++) { const o = k * 64; bin.writeFloatLE(1, o); bin.writeFloatLE(1, o + 20); bin.writeFloatLE(1, o + 40); bin.writeFloatLE(1, o + 60) }
  bin.writeFloatLE(0.6, posOff); bin.writeFloatLE(1.1, posOff + 4); bin.writeFloatLE(-0.6, posOff + 12); bin.writeFloatLE(1.1, posOff + 16)
  bin.writeFloatLE(1, norOff + 4); bin.writeFloatLE(1, norOff + 16) // normals (0,1,0)
  bin.writeUInt8(9, jntOff); bin.writeUInt8(13, jntOff + 4) // slot 9=LeftHand, 13=RightHand
  bin.writeFloatLE(1, wgtOff); bin.writeFloatLE(1, wgtOff + 16)
  const joints = JOINTS.map((_, i) => i + 1)
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 1, NORMAL: 2, JOINTS_0: 3, WEIGHTS_0: 4 } }] }],
    skins: [{ joints, inverseBindMatrices: 0 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nj, type: 'MAT4' },
      { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3', min: [-0.6, 1.1, 0], max: [0.6, 1.1, 0] },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: 3, componentType: 5121, count: 2, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 2, type: 'VEC4' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: ibmLen },
      { buffer: 0, byteOffset: posOff, byteLength: 24 },
      { buffer: 0, byteOffset: norOff, byteLength: 24 },
      { buffer: 0, byteOffset: jntOff, byteLength: 8 },
      { buffer: 0, byteOffset: wgtOff, byteLength: 32 },
    ],
    buffers: [{ byteLength: binLen }],
  }
  let jb = Buffer.from(JSON.stringify(json))
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const glb = Buffer.alloc(12 + 8 + jb.length + 8 + bin.length)
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(jb.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); jb.copy(glb, 20)
  let w = 20 + jb.length
  glb.writeUInt32LE(bin.length, w); glb.writeUInt32LE(0x004e4942, w + 4); bin.copy(glb, w + 8)

  const out = parseJson(injectVrm0(glb))
  // output bones are identity-rotation; compose world position down the parent chain.
  const m4FromTRS = (t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) => { const [x, y, z, ww] = q, x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = ww * x2, wy = ww * y2, wz = ww * z2, [sx, sy, sz] = s; return [(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0, (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0, (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0, t[0], t[1], t[2], 1] }
  const m4Mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o }
  const par = new Array(out.nodes.length).fill(-1)
  out.nodes.forEach((n, i) => (n.children || []).forEach((c) => (par[c] = i)))
  const worldPos = (nm) => { let i = out.nodes.findIndex((n) => n.name === nm), m = m4FromTRS([0, 0, 0]); const chain = []; while (i >= 0) { chain.unshift(i); i = par[i] } for (const k of chain) m = m4Mul(m, m4FromTRS(out.nodes[k].translation, out.nodes[k].rotation, out.nodes[k].scale)); return [m[12], m[13], m[14]] }
  const la = worldPos('LeftArm'), lh = worldPos('LeftHand'), ra = worldPos('RightArm'), rh = worldPos('RightHand')
  assert.ok(Math.abs(la[1] - lh[1]) < 0.05, `left arm horizontal at rest (LeftArm.y=${la[1].toFixed(3)} LeftHand.y=${lh[1].toFixed(3)})`)
  assert.ok(Math.abs(ra[1] - rh[1]) < 0.05, `right arm horizontal at rest (RightArm.y=${ra[1].toFixed(3)} RightHand.y=${rh[1].toFixed(3)})`)
  assert.ok(Math.abs(lh[0]) > Math.abs(la[0]) + 0.1, 'left hand extends outward past the upper arm')
})

test('throws a clear error when the rig is not a Meshy 24-joint humanoid', () => {
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Armature' }, { name: 'mixamorig:Hips' }] }
  let jb = Buffer.from(JSON.stringify(json))
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const glb = Buffer.alloc(12 + 8 + jb.length)
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(jb.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); jb.copy(glb, 20)
  assert.throws(() => injectVrm0(glb), /bone node not found/)
})
