#!/usr/bin/env node
// meshy2vrm.mjs — turn a Meshy rigged .glb into a portable VRM 0.x asset.
//
//   node meshy2vrm.mjs <in-rigged.glb> <out.vrm> [title]
//   import { convertGlbToVrm } from './meshy2vrm.mjs'
//
// It is pure metadata injection — no geometry/skin/BIN bytes change. Meshy's
// auto-rig is a 24-joint Mixamo-style humanoid with the same bone topology used
// by the target VRM 0.x runtime. All we add is the VRM humanoid bone-map extension.
// Verified end-to-end: the output loads in @pixiv/three-vrm 3.5.3 and every
// required humanoid bone resolves (see meshy2vrm.test.mjs).
//
// Two gotchas the map handles, both proven by world-space inspection of real rigs:
//   1. Meshy's spine chain is REVERSED vs Mixamo: parented Hips->Spine02->Spine01
//      ->Spine with world-Y increasing along it, so Spine02 is LOWEST. Map by
//      position: spine=Spine02, chest=Spine01, upperChest=Spine (carries the
//      shoulders + neck). Mapping by the literal "Spine" token would invert it.
//   2. Meshy faces +Z (left side at +X); the target VRM0 convention faces -Z. A 180° yaw
//      baked onto the scene-root (Armature) fixes both axes at once.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── tiny column-major mat4 (glTF convention) ─────────────────────────────────────
function m4FromTRS(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  const [sx, sy, sz] = s
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ]
}
function m4Mul(a, b) { // a*b, column-major
  const o = new Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
  return o
}
function m4Invert(m) { // gl-matrix invert
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) throw new Error('non-invertible matrix')
  det = 1 / det
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ]
}
// transform a point (w=1) by a column-major mat4
function m4Point(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ]
}
// rotate a direction (w=0) by the upper 3x3 of a column-major mat4
function m4Dir(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ]
}
// translation-only mat4
const m4Trans = (t) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1]
// unit quaternion from axis (unit) + angle
function quatAxisAngle(axis, angle) {
  const s = Math.sin(angle / 2)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]
}
// decompose a column-major mat4 into { t, q, s } (q from the scale-normalized 3x3).
function m4Decompose(m) {
  const t = [m[12], m[13], m[14]]
  let sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10])
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5])
  if (det < 0) sx = -sx
  const m00 = m[0] / sx, m10 = m[1] / sx, m20 = m[2] / sx
  const m01 = m[4] / sy, m11 = m[5] / sy, m21 = m[6] / sy
  const m02 = m[8] / sz, m12 = m[9] / sz, m22 = m[10] / sz
  const tr = m00 + m11 + m22
  let q
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s] }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s] }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s] }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s] }
  return { t, q, s: [sx, sy, sz] }
}
const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const v3dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const v3len = (a) => Math.hypot(a[0], a[1], a[2])
const v3norm = (a) => { const l = v3len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

// VRM bone -> Meshy node name. The 24-joint rig is fixed, so this is a constant.
// First 15 are VRM0-required; the rest are optional bonuses the rig happens to
// carry. Spine reversal is encoded here (do NOT "fix" the names).
const BONE_MAP = [
  ['hips', 'Hips'],
  ['spine', 'Spine02'], // lowest spine joint (child of Hips)
  ['head', 'Head'],
  ['leftUpperLeg', 'LeftUpLeg'],
  ['leftLowerLeg', 'LeftLeg'],
  ['leftFoot', 'LeftFoot'],
  ['rightUpperLeg', 'RightUpLeg'],
  ['rightLowerLeg', 'RightLeg'],
  ['rightFoot', 'RightFoot'],
  ['leftUpperArm', 'LeftArm'],
  ['leftLowerArm', 'LeftForeArm'],
  ['leftHand', 'LeftHand'],
  ['rightUpperArm', 'RightArm'],
  ['rightLowerArm', 'RightForeArm'],
  ['rightHand', 'RightHand'],
  // optional, present in the Meshy rig
  ['chest', 'Spine01'], // middle spine joint
  ['upperChest', 'Spine'], // highest spine joint (carries shoulders + neck)
  ['neck', 'neck'],
  ['leftShoulder', 'LeftShoulder'],
  ['rightShoulder', 'RightShoulder'],
  ['leftToes', 'LeftToeBase'],
  ['rightToes', 'RightToeBase'],
]

const JSON_CHUNK = 0x4e4f534a // 'JSON'
const BIN_CHUNK = 0x004e4942 // 'BIN\0'

/** Split a .glb buffer into { json, binChunk }. */
function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb')
  let off = 12
  let json = null
  let binChunk = null
  while (off < buf.length) {
    const len = buf.readUInt32LE(off)
    const type = buf.readUInt32LE(off + 4)
    const data = buf.slice(off + 8, off + 8 + len)
    if (type === JSON_CHUNK) json = JSON.parse(data.toString('utf8'))
    else if (type === BIN_CHUNK) binChunk = Buffer.from(data)
    off += 8 + len
  }
  if (!json) throw new Error('no JSON chunk')
  return { json, binChunk }
}

