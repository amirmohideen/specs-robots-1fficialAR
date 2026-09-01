// ─── GLB Export: bake assembly_sequence into GLB with animation channels ───
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

function easeFunc(t, type) {
  t = Math.max(0, Math.min(1, t));
  switch (type) {
    case 'ease-in': return t * t;
    case 'ease-out': return 1 - (1 - t) * (1 - t);
    case 'ease-in-out': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    default: return t;
  }
}

function smoothstep01(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Joints to drive during the demo segment. Order fixes phase offsets.
const DEMO_JOINTS = [
  'shoulder_pan',
  'shoulder_lift',
  'elbow_flex',
  'wrist_flex',
  'wrist_roll',
  'gripper',
];

// Per-joint demo tuning: amplitude fraction of the URDF range (0..1),
// frequency (Hz), and phase offset (in full cycles). Fallback limits are used
// when the URDF joint has no explicit limit (continuous / unlimited joints).
const DEMO_TUNING = {
  shoulder_pan:  { ampFrac: 0.45, freq: 0.12, phase: 0.00, fallback: [-1.4,  1.4] },
  shoulder_lift: { ampFrac: 0.35, freq: 0.15, phase: 0.17, fallback: [-1.2,  0.2] },
  elbow_flex:    { ampFrac: 0.45, freq: 0.13, phase: 0.34, fallback: [-0.2,  1.8] },
  wrist_flex:    { ampFrac: 0.40, freq: 0.18, phase: 0.51, fallback: [-1.0,  1.0] },
  wrist_roll:    { ampFrac: 0.55, freq: 0.22, phase: 0.68, fallback: [-2.8,  2.8] },
  gripper:       { ampFrac: 0.35, freq: 0.28, phase: 0.10, fallback: [-0.3,  0.0] },
};

function demoJointAngle(t, demoDuration, jointName, joint) {
  const tune = DEMO_TUNING[jointName] || { ampFrac: 0.3, freq: 0.15, phase: 0, fallback: [-1, 1] };

  // URDF joint limits — clamp our sweep to stay within them.
  let lower = joint?.limit?.lower;
  let upper = joint?.limit?.upper;
  if (lower == null || upper == null || !isFinite(lower) || !isFinite(upper) || upper <= lower) {
    [lower, upper] = tune.fallback;
  }

  const center = (lower + upper) / 2;
  const halfRange = (upper - lower) / 2;
  const amp = halfRange * tune.ampFrac;

  // Ease in from assembly end (joints at 0), ease out back to 0.
  const fadeIn = smoothstep01(0, 1.5, t);
  const fadeOut = 1 - smoothstep01(demoDuration - 2.5, demoDuration, t);
  const env = fadeIn * fadeOut;

  // Sweep the joint around its center. Use `center * env` so the motion
  // starts and ends at 0 (matching the post-assembly rest pose), while
  // still respecting URDF limits mid-sweep.
  const osc = amp * Math.sin(2 * Math.PI * (t * tune.freq + tune.phase));
  const target = center + osc;
  return target * env;
}

/**
 * Export the assembly sequence as a GLB with baked animation keyframes.
 *
 * Structure of the baked clip:
 *   [0, totalDuration]              — parts/screws animate onto the arm; joints stay at rest (0).
 *   [totalDuration, +demoDuration]  — fully assembled arm runs a choreographed joint sweep
 *                                     within each joint's URDF limits.
 *
 * Emits tracks on mesh nodes (part/screw position+quat+scale) AND on URDF joint
 * nodes (quaternion) inside the cloned export tree.
 */
export async function exportAssemblyGLB(
  robot, steps, totalDuration,
  originalTransforms, screw3DInstances, partsCatalog,
  linkLocalToWorld, worldToLinkLocal,
  opts = {}
) {
  const demoDuration = opts.demoDuration != null ? opts.demoDuration : 30;
  const FPS = opts.fps || 30;

  const newTotalDuration = totalDuration + demoDuration;
  const frameCount = Math.ceil(newTotalDuration * FPS) + 1;

  // ── Snapshot live state so we can restore it after the bake ──
  const meshSnapshots = [];
  robot.traverse(c => {
    if (!c.isMesh) return;
    meshSnapshots.push({
      mesh: c,
      pos: c.position.clone(),
      quat: c.quaternion.clone(),
      scale: c.scale.clone(),
      visible: c.visible,
      transparent: c.material?.transparent,
      opacity: c.material?.opacity,
      depthWrite: c.material?.depthWrite,
    });
  });
  const jointSnapshot = {};
  for (const [jn, j] of Object.entries(robot.joints || {})) {
    // urdf-loader stores current angle in `jointValue` (array) or `angle`
    jointSnapshot[jn] = (Array.isArray(j.jointValue) ? j.jointValue[0] : j.angle) ?? 0;
  }

  // Reset meshes to rest pose for cloning
  for (const [mesh, orig] of originalTransforms) {
    mesh.position.copy(orig.pos);
    mesh.quaternion.copy(orig.quat);
    mesh.visible = true;
    if (mesh.material) {
      mesh.material.transparent = false;
      mesh.material.opacity = 1;
      mesh.material.depthWrite = true;
    }
  }
  // Zero joints for a clean rest-pose clone
  for (const jn of Object.keys(robot.joints || {})) robot.setJointValue(jn, 0);
  robot.updateMatrixWorld(true);

  const exportRoot = robot.clone(true);

  // ── Map cloned nodes by name so we can name tracks + inject screws ──
  const clonedLinks = {};
  const clonedJoints = {};
  exportRoot.traverse(c => {
    if (!c.name) return;
    if (c.isURDFJoint || c.type === 'URDFJoint') {
      clonedJoints[c.name] = c;
    } else if (!c.isMesh) {
      clonedLinks[c.name] = c;
    }
  });
  if (exportRoot.frames) {
    for (const [name, obj] of Object.entries(exportRoot.frames)) {
      clonedLinks[name] = obj;
    }
  }
  // urdf-loader sometimes names joints with `_joint` suffix; check the live
  // robot.joints map and resolve cloned equivalents by traversal name.
  for (const jn of Object.keys(robot.joints || {})) {
    if (clonedJoints[jn]) continue;
    exportRoot.traverse(c => {
      if (!clonedJoints[jn] && c.name === jn) clonedJoints[jn] = c;
    });
  }

  // Screw clones live under their parent link in the export tree (so joint
  // rotations carry them correctly).
  const screwExportMeshes = new Map();
  for (const si of screw3DInstances) {
    const ann = si.annotation;
    const linkName = ann.link;
    const clonedLink = clonedLinks[linkName];
    if (!clonedLink) continue;

    const screwClone = si.mesh.clone();
    screwClone.material = si.mesh.material.clone();
    screwClone.visible = true;
    screwClone.material.transparent = false;
    screwClone.material.opacity = 1;

    const liveLinkObj = robot.frames[linkName] || robot;
    liveLinkObj.updateWorldMatrix(true, false);
    const worldPos = si.localPos.clone().applyMatrix4(liveLinkObj.matrixWorld);
    const worldNormal = si.normal.clone().transformDirection(liveLinkObj.matrixWorld);
    const restWorldPos = worldPos.clone().addScaledVector(worldNormal, -si.depth);
    const restWorldQuat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, -1, 0), worldNormal.clone().negate()
    );

    const invLinkMat = new THREE.Matrix4().copy(liveLinkObj.matrixWorld).invert();
    const localPos = restWorldPos.clone().applyMatrix4(invLinkMat);
    const linkWorldQuat = new THREE.Quaternion().setFromRotationMatrix(liveLinkObj.matrixWorld);
    const localQuat = restWorldQuat.clone().premultiply(linkWorldQuat.clone().invert());

    screwClone.position.copy(localPos);
    screwClone.quaternion.copy(localQuat);

    clonedLink.add(screwClone);
    screwExportMeshes.set(ann.name, {
      mesh: screwClone,
      localPos: localPos.clone(),
      localQuat: localQuat.clone(),
    });
  }

  // ── Pre-assign unique names to target mesh nodes so tracks resolve ──
  const usedNames = new Set();
  function uniqueName(baseName) {
    let name = baseName;
    let i = 1;
    while (usedNames.has(name)) name = `${baseName}_${i++}`;
    usedNames.add(name);
    return name;
  }

  const stepBindings = []; // { step, part, clonedMesh | screwExport, nodeName }
  for (const step of steps) {
    const part = partsCatalog.find(p => p.id === step.id);
    if (!part) continue;

    if (part.type === 'mesh' && part.mesh) {
      const liveMesh = part.mesh;
      const orig = originalTransforms.get(liveMesh);
      if (!orig) continue;
      const clonedMesh = findClonedMesh(exportRoot, liveMesh);
      if (!clonedMesh) continue;
      const nodeName = uniqueName(step.target || step.id);
      clonedMesh.name = nodeName;
      stepBindings.push({ kind: 'mesh', step, part, liveMesh, orig, clonedMesh, nodeName });
    } else if (part.type === 'screw') {
      const si = screw3DInstances.find(s => s.annotation.name === part.name);
      if (!si) continue;
      const screwExport = screwExportMeshes.get(part.name);
      if (!screwExport) continue;
      const nodeName = uniqueName(step.target || step.id);
      screwExport.mesh.name = nodeName;
      stepBindings.push({ kind: 'screw', step, part, si, screwExport, nodeName });
    }
  }

  // ── Allocate per-frame track buffers ──
  const times = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) times[f] = f / FPS;

  const meshBuffers = new Map(); // nodeName → { positions, quaternions, scales }
  for (const b of stepBindings) {
    meshBuffers.set(b.nodeName, {
      positions: new Float32Array(frameCount * 3),
      quaternions: new Float32Array(frameCount * 4),
      scales: new Float32Array(frameCount * 3),
    });
  }

  const jointBuffers = new Map(); // jointName → Float32Array(frameCount * 4)
  for (const jn of DEMO_JOINTS) {
    if (!robot.joints[jn] || !clonedJoints[jn]) continue;
    jointBuffers.set(jn, new Float32Array(frameCount * 4));
  }

  // ── Frame loop: set joints, update world, sample meshes + joints ──
  for (let f = 0; f < frameCount; f++) {
    const t = f / FPS;

    // Drive joints: 0 during assembly, demo sweep afterwards
    let inDemo = t >= totalDuration;
    for (const jn of Object.keys(robot.joints || {})) {
      let angle = 0;
      if (inDemo && jointBuffers.has(jn)) {
        angle = demoJointAngle(t - totalDuration, demoDuration, jn, robot.joints[jn]);
      }
      robot.setJointValue(jn, angle);
    }
    robot.updateMatrixWorld(true);

    // Sample joint quaternions
    for (const [jn, buf] of jointBuffers) {
      const q = robot.joints[jn].quaternion;
      buf[f * 4]     = q.x;
      buf[f * 4 + 1] = q.y;
      buf[f * 4 + 2] = q.z;
      buf[f * 4 + 3] = q.w;
    }

    // Sample mesh + screw steps
    for (const b of stepBindings) {
      const bufs = meshBuffers.get(b.nodeName);
      const step = b.step;
      const [tStart, tEnd] = step.time;
      const duration = tEnd - tStart;
      const defaultLead = b.kind === 'screw' ? 0.15 : 0.3;
      const fadeLead = step.fade_lead != null ? step.fade_lead : defaultLead;
      const fadeStart = tStart - fadeLead;

      const s = smoothstep01(fadeStart, tStart, t);
      bufs.scales[f * 3]     = s;
      bufs.scales[f * 3 + 1] = s;
      bufs.scales[f * 3 + 2] = s;

      const progress = duration > 0 ? Math.max(0, Math.min(1, (t - tStart) / duration)) : 1;
      const ep = easeFunc(progress, step.easing);
      const blend = 1 - ep;

      if (b.kind === 'mesh') {
        const linkObj = robot.frames[step.link];
        if (!linkObj) continue;

        const offsetPos = new THREE.Vector3(...step.start_offset.pos).multiplyScalar(blend);
        const offsetRot = new THREE.Euler(...step.start_offset.rot);
        const offsetQuat = new THREE.Quaternion().slerp(
          new THREE.Quaternion().setFromEuler(offsetRot), blend
        );

        const worldOff = linkLocalToWorld(offsetPos, linkObj);
        const meshParent = b.liveMesh.parent;
        const parentOff = meshParent ? worldToLinkLocal(worldOff, meshParent) : worldOff;

        const pos = b.orig.pos.clone().add(parentOff);
        bufs.positions[f * 3]     = pos.x;
        bufs.positions[f * 3 + 1] = pos.y;
        bufs.positions[f * 3 + 2] = pos.z;

        const q = new THREE.Quaternion().multiplyQuaternions(offsetQuat, b.orig.quat);
        bufs.quaternions[f * 4]     = q.x;
        bufs.quaternions[f * 4 + 1] = q.y;
        bufs.quaternions[f * 4 + 2] = q.z;
        bufs.quaternions[f * 4 + 3] = q.w;
      } else {
        const restLocalPos = b.screwExport.localPos;
        const restLocalQuat = b.screwExport.localQuat;

        const offsetLocal = new THREE.Vector3(...step.start_offset.pos).multiplyScalar(blend);
        const pos = restLocalPos.clone().add(offsetLocal);
        bufs.positions[f * 3]     = pos.x;
        bufs.positions[f * 3 + 1] = pos.y;
        bufs.positions[f * 3 + 2] = pos.z;

        const threadAngle = ep * (step.screw_rotations || 10) * Math.PI * 2;
        const localNormal = b.si.normal.clone().normalize();
        const threadQuat = new THREE.Quaternion().setFromAxisAngle(localNormal, threadAngle);
        const q = threadQuat.clone().multiply(restLocalQuat);
        bufs.quaternions[f * 4]     = q.x;
        bufs.quaternions[f * 4 + 1] = q.y;
        bufs.quaternions[f * 4 + 2] = q.z;
        bufs.quaternions[f * 4 + 3] = q.w;
      }
    }
  }

  // ── Restore live scene state ──
  for (const snap of meshSnapshots) {
    snap.mesh.position.copy(snap.pos);
    snap.mesh.quaternion.copy(snap.quat);
    snap.mesh.scale.copy(snap.scale);
    snap.mesh.visible = snap.visible;
    if (snap.mesh.material) {
      snap.mesh.material.transparent = snap.transparent;
      snap.mesh.material.opacity = snap.opacity;
      snap.mesh.material.depthWrite = snap.depthWrite;
    }
  }
  for (const [jn, angle] of Object.entries(jointSnapshot)) {
    if (robot.joints[jn]) robot.setJointValue(jn, angle);
  }
  robot.updateMatrixWorld(true);

  // ── Emit keyframe tracks ──
  const tracks = [];
  const timesArr = Array.from(times);

  for (const b of stepBindings) {
    const bufs = meshBuffers.get(b.nodeName);
    tracks.push(new THREE.VectorKeyframeTrack(`${b.nodeName}.position`, timesArr, Array.from(bufs.positions)));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.nodeName}.quaternion`, timesArr, Array.from(bufs.quaternions)));
    tracks.push(new THREE.VectorKeyframeTrack(`${b.nodeName}.scale`, timesArr, Array.from(bufs.scales)));
  }

  for (const [jn, buf] of jointBuffers) {
    const node = clonedJoints[jn];
    if (!node) continue;
    // Ensure the joint node has a resolvable name for the track selector
    if (!node.name) node.name = jn;
    tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, timesArr, Array.from(buf)));
  }

  if (tracks.length === 0) {
    throw new Error('No animation tracks generated — check that steps have valid parts');
  }

  const clip = new THREE.AnimationClip('AssemblyAnimation', newTotalDuration, tracks);
  exportRoot.animations = [clip];

  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      exportRoot,
      (result) => resolve(result),
      (error) => reject(error),
      { binary: true, animations: [clip] }
    );
  });
}

/**
 * Find the mesh in the cloned tree that corresponds to a live mesh.
 * Matches by traversal order + userData.filename.
 */
function findClonedMesh(clonedRoot, liveMesh) {
  const filename = liveMesh.userData?.filename;
  const livePath = getMeshPath(liveMesh);
  let bestMatch = null;

  clonedRoot.traverse(c => {
    if (!c.isMesh) return;
    if (filename && c.userData?.filename === filename) {
      const clonedPath = getMeshPath(c);
      if (pathsMatch(livePath, clonedPath)) {
        bestMatch = c;
      } else if (!bestMatch) {
        bestMatch = c;
      }
    }
  });

  return bestMatch;
}

function getMeshPath(mesh) {
  const path = [];
  let node = mesh;
  while (node) {
    path.unshift(node.name || '');
    node = node.parent;
  }
  return path;
}

function pathsMatch(a, b) {
  const minLen = Math.min(a.length, b.length);
  for (let i = 1; i <= minLen; i++) {
    if (a[a.length - i] !== b[b.length - i]) return false;
  }
  return true;
}

/**
 * Generate the LS config JSON combining VFX phases + mechanical steps.
 */
export function generateLSConfig(steps, totalDuration) {
  return {
    version: 2,
    duration: totalDuration,
    vfx_phases: {
      cuboids:  { start: 0.00, end: 0.25, fadeStart: 0.15, fadeEnd: 0.40 },
      circles:  { start: 0.10, end: 0.40, fadeStart: 0.35, fadeEnd: 0.55 },
      settle:   { start: 0.30, peak: 0.45, fallStart: 0.50, end: 0.60 },
      voxels:   { start: 0.35, end: 0.72, fadeStart: 0.60, fadeEnd: 0.72 },
      fresnel:  { start: 0.60, peak: 0.70, fallStart: 0.82, end: 0.95 },
      solid:    { start: 0.85, end: 1.00 },
    },
    vfx_timing: {
      phase_done: 1.10,
      link_stagger: 0.18,
      cuboid_stagger: 0.03,
    },
    mechanical_steps: steps.map(s => {
      const out = {
        id: s.id,
        target: s.target,
        link: s.link,
        offset_pos: s.start_offset.pos.map(v => Math.round(v * 1000000) / 1000000),
        offset_rot: s.start_offset.rot.map(v => Math.round(v * 1000000) / 1000000),
        time: s.time.map(v => Math.round(v * 100) / 100),
        easing: s.easing,
        fade_lead: s.fade_lead ?? (s.id.startsWith('screw/') ? 0.15 : 0.3),
      };
      if (s.screw_rotations) out.screw_rotations = s.screw_rotations;
      return out;
    }),
  };
}
