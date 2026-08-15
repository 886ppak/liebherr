// 3D counterweight viewer for the CWT Combinations tab. Loaded as a
// <script type="module">, so it can't see the main app's classic-script
// top-level `const`/`let` bindings - only its function declarations and
// whatever's been put on window explicitly (COUNTERWEIGHT_DATA,
// toggleCwtPlate). Talks back to the main app the same way: everything
// this file needs to expose is a plain function on window
// (__cwt3dActivate, __cwt3dOnRender), called directly from renderCwtTab()/
// setCwtView() in index.html.
//
// One scene/renderer/camera/controls set, reused and re-populated per
// crane rather than recreated - keyed cache of loaded GLTF scenes so
// switching back to a crane already viewed doesn't re-fetch/re-parse its
// (multi-MB) model. See methodology.txt 10.57.

import * as THREE from 'three';
import { GLTFLoader } from './three/GLTFLoader.js';
import { DRACOLoader } from './three/DRACOLoader.js';
import { OrbitControls } from './three/OrbitControls.js';

// Onshape's GLB export defaults to Draco-compressed geometry (confirmed
// after a person's standalone single-part export failed to load with
// "No DRACOLoader instance provided" - re-exporting without compression
// worked, but every crane's export defaults to compression on, so
// wiring up the decoder once here avoids relying on remembering to
// toggle it off on every future export). One shared decoder instance,
// reused across every GLTFLoader rather than spun up per load - it
// launches its own worker/wasm module, not free to recreate. Decoder
// files vendored locally (same as everything else this app loads - see
// methodology.txt 10.70), not fetched from Google's CDN.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('./vendor/three/draco/');

let renderer = null, scene = null, camera = null, controls = null;
let raycaster = null, mouse = null;
let currentModelKey = null;
let currentPartMap = null;
let animating = false;

// modelKey -> { root, namedParts: [{ appId, mesh, baseColor }] }
const modelCache = {};
// modelKey -> true once a load has started, so a second activate() while
// still loading doesn't kick off a duplicate fetch.
const loadingInProgress = {};

function ensureRenderer() {
  if (renderer) return;
  const wrap = document.getElementById('cwt-3d-canvas-wrap');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  wrap.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dir1 = new THREE.DirectionalLight(0xffffff, 1.0);
  dir1.position.set(1, 1, 1);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.35);
  dir2.position.set(-1, 0.4, -1);
  scene.add(dir2);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  renderer.domElement.addEventListener('click', onCanvasClick);
  window.addEventListener('resize', resizeRenderer);

  if (!animating) {
    animating = true;
    requestAnimationFrame(function loop() {
      requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    });
  }
}

function resizeRenderer() {
  const wrap = document.getElementById('cwt-3d-canvas-wrap');
  if (!renderer || !wrap || wrap.clientWidth === 0) return;
  camera.aspect = wrap.clientWidth / wrap.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);
}

function clearScene() {
  if (!scene) return;
  [...scene.children].forEach(obj => {
    if (obj.isLight) return;
    scene.remove(obj);
  });
}

// Gap left between adjacent faces of parts that are genuinely stacked on
// each other (model units = meters, confirmed against LTM 1130's own real
// plate weights/footprint - see methodology.txt 10.57). Easy to retune
// without touching any CAD export: this is the only number that matters.
const STACK_GAP = 0.12; // 120mm