/**
 * Restore the PBR material that Meshy's RIGGING step strips. Meshy's image-to-3d
 * outputs base + normal + metallic-roughness + emissive maps, but /rigging drops the
 * normal/metallic-roughness and leaves the albedo wired as a full emissive map — so
 * the rigged model renders SELF-LIT and FLAT (no surface relief, dead eyes). The
 * pre-rig `gamemesh.glb` has the same mesh + UVs, so we transplant its base+normal+
 * metallic-roughness textures onto the rigged primitives and ZERO the emissive (the
 * model should be LIT by the scene, not glow its own texture). Grows + returns the bin.
 */
function transplantPbr(json, bin, srcGlb) {
  const src = parseGlb(srcGlb)
  const sj = src.json, sb = src.binChunk
  const sMat = (sj.materials || [])[0]
  if (!sMat || !sb) return bin
  const sPm = sMat.pbrMetallicRoughness || {}

  const appended = [] // {bytes} appended to the bin tail, padded to 4
  let binLen = bin.length
  json.bufferViews = json.bufferViews || []
  json.images = json.images || []
  json.samplers = json.samplers || []
  json.textures = json.textures || []
  const defaultSampler = json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }) - 1

  // copy one texture (by src texture index) into the dst doc; return new dst tex index.
  const copyTex = (sTexIdx) => {
    const sTex = sj.textures[sTexIdx]
    const sImg = sj.images[sTex.source]
    const sBV = sj.bufferViews[sImg.bufferView]
    const off = sBV.byteOffset || 0
    let bytes = sb.slice(off, off + sBV.byteLength)
    const pad = (4 - (binLen % 4)) % 4
    if (pad) { appended.push(Buffer.alloc(pad)); binLen += pad }
    const bvIdx = json.bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: bytes.length }) - 1
    appended.push(bytes); binLen += bytes.length
    const imgIdx = json.images.push({ bufferView: bvIdx, mimeType: sImg.mimeType || 'image/png' }) - 1
    return json.textures.push({ source: imgIdx, sampler: defaultSampler }) - 1
  }

  // Modify the EXISTING rigged material IN PLACE: keep its (4K) base color, add back
  // only the normal + metallic-roughness maps the rigging stripped, and kill the
  // self-lit emissive. (Don't copy the base — that would duplicate the 4K texture.)
  const dMat = (json.materials || [])[(json.meshes?.[0]?.primitives?.[0]?.material) ?? 0]
  if (!dMat) return bin
  const dPm = (dMat.pbrMetallicRoughness = dMat.pbrMetallicRoughness || {})
  if (sMat.normalTexture) dMat.normalTexture = { index: copyTex(sMat.normalTexture.index), ...(sMat.normalTexture.scale != null ? { scale: sMat.normalTexture.scale } : {}) }
  if (sPm.metallicRoughnessTexture) {
    dPm.metallicRoughnessTexture = { index: copyTex(sPm.metallicRoughnessTexture.index) }
    if (sPm.metallicFactor != null) dPm.metallicFactor = sPm.metallicFactor
    if (sPm.roughnessFactor != null) dPm.roughnessFactor = sPm.roughnessFactor
  }
  if (sMat.occlusionTexture) dMat.occlusionTexture = { index: copyTex(sMat.occlusionTexture.index) }
  dMat.emissiveFactor = [0, 0, 0] // stop the self-lit / unlit flatness — render LIT
  delete dMat.emissiveTexture

  const newBin = Buffer.concat([bin, ...appended])
  if (json.buffers && json.buffers[0]) json.buffers[0].byteLength = newBin.length
  return newBin
}

