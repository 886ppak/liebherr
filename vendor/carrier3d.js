// 3D carrier (chassis) preview for the Outrigger Support Positioning tab.
// Loaded as a <script type="module">, same reasoning as cwt3d.js: can't see
// the main app's classic-script top-level bindings, talks back only via
// plain functions on window (__carrier3dActivate, __carrier3dSyncOutriggers).
//
// Deliberately much simpler than cwt3d.js: no partMap, no click selection/
// highlighting, no explode logic - the carrier is one rigid chassis, its
// own real assembled position from the CAD export IS the intended view, and
// its materials already carry the crane's own Liebherr colours baked in
// from Onshape, so nothing needs recolouring either. One scene/renderer/
// camera/controls set, reused across cranes the same way cwt3d.js does,
// keyed model cache so switching back to an already-viewed carrier doesn't
// re-fetch/re-parse its (multi-MB) model.
//
// Outrigger tie-in (methodology.txt 10.77): the site plan's own leg/pad
// positions (mm, relative to the slew center - see index.html's
// cadFleetData/calcCAD) are mapped onto the loaded CAD model's own local
// coordinate space using FOOTPRINTS' front/rear/width figures (the same
// OEM-sourced numbers the 2D plan already uses for its clash-detection
// footprint rectangle) - NOT by rescaling the model, which is already
// dimensionally accurate from the CAD export. Only a per-crane
// CARRIER_CALIBRATION flag (index.html) is needed: which end of the
// model's own bounding box is the front, confirmed by rendering a
// straight-down view and visually identifying the driving cab. See
// methodology.txt 10.76/10.77 for how each crane's flag was derived.

import * as THREE from 'three';
import { GLTFLoader } from './three/GLTFLoader.js';
import { DRACOLoader } from './three/DRACOLoader.js';
import { OrbitControls } from './three/OrbitControls.js';

// Same shared decoder path as cwt3d.js - both these carrier exports and the
// counterweight exports come out of Onshape Draco-compressed by default.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('./vendor/three/draco/');

let renderer = null, scene = null, camera = null, controls = null;
let currentModelKey = null;
let animating = false;
let outriggerGroup = null;

// modelKey -> THREE.Object3D (the loaded scene root)
const modelCache = {};
const loadingInProgress = {};
// Most recent __carrier3dSyncOutriggers() args per model, replayed once a
// still-loading model finishes - a sync call that arrives while the model
// is mid-fetch (very likely, since toggling 3D on and calcCAD() firing
// happen around the same time) would otherwise silently do nothing and
// never get another chance until the next unrelated input change.
const pendingSync = {};

function ensureRenderer() {
  if (renderer) return;
  const wrap = document.getElementById('carrier-3d-canvas-wrap');

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
  const wrap = document.getElementById('carrier-3d-canvas-wrap');
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
  outriggerGroup = null;
}

function clearOutriggers() {
  if (!outriggerGroup) return;
  scene.remove(outriggerGroup);
  outriggerGroup.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  outriggerGroup = null;
}

function loadGLTFAsync(url) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
  });
}