// Moves each part clear of its neighbors so the assembly reads as an
// exploded view rather than its real assembled position (which is all the
// GLB stores). Works on "participants" rather than raw GLB nodes - a
// participant is either one GLB node, or several moving as ONE rigid
// block. A block is needed whenever a single partMap key maps several GLB
// nodes to the very same single app id AND that app id is a genuinely
// single physical item just split across several CAD bodies (LTM 1300's
// receptacle is 5 separate small CAD bodies, person-labelled "1"
// throughout to match the 2D diagram's one "Plate 1" label). It is NOT
// what's wanted for an app id that's mounted in multiple physically
// separate locations sharing one name/id purely because it's one
// both-or-neither toggle (LTM 1130's auxiliary ballast, mounted on
// opposite sides of the crane, both CAD bodies person-labelled identically
// "Auxiliary Ballast 8") - gluing THAT into one block combines two boxes
// on opposite sides of the crane into a bounding box centered back near
// the model's own middle, so it barely moves at all when pushed outward
// and visually overlaps the main stack instead of separating from it.
// The distinguishing signal already exists in the app's own component
// data rather than needing new CAD labelling conventions: `separate: true`
// (set on exactly this kind of both-or-neither, multi-location component
// for the 2D hotspot system's benefit, well before this 3D viewer
// existed) means "explode each instance independently"; its absence means
// "these bodies together are one physical item, move as a block." A lone
// node, or an array-mapped key like the two interchangeable Plate 3
// copies (which SHOULD separate from each other), still explodes
// node-by-node regardless of this flag. See methodology.txt 10.64.
//
// Two different moves, depending on what a participant actually is:
//  - Participants that share an XZ position with others (a true vertical
//    stack, like LTM 1130's six plates) get spaced by exactly STACK_GAP
//    between adjacent faces, in real units - not a proportional push, an
//    actual gap.
//  - Everything else (nothing else to line up against - e.g. LTM 1130's
//    winch/replacement-weight part, or an auxiliary ballast pair mounted
//    to the sides rather than stacked) gets pushed outward from the whole
//    model's center instead.
function explodeParts(root, groupsByKey, partMap, separateIds, stackTopIds) {
  // Box3.setFromObject and worldToLocal below both rely on current
  // matrixWorld values, which are otherwise only refreshed on render - at
  // this point the model hasn't been added to the scene yet, so force it.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const modelCenter = box.getCenter(new THREE.Vector3());
  const modelSize = box.getSize(new THREE.Vector3());
  const pushDistance = Math.max(modelSize.x, modelSize.y, modelSize.z) * 0.18;
  // Left/right mounted pairs (aux ballast, wing weights - anything flagged
  // `separate: true`) need to read as clearly split from EACH OTHER, not
  // just nudged off the main stack - the base pushDistance above was tuned
  // for that latter case and left genuinely paired items looking too close
  // together (LTM 1300's 5L/5R, 6L/6R - see methodology.txt 10.65). Only
  // affects participants whose app id is itself flagged separate, so a
  // crane's other, non-paired lone parts (e.g. LTM 1130's winch) are
  // untouched.
  const pairPushDistance = pushDistance * 1.6;

  const participants = [];
  // Parts flagged `explodeTop: true` (LTM 1130's winch/replacement-weight)
  // don't get the default radial push at all - they're mounted ON TOP of
  // the main stack in real life, off to one side in XZ, so the outward
  // push (tuned for genuinely side-mounted parts) shoved this one sideways
  // and left it hidden behind the stack from most camera angles instead of
  // reading as sitting on top of it. See placeAtStackTop() and
  // methodology.txt 10.66.
  const stackTopParticipants = [];
  groupsByKey.forEach((groupNodes, key) => {
    const mapping = partMap[key];
    const rigidBlock = !Array.isArray(mapping) && !separateIds.has(mapping) && groupNodes.length > 1;
    if (rigidBlock) {
      const combined = new THREE.Box3();
      groupNodes.forEach(g => combined.union(new THREE.Box3().setFromObject(g)));
      participants.push({ groups: groupNodes, center: combined.getCenter(new THREE.Vector3()), size: combined.getSize(new THREE.Vector3()) });
    } else {
      const isPair = !Array.isArray(mapping) && separateIds.has(mapping);
      const isStackTop = !Array.isArray(mapping) && stackTopIds.has(mapping);
      groupNodes.forEach(g => {
        const gBox = new THREE.Box3().setFromObject(g);
        const p = { groups: [g], center: gBox.getCenter(new THREE.Vector3()), size: gBox.getSize(new THREE.Vector3()), isPair };
        if (isStackTop) stackTopParticipants.push(p);
        else participants.push(p);
      });
    }
  });

  // Cluster by XZ proximity - true stacked plates share (near-)identical X
  // and Z, differing only in Y, however tall the stack; anything without a
  // match sits alone in its own single-member cluster. 50mm tolerance is
  // generous against real CAD-export precision (this model's actual match
  // is exact to several decimal places) while nowhere close to any real
  // plate's own footprint.
  const XZ_TOLERANCE = 0.05;
  const clusters = [];
  participants.forEach(p => {
    const cluster = clusters.find(c => {
      const ref = c[0];
      return Math.hypot(p.center.x - ref.center.x, p.center.z - ref.center.z) < XZ_TOLERANCE;
    });
    if (cluster) cluster.push(p); else clusters.push([p]);
  });

  // Track the biggest stack (the real plate stack, vs. any incidental
  // 2-member cluster) so explodeTop participants below have something
  // real to anchor to.
  let mainStack = null;
  clusters.forEach(cluster => {
    if (cluster.length > 1) {
      explodeStack(cluster);
      if (!mainStack || cluster.length > mainStack.length) mainStack = cluster;
    } else {
      const p = cluster[0];
      pushOutward(p, modelCenter, p.isPair ? pairPushDistance : pushDistance);
    }
  });

  if (mainStack) stackTopParticipants.forEach(p => placeAtStackTop(p, mainStack));
}