/** Repack { json, binChunk } back into a length-correct .glb buffer. */
function packGlb(json, binChunk) {
  let jsonBytes = Buffer.from(new TextEncoder().encode(JSON.stringify(json)))
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  if (jsonPad) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]) // pad with spaces

  const chunks = [{ type: JSON_CHUNK, data: jsonBytes }]
  if (binChunk) {
    let binBytes = binChunk
    const binPad = (4 - (binBytes.length % 4)) % 4
    if (binPad) binBytes = Buffer.concat([binBytes, Buffer.alloc(binPad, 0x00)])
    chunks.push({ type: BIN_CHUNK, data: binBytes })
  }

  let total = 12
  for (const c of chunks) total += 8 + c.data.length
  const out = Buffer.alloc(total)
  out.writeUInt32LE(0x46546c67, 0) // 'glTF'
  out.writeUInt32LE(2, 4) // version
  out.writeUInt32LE(total, 8)
  let w = 12
  for (const c of chunks) {
    out.writeUInt32LE(c.data.length, w)
    out.writeUInt32LE(c.type, w + 4)
    c.data.copy(out, w + 8)
    w += 8 + c.data.length
  }
  return out
}

/**
 * Inject a VRM 0.x extension into a Meshy rigged glb and return the .vrm buffer.
 * @param {Buffer} glbBuf  the rigged.glb bytes
 * @param {{title?: string, flip?: boolean}} [opts]
 */
export function injectVrm0(glbBuf, opts = {}) {
  const title = opts.title || 'MeshyChar'
  const normalize = opts.normalize !== false // default true; owns facing (bakes the 180° into the rig)
  const flip = opts.flip !== false && !normalize // only the un-normalized path needs the Armature yaw
  const parsed = parseGlb(glbBuf)
  const json = parsed.json
  // Restore the PBR maps Meshy's rigging strips (see transplantPbr) from the pre-rig
  // gamemesh, so the model renders lit with surface relief instead of self-lit + flat.
  let binChunk = opts.pbrGlb ? transplantPbr(json, parsed.binChunk, opts.pbrGlb) : parsed.binChunk

  const nodes = json.nodes || []
  const idx = (name) => {
    const i = nodes.findIndex((n) => n.name === name)
    if (i < 0) throw new Error(`bone node not found: ${name} (is this a Meshy 24-joint rig?)`)
    return i
  }

  const humanBones = BONE_MAP.map(([bone, meshyName]) => ({
    bone,
    node: idx(meshyName),
    useDefaultValues: true,
  }))

  json.extensions = json.extensions || {}
  json.extensions.VRM = {
    specVersion: '0.0',
    exporterVersion: 'meshy2vrm-0.1',
    meta: {
      title,
      version: '1',
      author: 'Meshy',
      allowedUserName: 'Everyone',
      violentUssageName: 'Disallow',
      sexualUssageName: 'Disallow',
      commercialUssageName: 'Allow',
      licenseName: 'Redistribution_Prohibited',
    },
    humanoid: {
      humanBones,
      armStretch: 0.05, legStretch: 0.05,
      upperArmTwist: 0.5, lowerArmTwist: 0.5,
      upperLegTwist: 0.5, lowerLegTwist: 0.5,
      feetSpacing: 0, hasTranslationDoF: false,
    },
    firstPerson: {
      firstPersonBone: idx('Head'),
      firstPersonBoneOffset: { x: 0, y: 0, z: 0 },
      meshAnnotations: [],
      lookAtTypeName: 'Bone',
    },
    blendShapeMaster: { blendShapeGroups: [] },
    secondaryAnimation: { boneGroups: [], colliderGroups: [] },
    materialProperties: [],
  }
  json.extensionsUsed = json.extensionsUsed || []
  if (!json.extensionsUsed.includes('VRM')) json.extensionsUsed.push('VRM')

  // 180° yaw so the rig faces -Z like the game's reference VRM0s. The Meshy scene
  // has a single root (the Armature, scale 0.01). Premultiply a Y-180 quaternion
  // (0,1,0,0) onto whatever rotation it already has.
  if (flip) {
    const rootIdx = (json.scenes?.[json.scene ?? 0]?.nodes || [])[0]
    const root = nodes[rootIdx]
    if (!root) throw new Error('no scene root to flip')
    root.rotation = mulQuatY180(root.rotation || [0, 0, 0, 1])
  }

  // Meshy authors the body in an A-pose (arms angled ~40° down); the animation retarget
  // assumes a T-pose rest (arms horizontal, like guard), so the idle re-lowers the arms
  // and they collapse to center/behind. Lift the arms to horizontal FIRST (re-skinning
  // the mesh so bones+verts+inverse-binds stay consistent), then normalize.
  if (normalize) tposeArmsToTPose(json, binChunk)

  // Bake the rig to guard's exact convention: identity-rotation bones (so the game's
  // raw-bone retarget + VRM0 flip land correctly — no boots-up, no arms-overhead) and
  // a 180° yaw folded into the skeleton positions + inverse-bind matrices (so it faces
  // -Z like the reference VRM0s WITHOUT a parent rotation that would re-tilt the bone
  // frames). The bind pose stays pixel-identical; only the rest orientation changes.
  if (normalize) normalizeRig(json, binChunk)

  return packGlb(json, binChunk)
}