function frameCamera(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  camera.position.set(center.x + maxDim * 0.75, center.y + maxDim * 0.55, center.z + maxDim * 0.75);
  camera.near = maxDim / 100;
  camera.far = maxDim * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

// Nearly-but-not-quite straight down (0.5° off vertical) - true vertical is
// a degenerate case for OrbitControls (camera "up" and "forward" become
// parallel, its internal orientation math breaks), so this reads as a top
// view while staying fully compatible with drag-to-rotate afterwards.
// Doesn't touch camera.up at all, unlike an early debug-only version of
// this did - OrbitControls caches object.up at construction time and
// doesn't notice it changing later, which made dragging behave oddly
// after switching views. See methodology.txt 10.79.
function topView(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.z) || 1;
  const dist = maxDim * 1.3;
  const tiltRad = THREE.MathUtils.degToRad(0.5);
  camera.position.set(center.x, center.y + dist, center.z + dist * Math.sin(tiltRad));
  camera.near = dist / 100;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

window.__carrier3dFitView = function () {
  const root = modelCache[currentModelKey];
  if (root) frameCamera(root);
};

window.__carrier3dTopView = function () {
  const root = modelCache[currentModelKey];
  if (root) topView(root);
};

async function loadModel(modelKey, url, onDone) {
  if (modelCache[modelKey]) { onDone(modelCache[modelKey]); return; }
  if (loadingInProgress[modelKey]) return;
  loadingInProgress[modelKey] = true;

  const labelEl = document.getElementById('carrier-3d-label');
  labelEl.textContent = 'Loading 3D model…';

  try {
    const root = await loadGLTFAsync(url);
    root.updateMatrixWorld(true);
    modelCache[modelKey] = root;
    loadingInProgress[modelKey] = false;
    labelEl.textContent = 'Outrigger pad positions shown below are approximate - the CAD model is aligned to the site plan using the same OEM footprint figures, not survey-precise.';
    onDone(root);
  } catch (err) {
    loadingInProgress[modelKey] = false;
    labelEl.textContent = '3D model failed to load.';
    console.error('carrier3d load error', err);
  }
}

window.__carrier3dActivate = function (modelKey, url) {
  if (!url) return;
  ensureRenderer();
  resizeRenderer();

  if (currentModelKey === modelKey) return;
  clearScene();
  currentModelKey = modelKey;

  const cached = modelCache[modelKey];
  if (cached) {
    scene.add(cached);
    frameCamera(cached);
    document.getElementById('carrier-3d-label').textContent = 'Outrigger pad positions shown below are approximate - the CAD model is aligned to the site plan using the same OEM footprint figures, not survey-precise.';
    if (pendingSync[modelKey]) applySync(modelKey, cached, pendingSync[modelKey]);
  } else {
    loadModel(modelKey, url, (root) => {
      if (currentModelKey !== modelKey) return; // user switched away while loading
      scene.add(root);
      frameCamera(root);
      if (pendingSync[modelKey]) applySync(modelKey, root, pendingSync[modelKey]);
    });
  }
};

// Maps the CAD model's own bounding box onto the site plan's real-world mm
// coordinate space (relative to the slew center at x=0,y=0). Doesn't
// rescale the model itself - it's already dimensionally accurate from the
// CAD export, more so than the OEM-sheet-derived FOOTPRINTS approximation
// - only finds WHERE within that box the slew center sits, using
// FOOTPRINTS' front/rear as a fraction along the model's own measured
// length as a starting estimate. calibration.frontAtMinZ says which end of
// the box (min or max Z) is the front, confirmed per-crane by rendering a
// straight-down view and visually identifying the driving cab (see
// methodology.txt 10.77) - that's the one thing that can't be derived from
// the geometry alone. calibration.lateralSign flips left/right if a
// crane's export happens to have +X reading as the opposite side from the
// site plan's own "+X = right" convention.
function computeFormulaCalibration(root, footprint, calibration) {
  const box = new THREE.Box3().setFromObject(root);
  const groundY = box.min.y;
  const lateralCenter = (box.min.x + box.max.x) / 2;
  const measuredLength = box.max.z - box.min.z;
  const frontOverhang = footprint.front / 1000;
  const rearOverhang = footprint.rear / 1000;
  const total = frontOverhang + rearOverhang;
  const fractionFromFront = total > 0 ? frontOverhang / total : 0.5;
  const frontTipZ = calibration.frontAtMinZ ? box.min.z : box.max.z;
  // +1 when the front tip is at min Z (so moving toward the rear increases
  // Z, matching the site plan's own "rear = positive Y" convention
  // directly); -1 when the front tip is at max Z instead.
  const dirSign = calibration.frontAtMinZ ? 1 : -1;
  const slewZ = frontTipZ + dirSign * fractionFromFront * measuredLength;
  return { groundY, lateralCenter, slewZ, dirSign, lateralSign: calibration.lateralSign || 1 };
}

// The formula above gets the right general area, but a person comparing
// the rendered pad against the model's own outrigger beam/foot geometry
// noticed a real, visible offset (methodology.txt 10.78) - fair, since
// FOOTPRINTS' front/rear are OEM-sheet figures, not measured off this
// specific CAD export. When the model actually HAS outrigger geometry
// (not every crane's export does - LTM 1650's is missing one of the two
// beam pairs entirely, see 10.76/10.77), that geometry is a much better
// anchor than the formula: it's the real, exported thing, not a derived
// estimate. This finds each of the 4 corners' own farthest-reaching point
// (the outrigger foot sits at the very tip of the extended beam, so "most
// extreme point in that quadrant" finds it directly, without needing to
// identify which named part is "the foot" - there's nothing to name it by
// anyway, Onshape's own part names are all just "Part N") and nudges the
// formula's lateralCenter/slewZ so its OWN prediction for each real leg's
// CURRENT (unshifted) position lines up with that detected point exactly.
// Falls back to the unmodified formula wherever a quadrant's geometry
// can't be found or looks implausible (checked against that leg's own
// known r, so a missing beam pair - like 1650's rear one - doesn't get
// "corrected" using some unrelated far-off part instead).
function refineCalibrationFromGeometry(root, cal, calibration, baseLegs) {
  if (!baseLegs || !baseLegs.length) return cal;

  const corners = { '1_-1': null, '1_1': null, '-1_-1': null, '-1_1': null };
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const box = new THREE.Box3().setFromObject(obj);
    if (!isFinite(box.min.x)) return;
    [[box.min.x, box.min.z], [box.min.x, box.max.z], [box.max.x, box.min.z], [box.max.x, box.max.z]].forEach(([x, z]) => {
      const qx = x >= cal.lateralCenter ? 1 : -1;
      const qz = z >= cal.slewZ ? 1 : -1;
      const key = `${qx}_${qz}`;
      const reach = Math.abs(x - cal.lateralCenter);
      if (!corners[key] || reach > corners[key].reach) corners[key] = { x, z, reach };
    });
  });

  let dxSum = 0, dzSum = 0, matched = 0;
  baseLegs.forEach((leg) => {
    const siteIsRight = cal.lateralSign === 1 ? leg.x >= 0 : leg.x < 0;
    const siteIsFront = leg.y < 0; // site plan convention: front = negative Y
    const qx = siteIsRight ? 1 : -1;
    const wantMinZ = calibration.frontAtMinZ ? siteIsFront : !siteIsFront;
    const qz = wantMinZ ? -1 : 1;
    const corner = corners[`${qx}_${qz}`];
    if (!corner) return;

    const predicted = siteToWorld(cal, leg.x, leg.y);
    // Sanity check: a genuine match should be within the same ballpark as
    // this leg's own known reach (r), not e.g. the cab or tail block
    // standing in for a beam pair the model doesn't actually have.
    const detectedR = Math.hypot(corner.x - cal.lateralCenter, corner.z - cal.slewZ) * 1000;
    if (detectedR < leg.r * 0.5 || detectedR > leg.r * 1.5) return;

    dxSum += corner.x - predicted.x;
    dzSum += corner.z - predicted.z;
    matched++;
  });

  if (matched === 0) return cal;
  return { ...cal, lateralCenter: cal.lateralCenter + dxSum / matched, slewZ: cal.slewZ + dzSum / matched };
}