// Spaces a cluster of stacked participants evenly along whichever axis
// they're actually stacked on (the one with the most spread between their
// centers - Y for a normal vertical stack, but not assumed, in case a
// future crane's export is oriented differently).
//
// Ordered by BOTTOM edge (center - size/2), not center - confirmed against
// LTM 1300's real receptacle geometry (methodology.txt 10.65): its 5-body
// rigid block's combined bounding box is tall enough to span nearly the
// same range as plates 2-4 above it, so its combined CENTER lands mid-stack
// even though its base sits at the true bottom alongside plate 2's own
// base. Sorting by center put plate 2 underneath it; sorting by bottom edge
// puts the receptacle first, as it should be. The two even tie exactly on
// bottom edge (both start at the stack's true floor) - broken by size
// (larger footprint first) since a block whose base reaches this low while
// also being taller is the one everything above is actually resting on.
function explodeStack(cluster) {
  const spread = axis => Math.max(...cluster.map(p => p.center[axis])) - Math.min(...cluster.map(p => p.center[axis]));
  const axis = ['x', 'y', 'z'].reduce((a, b) => spread(b) > spread(a) ? b : a);

  const bottomEdge = p => p.center[axis] - p.size[axis] / 2;
  cluster.sort((a, b) => bottomEdge(a) - bottomEdge(b) || b.size[axis] - a.size[axis]);
  let edge = bottomEdge(cluster[0]);
  cluster.forEach(p => {
    const targetCenter = edge + p.size[axis] / 2;
    const delta = targetCenter - p.center[axis];
    const offset = new THREE.Vector3(0, 0, 0);
    offset[axis] = delta;
    p.groups.forEach(g => applyWorldOffset(g, offset));
    edge = targetCenter + p.size[axis] / 2 + STACK_GAP;
  });
}

function pushOutward(p, modelCenter, distance) {
  const dir = p.center.clone().sub(modelCenter);
  if (dir.lengthSq() < 1e-6) return;
  dir.normalize().multiplyScalar(distance);
  p.groups.forEach(g => applyWorldOffset(g, dir));
}

// Places a lone `explodeTop`-flagged part directly above the main stack,
// centered over its footprint (not the part's own original XZ position,
// wherever it happened to be mounted) - same STACK_GAP clearance as a
// real stacked plate would get. Generic over whichever axis the stack
// cluster is actually stacked on, same as explodeStack() itself.
function placeAtStackTop(p, stackCluster) {
  const spread = axis => Math.max(...stackCluster.map(m => m.center[axis])) - Math.min(...stackCluster.map(m => m.center[axis]));
  const axis = ['x', 'y', 'z'].reduce((a, b) => spread(b) > spread(a) ? b : a);
  const otherAxes = ['x', 'y', 'z'].filter(a => a !== axis);

  const topEdge = Math.max(...stackCluster.map(m => m.center[axis] + m.size[axis] / 2));
  const targetCenter = topEdge + STACK_GAP + p.size[axis] / 2;

  const offset = new THREE.Vector3(0, 0, 0);
  offset[axis] = targetCenter - p.center[axis];
  otherAxes.forEach(a => {
    const stackCenterOnAxis = stackCluster.reduce((sum, m) => sum + m.center[a], 0) / stackCluster.length;
    offset[a] = stackCenterOnAxis - p.center[a];
  });
  p.groups.forEach(g => applyWorldOffset(g, offset));
}