// 180° about Y, column-major (X->-X, Z->-Z). Folds the VRM0 -Z facing into the rig.
const RY180 = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]

// q' = qY180 * q, with qY180 = (0,1,0,0). Closed form for that specific multiply.
function mulQuatY180([x, y, z, w]) {
  // (0,1,0,0) ⊗ (x,y,z,w) = (-z, w, x, -y)
  return [-z, w, x, -y]
}

/**
 * Freeze every skin joint to an identity LOCAL rest rotation (Meshy's rig uses a
 * non-standard "+Y down the bone" convention; guard/Mixamo rigs have identity local
 * frames, which the emoteFactory retarget assumes). The skeleton SHAPE (joint world
 * positions) and the bind-pose render are preserved exactly: each joint's local
 * translation is recomputed under its (already-frozen) parent, and its inverse-bind
 * matrix is rebuilt as inverse(worldNew)*worldOld*invBindOld so the SkinnedMesh is
 * pixel-identical at bind. Only the rest ORIENTATION changes — which is all the
 * retarget cares about. Mutates `json.nodes` + `binChunk` in place.
 */
function normalizeRig(json, binChunk) {
  const skin = json.skins?.[0]
  if (!skin || !binChunk || skin.inverseBindMatrices == null) return
  const nodes = json.nodes
  const joints = skin.joints

  const parent = new Array(nodes.length).fill(-1)
  nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)))

  // OLD world matrix per node (composed from the scene root, incl. Armature flip+scale).
  const worldOld = new Array(nodes.length)
  const computeOld = (i) => {
    if (worldOld[i]) return worldOld[i]
    const l = m4FromTRS(nodes[i].translation, nodes[i].rotation, nodes[i].scale)
    return (worldOld[i] = parent[i] < 0 ? l : m4Mul(computeOld(parent[i]), l))
  }
  for (let i = 0; i < nodes.length; i++) computeOld(i)

  // Re-frame each joint parent-first: identity rotation, position yawed 180° (so the
  // whole skeleton turns to face -Z without any bone carrying a rotation).
  const worldNew = worldOld.slice() // non-joints keep their old world
  // Bake the Armature's cm->m scale (0.01) into the bones so the rig lives in METRES
  // like guard. Otherwise the hips-position animation track is double-scaled by 0.01
  // and the figure collapses to the floor (hips at origin, feet below). The skinned
  // mesh is unaffected — it follows the bones, not the scene-root scale.
  for (const r of (json.scenes?.[json.scene ?? 0]?.nodes || [])) {
    nodes[r].scale = [1, 1, 1]
    worldNew[r] = m4FromTRS(nodes[r].translation, nodes[r].rotation, [1, 1, 1])
  }
  const depth = (i) => { let d = 0, p = parent[i]; while (p >= 0) { d++; p = parent[p] } return d }
  for (const j of [...joints].sort((a, b) => depth(a) - depth(b))) {
    const p = parent[j]
    const pNew = p < 0 ? null : worldNew[p]
    const n = nodes[j]
    const scale = n.scale || [1, 1, 1]
    const oldPos = [worldOld[j][12], worldOld[j][13], worldOld[j][14]]
    const newPos = m4Point(RY180, oldPos) // yaw the joint position 180° about world Y
    const localT = pNew ? m4Point(m4Invert(pNew), newPos) : newPos
    n.translation = localT
    n.rotation = [0, 0, 0, 1]
    worldNew[j] = pNew ? m4Mul(pNew, m4FromTRS(localT, [0, 0, 0, 1], scale)) : m4FromTRS(localT, [0, 0, 0, 1], scale)
  }

  // Rewrite the inverse-bind matrices for the faced bones:
  //   invBindNew = inverse(worldNew) * RY180 * worldOld * invBindOld * RY180
  // The trailing RY180 compensates the rotated VERTICES (below). Bones, inverse-binds,
  // AND verts all turn 180° together — a consistent rigid yaw with identity-oriented
  // bones (guard's convention). Yawing only the bones/inverse-binds, leaving verts in
  // the +Z frame, is what put the arms behind the back.
  // FLOAT MAT4, column-major; per-element read/write to dodge Float32Array alignment.
  const acc = json.accessors[skin.inverseBindMatrices]
  const bv = json.bufferViews[acc.bufferView]
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0)
  for (let k = 0; k < joints.length; k++) {
    const off = base + k * 64
    const old = []
    for (let e = 0; e < 16; e++) old.push(binChunk.readFloatLE(off + e * 4))
    const fixed = m4Mul(m4Invert(worldNew[joints[k]]), m4Mul(RY180, m4Mul(worldOld[joints[k]], m4Mul(old, RY180))))
    for (let e = 0; e < 16; e++) binChunk.writeFloatLE(fixed[e], off + e * 4)
  }

  // Yaw the vertex data 180° about Y (negate X and Z) so the mesh faces -Z like the
  // bones now do — POSITION, NORMAL, TANGENT.xyz. Dedupe shared accessors.
  const done = new Set()
  const negateXZ = (accIdx, comps) => {
    if (accIdx == null || done.has(accIdx)) return
    done.add(accIdx)
    const a = json.accessors[accIdx]
    if (a.componentType !== 5126) return // FLOAT only
    const view = json.bufferViews[a.bufferView]
    const stride = view.byteStride || comps * 4
    const start = (view.byteOffset || 0) + (a.byteOffset || 0)
    for (let i = 0; i < a.count; i++) {
      const o = start + i * stride
      binChunk.writeFloatLE(-binChunk.readFloatLE(o), o) // x
      binChunk.writeFloatLE(-binChunk.readFloatLE(o + 8), o + 8) // z
    }
    if (a.min && a.max) { // x/z extents swap-negate
      const mn = a.min.slice(), mx = a.max.slice()
      a.min = mn.slice(); a.max = mx.slice()
      a.min[0] = -mx[0]; a.max[0] = -mn[0]
      a.min[2] = -mx[2]; a.max[2] = -mn[2]
    }
  }
  for (const mesh of json.meshes || []) for (const prim of mesh.primitives || []) {
    negateXZ(prim.attributes.POSITION, 3)
    negateXZ(prim.attributes.NORMAL, 3)
    negateXZ(prim.attributes.TANGENT, 4)
  }
}