// Refinement involves a full scene traversal - worth doing once per model
// and reusing, not redoing on every calcCAD() (fires on every shift/pad
// input change, not just when the 3D preview is first opened).
const calibrationCache = {};
function computeCalibration(modelKey, root, footprint, calibration, baseLegs) {
  if (calibrationCache[modelKey]) return calibrationCache[modelKey];
  const formulaCal = computeFormulaCalibration(root, footprint, calibration);
  const refined = refineCalibrationFromGeometry(root, formulaCal, calibration, baseLegs);
  calibrationCache[modelKey] = refined;
  return refined;
}

// Site plan convention (see index.html): x = lateral, +right; y =
// longitudinal, front = negative Y, rear = positive Y. mm in, meters out.
function siteToWorld(cal, xMm, yMm) {
  return new THREE.Vector3(
    cal.lateralCenter + cal.lateralSign * (xMm / 1000),
    cal.groundY,
    cal.slewZ + cal.dirSign * (yMm / 1000)
  );
}

const PAD_CURRENT_COLOR = 0xe5a900; // matches the 2D plan's solid "current" pad
const PAD_GHOST_COLOR = 0x38bdf8;   // matches the 2D plan's dashed "if moved" pad
const LEG_MARKER_COLOR = 0xf8fafc;

// Transparent fill + dashed wireframe outline for a "this is where it'd be
// if moved" ghost - same visual language everywhere it's used (per-leg pad
// ghost, whole-chassis footprint ghost), matching the 2D plan's own dashed
// blue ghost styling rather than inventing a separate 3D convention.
function addGhostBox(group, sizeX, sizeY, sizeZ, position) {
  const geo = new THREE.BoxGeometry(sizeX, sizeY, sizeZ);
  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: PAD_GHOST_COLOR, transparent: true, opacity: 0.15 }));
  fill.position.copy(position);
  group.add(fill);

  const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineDashedMaterial({ color: PAD_GHOST_COLOR, dashSize: 0.15, gapSize: 0.1 }));
  wire.position.copy(position);
  wire.computeLineDistances();
  group.add(wire);
}