// group.position is interpreted in its PARENT's local space, and this
// model's CAD-exported occurrence nodes each carry a baked rotation
// (confirmed in the raw GLTF: every "occurrence of Part N" node has a
// rotation matrix, not just a translation). Adding a world-space offset
// straight to group.position ignores that rotation and pushes the part in
// the wrong direction - converting the target WORLD position into the
// parent's local space instead accounts for whatever rotation sits
// between this node and world space, however the export structured it.
// See methodology.txt 10.58.
function applyWorldOffset(group, worldOffset) {
  const worldPos = new THREE.Vector3();
  group.getWorldPosition(worldPos);
  const targetWorldPos = worldPos.add(worldOffset);
  group.position.copy(group.parent.worldToLocal(targetWorldPos));
}

// GLTFLoader auto-renames sibling nodes that share a name, appending
// "_1", "_2", etc (confirmed directly against LTM 1300's export - its
// receptacle is modeled as 5 separate small CAD parts, all named "1" by
// the person to match the 2D diagram's single "Plate 1" label, which
// GLTFLoader turns into "1", "1_1", "1_2", "1_3", "1_4"). Matches the
// EXACT node name against partMap first; only if that fails does it try
// stripping one trailing "_<digits>" and matching the base - so a
// genuinely distinct partMap key that happens to end in "_<digits>"
// (nothing does today, but nothing stops it) still wins outright, and
// this never fires at all for a model with no name collisions (e.g. LTM
// 1130's Part_1..Part_10, already unique, matched on the first try every
// time).
function partMapKeyFor(name, partMap) {
  if (partMap[name] !== undefined) return name;
  const m = /^(.*)_\d+$/.exec(name);
  if (m && partMap[m[1]] !== undefined) return m[1];
  return null;
}

function loadGLTFAsync(url) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
  });
}