// Meshy's two arm chains (UpperArm is the pivot; Shoulder is NOT rotated).
const ARM_CHAINS = [
  { upper: 'LeftArm', hand: 'LeftHand', target: [1, 0, 0] }, // Meshy left = +X (raw space)
  { upper: 'RightArm', hand: 'RightHand', target: [-1, 0, 0] },
]

/**
 * Lift Meshy's A-pose arms to a horizontal T-pose (the rest the Mixamo retarget
 * assumes). For each arm we rotate the UpperArm-and-below bones about the UpperArm
 * joint so the upper-arm→hand direction becomes horizontal, then RE-SKIN the mesh
 * (POSITION + NORMAL, weighted by JOINTS_0/WEIGHTS_0) so the verts follow, and set
 * the new rest = bind (inverseBindMatrices = inverse(new world), arm node TRS = new
 * world). Body/legs/head are untouched (their skin matrix is identity). Runs BEFORE
 * normalizeRig. No-ops on rigs lacking a skin / JOINTS_0 / WEIGHTS_0 / inverse-binds.
 */
function tposeArmsToTPose(json, binChunk) {
  const skin = json.skins?.[0]
  if (!skin || !binChunk || skin.inverseBindMatrices == null) return
  const nodes = json.nodes
  const joints = skin.joints
  const nameToNode = (nm) => nodes.findIndex((n) => n.name === nm)
  const meshNode = nodes.find((n) => n.mesh != null)
  if (!meshNode) return
  const prim = json.meshes[meshNode.mesh].primitives[0]
  const at = prim.attributes
  if (at.POSITION == null || at.NORMAL == null || at.JOINTS_0 == null || at.WEIGHTS_0 == null) return

  const parent = new Array(nodes.length).fill(-1)
  nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)))
  const worldOld = new Array(nodes.length)
  const computeOld = (i) => {
    if (worldOld[i]) return worldOld[i]
    const l = m4FromTRS(nodes[i].translation, nodes[i].rotation, nodes[i].scale)
    return (worldOld[i] = parent[i] < 0 ? l : m4Mul(computeOld(parent[i]), l))
  }
  for (let i = 0; i < nodes.length; i++) computeOld(i)

  // read the ORIGINAL inverse-bind matrices (needed for re-skinning before we overwrite).
  const ibmAcc = json.accessors[skin.inverseBindMatrices]
  const ibmBV = json.bufferViews[ibmAcc.bufferView]
  const ibmBase = (ibmBV.byteOffset || 0) + (ibmAcc.byteOffset || 0)
  const invBindOld = []
  for (let k = 0; k < joints.length; k++) {
    const m = []
    for (let e = 0; e < 16; e++) m.push(binChunk.readFloatLE(ibmBase + k * 64 + e * 4))
    invBindOld.push(m)
  }

  // poseWorld: per-arm rotation P about the UpperArm pivot applied to that subtree.
  const poseWorld = worldOld.slice()
  const inSubtree = new Set()
  for (const arm of ARM_CHAINS) {
    const up = nameToNode(arm.upper), hand = nameToNode(arm.hand)
    if (up < 0 || hand < 0) continue
    const pivot = [worldOld[up][12], worldOld[up][13], worldOld[up][14]]
    const d = v3norm(v3sub([worldOld[hand][12], worldOld[hand][13], worldOld[hand][14]], pivot))
    const t = arm.target
    let axis = v3cross(d, t)
    const alen = v3len(axis)
    if (alen < 1e-6) continue // already aligned (or exactly opposite — leave it)
    axis = [axis[0] / alen, axis[1] / alen, axis[2] / alen]
    const angle = Math.acos(Math.max(-1, Math.min(1, v3dot(d, t))))
    const P = m4Mul(m4Trans(pivot), m4Mul(m4FromTRS([0, 0, 0], quatAxisAngle(axis, angle)), m4Trans([-pivot[0], -pivot[1], -pivot[2]])))
    // collect the UpperArm subtree (UpperArm + descendants) and rotate it.
    const stack = [up]
    while (stack.length) {
      const j = stack.pop()
      inSubtree.add(j)
      poseWorld[j] = m4Mul(P, worldOld[j])
      for (const c of nodes[j].children || []) stack.push(c)
    }
  }
  if (inSubtree.size === 0) return // no arm correction needed

  // Per-joint skin matrix M = poseWorld[joint] * invBindOld[joint] (identity for joints
  // whose poseWorld == worldOld, i.e. everything outside the arm subtrees).
  const M = joints.map((jn, k) => m4Mul(poseWorld[jn], invBindOld[k]))

  // Re-skin POSITION + NORMAL: newPos = (Σ w_k M_k) * pos; normal by its rotation part.
  const accView = (idx) => {
    const a = json.accessors[idx], bv = json.bufferViews[a.bufferView]
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]
    const csize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType]
    return { a, base: (bv.byteOffset || 0) + (a.byteOffset || 0), stride: bv.byteStride || comps * csize }
  }
  const pos = accView(at.POSITION), nor = accView(at.NORMAL), jnt = accView(at.JOINTS_0), wgt = accView(at.WEIGHTS_0)
  const readJoint = (o, i) => jnt.a.componentType === 5123 ? binChunk.readUInt16LE(o + i * 2) : binChunk.readUInt8(o + i)
  const count = json.accessors[at.POSITION].count
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < count; i++) {
    const jo = jnt.base + i * jnt.stride, wo = wgt.base + i * wgt.stride, po = pos.base + i * pos.stride, no = nor.base + i * nor.stride
    const w = [binChunk.readFloatLE(wo), binChunk.readFloatLE(wo + 4), binChunk.readFloatLE(wo + 8), binChunk.readFloatLE(wo + 12)]
    const wsum = w[0] + w[1] + w[2] + w[3]
    const p = [binChunk.readFloatLE(po), binChunk.readFloatLE(po + 4), binChunk.readFloatLE(po + 8)]
    if (wsum > 1e-8) {
      const S = new Array(16).fill(0)
      for (let z = 0; z < 4; z++) {
        if (w[z] === 0) continue
        const slot = readJoint(jo, z), m = M[slot], wn = w[z] / wsum
        for (let e = 0; e < 16; e++) S[e] += wn * m[e]
      }
      const np = m4Point(S, p)
      binChunk.writeFloatLE(np[0], po); binChunk.writeFloatLE(np[1], po + 4); binChunk.writeFloatLE(np[2], po + 8)
      const n = [binChunk.readFloatLE(no), binChunk.readFloatLE(no + 4), binChunk.readFloatLE(no + 8)]
      const rn = m4Dir(S, n), rl = v3len(rn) || 1
      binChunk.writeFloatLE(rn[0] / rl, no); binChunk.writeFloatLE(rn[1] / rl, no + 4); binChunk.writeFloatLE(rn[2] / rl, no + 8)
      p[0] = np[0]; p[1] = np[1]; p[2] = np[2]
    }
    minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); minZ = Math.min(minZ, p[2])
    maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); maxZ = Math.max(maxZ, p[2])
  }
  if (json.accessors[at.POSITION].min) {
    json.accessors[at.POSITION].min = [minX, minY, minZ]
    json.accessors[at.POSITION].max = [maxX, maxY, maxZ]
  }

  // New rest = the T-pose: inverseBindMatrices = inverse(poseWorld); arm node TRS updated
  // so their recomputed world == poseWorld (non-arm nodes keep their TRS, poseWorld==worldOld).
  for (let k = 0; k < joints.length; k++) {
    const inv = m4Invert(poseWorld[joints[k]])
    for (let e = 0; e < 16; e++) binChunk.writeFloatLE(inv[e], ibmBase + k * 64 + e * 4)
  }
  for (const j of [...inSubtree].sort((a, b) => {
    const d = (i) => { let n = 0, p = parent[i]; while (p >= 0) { n++; p = parent[p] } return n }
    return d(a) - d(b)
  })) {
    const p = parent[j]
    const local = p < 0 ? poseWorld[j] : m4Mul(m4Invert(poseWorld[p]), poseWorld[j])
    const { t, q, s } = m4Decompose(local)
    nodes[j].translation = t
    nodes[j].rotation = q
    nodes[j].scale = s
  }
}

/** File-in / file-out convenience used by the CLI and meshy.mjs build --vrm. */
export function convertGlbToVrm(inPath, outPath, opts = {}) {
  const title = opts.title || basename(outPath).replace(/\.vrm$/i, '')
  // opts.pbrFrom: path to the pre-rig gamemesh.glb to restore the PBR maps from.
  const pbrGlb = opts.pbrFrom && existsSync(opts.pbrFrom) ? readFileSync(opts.pbrFrom) : undefined
  const out = injectVrm0(readFileSync(inPath), { ...opts, title, pbrGlb })
  writeFileSync(outPath, out)
  return outPath
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , inPath, outPath, title] = process.argv
  if (!inPath || !outPath) {
    console.error('usage: node meshy2vrm.mjs <in-rigged.glb> <out.vrm> [title]')
    process.exit(2)
  }
  convertGlbToVrm(inPath, outPath, title ? { title } : {})
  console.error(`[meshy2vrm] wrote ${outPath}`)
}