function applySync(modelKey, root, args) {
  clearOutriggers();
  const cal = computeCalibration(modelKey, root, args.footprint, args.calibration, args.baseLegs);
  outriggerGroup = new THREE.Group();

  // baseLegs (each leg's real CURRENT, unshifted x/y) rather than `leg`'s
  // own x/y - the 2D canvas's plotX/plotY already jumps a "must move" leg's
  // solid marker straight to its target spot (see calcCAD()'s own comment
  // on isRequired/plotX/plotY), which reads fine on the 2D plan itself but
  // isn't what's wanted here: the person wants the CURRENT bog mat left
  // exactly where it physically is, for every leg, so a shifted-in mat and
  // an unmoved one can be checked against each other for clashes at a
  // glance. See methodology.txt 10.80.
  const baseById = new Map((args.baseLegs || []).map(b => [b.id, b]));

  args.legs.forEach(leg => {
    const base = baseById.get(leg.id) || leg;
    const pos = siteToWorld(cal, base.x, base.y);

    // Flat and close to ground, deliberately not a tall pin - a raised
    // marker reads as visually offset from the real foot geometry in any
    // angled (non-top-down) view, from simple perspective, even once the
    // underlying X/Z position is exactly right (see methodology.txt
    // 10.78's own before/after comparison).
    const markerGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.05, 16);
    const markerMat = new THREE.MeshStandardMaterial({ color: LEG_MARKER_COLOR });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.set(pos.x, pos.y + 0.06, pos.z);
    outriggerGroup.add(marker);

    if (!leg.pad) return;

    const padGeo = new THREE.BoxGeometry(leg.pad.width / 1000, 0.08, leg.pad.length / 1000);
    const padMat = new THREE.MeshStandardMaterial({ color: PAD_CURRENT_COLOR, transparent: true, opacity: 0.9 });
    const padMesh = new THREE.Mesh(padGeo, padMat);
    padMesh.position.set(pos.x, pos.y + 0.04, pos.z);
    outriggerGroup.add(padMesh);

    // Ghost "if moved" pad, for every leg - not just the ones the 2D
    // canvas itself happens to ghost (it only ghosts "optional" legs,
    // since "must move" ones already show their solid marker at the
    // target spot there). leg.movedX/movedY is always the real fully-
    // shifted target regardless of required/optional (calcCAD() sets it
    // unconditionally), so this is correct for all four legs. Gated
    // behind compareMode, same as the whole-chassis ghost footprint.
    if (args.compareMode && (leg.movedX !== base.x || leg.movedY !== base.y)) {
      const movedPos = siteToWorld(cal, leg.movedX, leg.movedY);
      addGhostBox(outriggerGroup, leg.pad.width / 1000, 0.08, leg.pad.length / 1000, new THREE.Vector3(movedPos.x, movedPos.y + 0.04, movedPos.z));
    }
  });

  // Whole-chassis "if moved" ghost - person's own request after seeing the
  // per-leg pad ghosts (methodology.txt 10.79): a dashed, transparent box
  // showing where the CRANE ITSELF will sit after the shift, not another
  // full carrier model re-rendered at the new spot - same flat pad-style
  // box as the per-leg ghosts, just sized to the whole chassis footprint
  // (FOOTPRINTS, the same figures the 2D plan's own footprint rectangle
  // uses) rather than one pad. Gated behind compareMode, matching the 2D
  // plan's own drawFootprintBox() call exactly - only the per-leg ghost
  // pads are unconditional there, the whole-chassis ghost footprint
  // itself only shows once "Compare old/new position" is on.
  if (args.compareMode && (args.shiftX || args.shiftY)) {
    const fp = args.footprint;
    // The footprint rectangle isn't centered on the slew center in Y
    // (front/rear overhangs are asymmetric) - its own center sits
    // (rear-front)/2 behind the slew center, same rectangle the 2D
    // canvas's own drawFootprintBox() draws.
    const centerY = (fp.rear - fp.front) / 2;
    const newCenter = siteToWorld(cal, args.shiftX, centerY + args.shiftY);
    addGhostBox(outriggerGroup, fp.width / 1000, 0.1, (fp.front + fp.rear) / 1000, new THREE.Vector3(newCenter.x, newCenter.y + 0.05, newCenter.z));
  }

  scene.add(outriggerGroup);
}

// Called from calcCAD() whenever the outrigger tab recalculates, if this
// crane has a carrier model. footprint = FOOTPRINTS[modelKey], calibration
// = CARRIER_CALIBRATION[modelKey], legs = calcCAD()'s own mappedOutriggers
// array (same objects the 2D canvas draws from - x/y/movedX/movedY/pad
// mean exactly what they mean there, deliberately not reinterpreted here).
// baseLegs = each leg's own CURRENT (unshifted) r/x/y, straight from
// cadFleetData - used only once, to anchor the calibration against the
// model's real geometry (see refineCalibrationFromGeometry above); kept
// separate from `legs` since those reflect whatever the shift/pad inputs
// currently show, not necessarily the physical current position. shiftX/
// shiftY (mm, site plan's internal convention) and compareMode together
// drive the whole-chassis ghost footprint box - see methodology.txt 10.79.
window.__carrier3dSyncOutriggers = function (modelKey, footprint, calibration, legs, baseLegs, shiftX, shiftY, compareMode) {
  pendingSync[modelKey] = { footprint, calibration, legs, baseLegs, shiftX, shiftY, compareMode };
  if (currentModelKey !== modelKey || !scene) return;
  const root = modelCache[modelKey];
  if (!root) return; // still loading - applySync() replays this once it's in
  applySync(modelKey, root, pendingSync[modelKey]);
};