async function loadModel(modelKey, data, onDone) {
  if (modelCache[modelKey]) { onDone(modelCache[modelKey]); return; }
  if (loadingInProgress[modelKey]) return;
  loadingInProgress[modelKey] = true;

  const labelEl = document.getElementById('cwt-3d-label');
  labelEl.textContent = 'Loading 3D model…';

  try {
    const root = await loadGLTFAsync(data.model3d.url);
    root.updateMatrixWorld(true);
    const partMap = data.model3d.partMap;
    // Components mounted in multiple physically separate locations under
    // one both-or-neither id (e.g. an auxiliary ballast pair) - see the
    // big comment on explodeParts() for why this has to come from the
    // app's own component data rather than being guessed from geometry.
    const separateIds = new Set(data.components.filter(c => c.separate).map(c => c.id));
    // Components mounted ON TOP of the main stack rather than beside it
    // (e.g. LTM 1130's winch/replacement-weight) - see placeAtStackTop()
    // and methodology.txt 10.66.
    const stackTopIds = new Set(data.components.filter(c => c.explodeTop).map(c => c.id));
    // Mutually-exclusive slot components (e.g. LTM 1110's Winch 2*/
    // Replacement Ballast, both mounted in the same physical position -
    // methodology.txt 10.7) need a click to CYCLE through the slot's
    // members, same as the 2D hotspot already does, rather than plain
    // toggle the one id whose mesh happens to be modeled. Looked up by
    // appId here so onCanvasClick() can tell the two cases apart without
    // needing its own copy of the app's component data.
    const slotGroupById = new Map(data.components.map(c => [c.id, c.slotGroup]));
    const namedParts = [];

    // A partMap entry is either a plain app id string (every matching-
    // named node, however many there are, gets that same id - the common
    // case) or an array of app ids, for a name shared by physically
    // distinct parts that need DIFFERENT ids (LTM 1300's two identical,
    // interchangeable Plate 3 copies -> p3a/p3b, both literally named "3"
    // in the CAD file with no way to tell them apart by name alone).
    // Array entries are assigned by position, sorted along whichever axis
    // has the most spread between that specific name-group's members -
    // not assumed to be Y, in case some future crane's pair sits side by
    // side instead of stacked.
    // Matched nodes are normally GLTFLoader "Group" type, but a part
    // that started life as a STEP reimport (see methodology.txt - the
    // fix for a composite part Onshape's assembly exporter otherwise
    // drops entirely) can land as plain "Object3D" instead - a real,
    // structural difference in how that one node came in, not a naming
    // quirk. Matching by name regardless of Group vs Object3D is safe
    // generally: the auto-generated "occurrence_of_X" wrapper nodes that
    // ARE Object3D everywhere else never coincidentally share a name
    // with a real partMap key (partMap only ever lists the part's own
    // name, never its occurrence wrapper's), so loosening this filter
    // doesn't risk matching the wrong node for any existing crane.
    const groupsByKey = new Map();
    root.traverse((obj) => {
      if (obj.type !== 'Group' && obj.type !== 'Object3D') return;
      const key = partMapKeyFor(obj.name, partMap);
      if (!key) return; // unmapped part - shown but not selectable
      if (!groupsByKey.has(key)) groupsByKey.set(key, []);
      groupsByKey.get(key).push(obj);
    });

    groupsByKey.forEach((groupNodes, key) => {
      const mapping = partMap[key];
      let assignments;
      if (Array.isArray(mapping)) {
        const withCenters = groupNodes.map(g => ({ group: g, center: new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3()) }));
        const spread = axis => Math.max(...withCenters.map(w => w.center[axis])) - Math.min(...withCenters.map(w => w.center[axis]));
        const axis = ['x', 'y', 'z'].reduce((a, b) => spread(b) > spread(a) ? b : a);
        withCenters.sort((a, b) => a.center[axis] - b.center[axis]);
        if (withCenters.length !== mapping.length) {
          console.warn(`cwt3d: "${key}" expected ${mapping.length} instance(s), found ${withCenters.length} - some app ids may be left unmatched.`);
        }
        assignments = withCenters.map((w, i) => [w.group, mapping[i]]).filter(([, appId]) => appId !== undefined);
      } else {
        assignments = groupNodes.map(g => [g, mapping]);
      }
      assignments.forEach(([group, appId]) => {
        group.traverse((child) => {
          if (child.isMesh) {
            child.material = child.material.clone();
            namedParts.push({ appId, slotGroup: slotGroupById.get(appId), glbName: group.name, mesh: child, group, baseColor: child.material.color.clone() });
          }
        });
      });
    });

    // model3d.preExploded: true - skip all of the above positioning
    // heuristics entirely and trust the CAD export's own positions as
    // already being the intended exploded view (person's own explode in
    // Onshape, not inferred). Opt-in per crane, since every crane shipped
    // before this flag existed relies on the automatic explode instead -
    // see methodology.txt 10.67.
    if (!data.model3d.preExploded) explodeParts(root, groupsByKey, partMap, separateIds, stackTopIds);

    // model3d.extraParts: supplementary GLBs loaded and placed alongside
    // the main model - for a part that can't come through the main
    // assembly's own GLB export at all (LTM 1110's Winch 2*/Replacement
    // Ballast lives in an Onshape Composite Part, which the assembly-level
    // exporter silently drops - confirmed by comparing instance counts,
    // not guessed). Exported as its own tiny standalone GLB instead. Each
    // one is treated as a single rigid whole (no partMap needed - it's
    // one dedicated file for one app id) and placed directly above the
    // WHOLE main model, centered - same idea as placeAtStackTop(), just
    // anchored to the full model's bounding box since there's no cluster
    // list to anchor to when the part lives in a separate file entirely.
    // See methodology.txt 10.69.
    const container = new THREE.Group();
    container.add(root);
    if (data.model3d.extraParts) {
      for (const extra of data.model3d.extraParts) {
        const extraRoot = await loadGLTFAsync(extra.url);
        // A standalone single-part export carries its own Part Studio's
        // default orientation, not the main assembly's - nothing ties the
        // two together the way a shared assembly file would. rotationX/Y/Z
        // (degrees) corrects that per part; applied before placement so
        // the centering math below measures the ALREADY-rotated box.
        if (extra.rotationX) extraRoot.rotation.x = THREE.MathUtils.degToRad(extra.rotationX);
        if (extra.rotationY) extraRoot.rotation.y = THREE.MathUtils.degToRad(extra.rotationY);
        if (extra.rotationZ) extraRoot.rotation.z = THREE.MathUtils.degToRad(extra.rotationZ);
        extraRoot.traverse((child) => {
          if (child.isMesh) {
            child.material = child.material.clone();
            namedParts.push({ appId: extra.appId, slotGroup: slotGroupById.get(extra.appId), glbName: child.name, mesh: child, group: extraRoot, baseColor: child.material.color.clone() });
          }
        });
        container.add(extraRoot);
        container.updateMatrixWorld(true);
        placeAboveWholeModel(extraRoot, root);
      }
    }

    const entry = { root: container, namedParts };
    modelCache[modelKey] = entry;
    loadingInProgress[modelKey] = false;
    onDone(entry);
  } catch (err) {
    loadingInProgress[modelKey] = false;
    labelEl.textContent = '3D model failed to load. Falling back to the 2D diagram is recommended.';
    console.error('cwt3d load error', err);
  }
}

// Places a supplementary part (its own separately-loaded GLB, see
// model3d.extraParts above) directly above the main model, centered over
// the TOP-MOST slab's own footprint specifically - not the whole model's
// footprint, which is usually wider/deeper (lower plates in a stack are
// often bigger than the top one), so centering on the whole model left
// the part looking offset toward a corner instead of centered on the
// plate it actually sits on. The top slab is found generically (every
// mesh whose own top edge sits within STACK_GAP of the model's highest
// point, unioned together) rather than by hardcoding which app id is
// "the top plate" - works for any crane's stack shape without
// crane-specific code. Y is hardcoded as "up" (not detected via
// explodeStack()'s "most spread axis" heuristic, which would pick the
// wrong axis for a whole model - reliably wider/deeper than tall), true
// for every crane export seen so far (gravity-aligned CAD).
function placeAboveWholeModel(extraGroup, mainRoot) {
  const meshBoxes = [];
  mainRoot.traverse((child) => { if (child.isMesh) meshBoxes.push(new THREE.Box3().setFromObject(child)); });
  const modelTop = Math.max(...meshBoxes.map(b => b.max.y));
  const topSlab = new THREE.Box3();
  meshBoxes.forEach(b => { if (b.max.y > modelTop - STACK_GAP) topSlab.union(b); });
  const slabCenter = topSlab.getCenter(new THREE.Vector3());

  const extraBox = new THREE.Box3().setFromObject(extraGroup);
  const extraCenter = extraBox.getCenter(new THREE.Vector3());
  const extraSize = extraBox.getSize(new THREE.Vector3());

  const targetY = modelTop + STACK_GAP + extraSize.y / 2;
  const offset = new THREE.Vector3(slabCenter.x - extraCenter.x, targetY - extraCenter.y, slabCenter.z - extraCenter.z);
  applyWorldOffset(extraGroup, offset);
}

// Straight-on front view (camera on the +Z axis looking back at the
// model, default camera.up), fit to the model's own bounding box rather
// than a fixed-margin guess - was a 3/4 angled view before, which on a
// wide model (e.g. LTM 1650's two side-by-side counterweight stacks)
// left one side sitting behind the model's own central bulk from the
// default angle, only visible after manually dragging to rotate. A
// front view puts X (left/right) and Y (up/down) on screen with nothing
// in between, so both sides are visible without needing to rotate at
// all. Distance is derived from the camera's actual vertical FOV and
// aspect ratio (same approach as carrier3d.js's fitView), fit against
// whichever of X/Y is the binding constraint for the canvas's own
// shape, so nothing gets cropped on a non-square canvas. See
// methodology.txt 10.88.
function frameCamera(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const aspect = camera.aspect || 1;
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const halfY = Math.max(size.y, 0.5) / 2;
  const halfX = Math.max(size.x, 0.5) / 2;
  // The model has real depth (size.z) - its own front (near-camera) face
  // sits halfZ CLOSER to the camera than the box's center, which this
  // distance is measured from. A perspective camera magnifies whatever's
  // closer, so fitting purely off the center depth under-shoots for
  // anything with real thickness (confirmed against LTR 1220, whose
  // counterweight is nearly as deep as it is tall - its front plate
  // visibly clipped past the frame edges before this was added). Adding
  // halfZ to each required distance keeps the fit valid at the NEAREST
  // point of the model, not just its average depth - harmless no-op for
  // a genuinely flat model (halfZ ~ 0) and the fix for a thick one.
  const halfZ = Math.max(size.z, 0.5) / 2;
  const distForY = halfY / Math.tan(fovRad / 2) + halfZ;
  const distForX = halfX / (Math.tan(fovRad / 2) * aspect) + halfZ;
  const dist = Math.max(distForY, distForX) * 1.15; // 15% margin so nothing sits flush against the edge
  camera.position.set(center.x, center.y, center.z + dist);
  camera.near = dist / 100;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

// Ambiguous-slot components (e.g. LTM 1110's Winch 2*/Replacement Ballast
// slotGroup pair, methodology.txt 10.7/10.70) need the same cycling
// behavior the 2D hotspot already has - clicking cycles none -> first
// member -> second member -> none, rather than a plain toggle of
// whichever one happens to have a 3D mesh. slotGroup is looked up per
// namedPart at load time (see loadModel()) so this only needs to check
// which case applies, not know anything about the app's own component
// data itself.
function onCanvasClick(ev) {
  if (!currentModelKey) return;
  const entry = modelCache[currentModelKey];
  if (!entry) return;
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(entry.namedParts.map(p => p.mesh), false);
  if (!hits.length) return;
  const hit = entry.namedParts.find(p => p.mesh === hits[0].object);
  if (!hit) return;
  if (hit.slotGroup && window.cycleCwtSlotGroup) window.cycleCwtSlotGroup(hit.slotGroup);
  else if (window.toggleCwtPlate) window.toggleCwtPlate(hit.appId);
}

const SELECTED_COLOR = new THREE.Color(0x10b981);
// A slot's OTHER member is selected instead of this mesh's own appId (e.g.
// LTM 1110's Replacement Ballast chosen over Winch 2* - the slot only has
// geometry for one of its two members, see methodology.txt 10.69/10.72).
// Without this, picking the member with no mesh made the slot's only
// visible geometry fall back to baseColor - visually identical to nothing
// being selected at all, even though the slot IS occupied. Distinct color
// from SELECTED_COLOR so "this slot is filled, just not by what you're
// looking at" reads differently from "this exact part is selected."
const ALT_SELECTED_COLOR = new THREE.Color(0xec4899);

function syncHighlight(modelKey, data, selectedSet) {
  const entry = modelCache[modelKey];
  if (!entry) return;
  entry.namedParts.forEach(p => {
    let color = p.baseColor;
    if (selectedSet.has(p.appId)) {
      color = SELECTED_COLOR;
    } else if (p.slotGroup) {
      const altSelected = data.components.some(c => c.slotGroup === p.slotGroup && c.id !== p.appId && selectedSet.has(c.id));
      if (altSelected) color = ALT_SELECTED_COLOR;
    }
    p.mesh.material.color.copy(color);
  });
  const labelEl = document.getElementById('cwt-3d-label');
  const selectedNames = entry.namedParts
    .filter(p => selectedSet.has(p.appId))
    .map(p => p.appId);
  const uniqueSelected = [...new Set(selectedNames)];
  labelEl.textContent = uniqueSelected.length
    ? `Selected: ${uniqueSelected.length} part(s)`
    : 'Tap a plate to select it';
}

window.__cwt3dActivate = function (modelKey, data, selectedSet) {
  if (!data || !data.model3d) return;
  ensureRenderer();
  resizeRenderer();

  if (currentModelKey !== modelKey) {
    clearScene();
    currentModelKey = modelKey;
    currentPartMap = data.model3d.partMap;

    const cached = modelCache[modelKey];
    if (cached) {
      scene.add(cached.root);
      frameCamera(cached.root);
      syncHighlight(modelKey, data, selectedSet);
    } else {
      loadModel(modelKey, data, (entry) => {
        if (currentModelKey !== modelKey) return; // user switched away while loading
        scene.add(entry.root);
        frameCamera(entry.root);
        syncHighlight(modelKey, data, selectedSet);
      });
    }
  } else {
    syncHighlight(modelKey, data, selectedSet);
  }
};

// Called on every renderCwtTab() regardless of which view is active - only
// touches the 3D scene when it's actually visible and already loaded, so
// this is cheap/no-op the vast majority of the time (2D view, or a crane
// with no model3d at all).
window.__cwt3dOnRender = function (modelKey, data, selectedSet) {
  const wrap = document.getElementById('cwt-3d-wrap');
  if (!wrap || wrap.style.display === 'none') return;
  if (!data || !data.model3d) return;
  if (currentModelKey === modelKey) syncHighlight(modelKey, data, selectedSet);
};
