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
let slewCircleGroup = null;
let legDimensionGroup = null;
let groundLayoutGroup = null;
let matEdgeGroup = null;
// Which DOM wrap/label the single shared canvas is currently parented
// into - there are two possible mount points now (Support Pad Placement's
// own 3D card, and Crane Layout's own 3D card), never both showing at
// once since the two sub-tabs are mutually exclusive, so ONE renderer
// genuinely reused by re-parenting its canvas is simpler and cheaper than
// two concurrent WebGL contexts loading/holding the same multi-MB model
// twice. See __carrier3dActivate below for how a wrap change is handled.
let currentWrapId = null;
let currentLabelId = null;

// modelKey -> THREE.Object3D (the loaded scene root)
const modelCache = {};
const loadingInProgress = {};
// Most recent __carrier3dSyncOutriggers() args per model, replayed once a
// still-loading model finishes - a sync call that arrives while the model
// is mid-fetch (very likely, since toggling 3D on and calcCAD() firing
// happen around the same time) would otherwise silently do nothing and
// never get another chance until the next unrelated input change.
const pendingSync = {};
// Same replay-once-loaded reasoning as pendingSync, for the 360 slew
// clearance radius circles (index.html's Crane Setup sub-tab toggles -
// see __carrier3dSetSlewCircles below). Kept as its own map, not merged
// into pendingSync, since the two are toggled completely independently
// (outrigger sync fires automatically on every calcCAD() recalc; slew
// circles only change when the person explicitly checks/unchecks one).
const pendingSlewCircles = {};
// footprint/calibration args accompanying the most recent
// __carrier3dSetSlewCircles() call per model - needed alongside
// pendingSlewCircles when replaying a circle draw for a model that was
// still mid-fetch at the time (see ensureSlewCalibration's own comment
// on why a fallback calibration needs these).
const pendingSlewCircleContext = {};
// Same replay-once-loaded pattern again, for the Crane Layout tab's
// outrigger-leg dimension lines (slew centre -> each of C1-C4, OEM-
// drawing style - see __carrier3dSetLegDimensions below). A third
// independent toggle, kept in its own pair of maps rather than merged
// into the slew-circle ones since it's a genuinely separate on/off
// switch the person flips independently of the radius circles.
const pendingLegDimensions = {};
const pendingLegDimensionContext = {};
// Same replay-once-loaded pattern again, for the Crane Layout tab's ground
// layout marks (paint-it-out-on-soil dimensions - see
// __carrier3dSetGroundLayoutMarks below). A fourth independent toggle, own
// pair of maps, same reasoning as pendingLegDimensions above - it's a
// genuinely separate on/off switch from the diagonal C1-C4 lines, even
// though both are Crane Layout-only and both key off the same crane.
const pendingGroundLayoutMarks = {};
const pendingGroundLayoutContext = {};
// Same replay-once-loaded pattern again, for Support Pad Placement's own
// mat edge marks toggle (see __carrier3dSetMatEdgeMarks below) - a fifth
// independent toggle, own pair of maps, same reasoning as every other one
// above: it's flipped independently of everything else drawn on this
// shared canvas.
const pendingMatEdgeMarks = {};
const pendingMatEdgeContext = {};

// Creates the renderer on first-ever call; every call after that just
// re-parents the existing canvas into whichever wrapId was requested (a
// no-op DOM-wise if it's already there). Returns true when the canvas
// actually moved to a DIFFERENT wrap than before (including the very
// first placement) - __carrier3dActivate uses that to know whether a
// same-model reactivation needs to drop the previous context's overlays
// (outrigger markers / slew circles) before applying its own.
function ensureRenderer(wrapId, labelId) {
  currentLabelId = labelId;
  const wrap = document.getElementById(wrapId);

  if (renderer) {
    const moved = currentWrapId !== wrapId;
    if (moved) {
      wrap.appendChild(renderer.domElement);
      currentWrapId = wrapId;
    }
    return moved;
  }

  currentWrapId = wrapId;
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
  return true;
}

function resizeRenderer() {
  const wrap = document.getElementById(currentWrapId);
  if (!renderer || !wrap || wrap.clientWidth === 0) return;
  camera.aspect = wrap.clientWidth / wrap.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(wrap.clientWidth, wrap.clientHeight);
}

// Disposes geometry, material AND any texture the material holds (map) -
// plain material.dispose() alone leaks a canvas texture (the dimension-
// line labels' Sprites, see makeTextSprite) since Three.js doesn't cascade
// texture disposal automatically. Shared by every clearXxx() below.
function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
}

function clearScene() {
  if (!scene) return;
  [...scene.children].forEach(obj => {
    if (obj.isLight) return;
    scene.remove(obj);
  });
  outriggerGroup = null;
  slewCircleGroup = null;
  legDimensionGroup = null;
  groundLayoutGroup = null;
  matEdgeGroup = null;
}

function clearOutriggers() {
  if (!outriggerGroup) return;
  scene.remove(outriggerGroup);
  disposeGroup(outriggerGroup);
  outriggerGroup = null;
}

function clearSlewCircles() {
  if (!slewCircleGroup) return;
  scene.remove(slewCircleGroup);
  disposeGroup(slewCircleGroup);
  slewCircleGroup = null;
}

function clearLegDimensions() {
  if (!legDimensionGroup) return;
  scene.remove(legDimensionGroup);
  disposeGroup(legDimensionGroup);
  legDimensionGroup = null;
}

function clearGroundLayoutMarks() {
  if (!groundLayoutGroup) return;
  scene.remove(groundLayoutGroup);
  disposeGroup(groundLayoutGroup);
  groundLayoutGroup = null;
}

function clearMatEdgeMarks() {
  if (!matEdgeGroup) return;
  scene.remove(matEdgeGroup);
  disposeGroup(matEdgeGroup);
  matEdgeGroup = null;
}

function loadGLTFAsync(url) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
  });
}

// Default 3/4 angled view shown the moment a carrier is opened, before the
// person has had a chance to click Fit View - just the model's own
// bounding box, since the outrigger sync (markers/pads/ghosts) hasn't run
// yet at this point (see __carrier3dActivate below).
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

// Bounding box of everything currently visible - the carrier model itself,
// any markers/pads/ghost boxes from the outrigger sync (see applySync),
// AND any slew-radius circles (see applySlewCircles) - not just the
// model's own footprint, since a shifted ghost footprint, an outrigger
// ghost pad, or (especially) a slew circle can sit well outside the
// carrier's own bounding box - a 1650 at its 8.4m ballast radius is a
// good example, a ring far wider than the carrier itself. Without
// including it here, Fit View would frame just the model and clip the
// circle off-screen.
function sceneBox() {
  const box = new THREE.Box3();
  const root = modelCache[currentModelKey];
  if (root) box.union(new THREE.Box3().setFromObject(root));
  if (outriggerGroup) box.union(new THREE.Box3().setFromObject(outriggerGroup));
  if (slewCircleGroup) box.union(new THREE.Box3().setFromObject(slewCircleGroup));
  if (legDimensionGroup) box.union(new THREE.Box3().setFromObject(legDimensionGroup));
  if (groundLayoutGroup) box.union(new THREE.Box3().setFromObject(groundLayoutGroup));
  if (matEdgeGroup) box.union(new THREE.Box3().setFromObject(matEdgeGroup));
  return box;
}

// Bird's-eye (top-down), zoomed to fit everything currently drawn. Used to
// be two separate buttons - an angled "Fit View" that only fit the model
// itself, and a separate straight-down "Top View" - person asked to fold
// them into one, since there's no real use for the angled fit once the
// bird's-eye view already fits everything on screen. See
// methodology.txt 10.85.
//
// Nearly-but-not-quite straight down (0.5° off vertical) - true vertical is
// a degenerate case for OrbitControls (camera "up" and "forward" become
// parallel, its internal orientation math breaks). Doesn't touch camera.up
// at all - OrbitControls caches object.up at construction time and doesn't
// notice it changing later, which made dragging behave oddly after
// switching views in an earlier version of this. See methodology.txt
// 10.79.
//
// Distance is derived from the camera's own vertical FOV and current
// aspect ratio, fit against whichever of the two horizontal axes (lateral
// X, longitudinal Z) actually constrains the canvas's own shape - a fixed-
// margin guess (what this used to do) can crop one axis on a canvas that
// isn't roughly square.
function fitView() {
  const box = sceneBox();
  if (!isFinite(box.min.x)) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const aspect = camera.aspect || 1;
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const halfZ = Math.max(size.z, 0.5) / 2;
  const halfX = Math.max(size.x, 0.5) / 2;
  const distForZ = halfZ / Math.tan(fovRad / 2);
  const distForX = halfX / (Math.tan(fovRad / 2) * aspect);
  const dist = Math.max(distForZ, distForX) * 1.15; // 15% margin so nothing sits flush against the edge
  const tiltRad = THREE.MathUtils.degToRad(0.5);
  camera.position.set(center.x, center.y + dist, center.z + dist * Math.sin(tiltRad));
  camera.near = dist / 100;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

window.__carrier3dFitView = function () {
  if (modelCache[currentModelKey]) fitView();
};

// Only ever shown for a transient loading/error state now - the
// permanent "positions are approximate" disclaimer that used to sit here
// covered a chunk of the model itself and stayed up the whole time the
// preview was open, so it's gone (see methodology.txt 10.86). Hidden
// entirely rather than left as an empty padded chip once there's nothing
// to say.
function setLabel(text) {
  const el = document.getElementById(currentLabelId);
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? '' : 'none';
}

async function loadModel(modelKey, url, onDone) {
  if (modelCache[modelKey]) { onDone(modelCache[modelKey]); return; }
  if (loadingInProgress[modelKey]) return;
  loadingInProgress[modelKey] = true;

  setLabel('Loading 3D model…');

  try {
    const root = await loadGLTFAsync(url);
    root.updateMatrixWorld(true);
    modelCache[modelKey] = root;
    loadingInProgress[modelKey] = false;
    setLabel('');
    onDone(root);
  } catch (err) {
    loadingInProgress[modelKey] = false;
    setLabel('3D model failed to load.');
    console.error('carrier3d load error', err);
  }
}

// wrapId/labelId identify WHICH 3D card is asking (Support Pad
// Placement's own card, or Crane Layout's own card - see index.html).
// Both share this one renderer/scene (see ensureRenderer's own comment on
// why), so switching between them re-parents the canvas rather than
// spinning up a second WebGL context.
window.__carrier3dActivate = function (modelKey, url, wrapId, labelId) {
  if (!url) return;
  const wrapChanged = ensureRenderer(wrapId, labelId);
  resizeRenderer();

  if (currentModelKey === modelKey && !wrapChanged) return; // truly nothing to do

  if (currentModelKey !== modelKey) {
    clearScene(); // full swap - drops the old model, outriggers AND circles
    currentModelKey = modelKey;
  } else {
    // Same model, but a different card just took ownership of the shared
    // canvas - drop whatever overlays the PREVIOUS context had drawn
    // (outrigger markers if Pad Placement had it open, or slew circles if
    // Layout did) without touching the model itself, which is still
    // correct and already in the scene. The card that just activated
    // will push its own fresh overlay state (sync or circles) right after
    // this call returns, same as it always does - see toggleCarrier3D()/
    // toggleCarrier3DLayout() in index.html - so nothing needs replaying
    // from here for the synchronous case; only the pendingSync/
    // pendingSlewCircles replay below (for a model still mid-fetch) is
    // this function's own responsibility.
    clearOutriggers();
    clearSlewCircles();
    clearLegDimensions();
    clearGroundLayoutMarks();
    clearMatEdgeMarks();
  }

  const cached = modelCache[modelKey];
  if (cached) {
    scene.add(cached); // safe even if already a child of this scene
    frameCamera(cached);
    setLabel('');
    if (pendingSync[modelKey]) applySync(modelKey, cached, pendingSync[modelKey]);
    if (pendingSlewCircles[modelKey]) {
      const ctx = pendingSlewCircleContext[modelKey] || {};
      applySlewCircles(modelKey, cached, pendingSlewCircles[modelKey], ctx.footprint, ctx.calibration, ctx.carrierWidthMm);
    }
    if (pendingLegDimensions[modelKey]) {
      const ctx = pendingLegDimensionContext[modelKey] || {};
      applyLegDimensions(modelKey, cached, pendingLegDimensions[modelKey], ctx.footprint, ctx.calibration);
    }
    if (pendingGroundLayoutMarks[modelKey]) {
      const ctx = pendingGroundLayoutContext[modelKey] || {};
      applyGroundLayoutMarks(modelKey, cached, pendingGroundLayoutMarks[modelKey], ctx.footprint, ctx.calibration);
    }
    if (pendingMatEdgeMarks[modelKey]) {
      const ctx = pendingMatEdgeContext[modelKey] || {};
      applyMatEdgeMarks(modelKey, cached, pendingMatEdgeMarks[modelKey], ctx.footprint, ctx.calibration);
    }
  } else {
    loadModel(modelKey, url, (root) => {
      if (currentModelKey !== modelKey) return; // user switched away while loading
      scene.add(root);
      frameCamera(root);
      if (pendingSync[modelKey]) applySync(modelKey, root, pendingSync[modelKey]);
      if (pendingSlewCircles[modelKey]) {
        const ctx = pendingSlewCircleContext[modelKey] || {};
        applySlewCircles(modelKey, root, pendingSlewCircles[modelKey], ctx.footprint, ctx.calibration, ctx.carrierWidthMm);
      }
      if (pendingLegDimensions[modelKey]) {
        const ctx = pendingLegDimensionContext[modelKey] || {};
        applyLegDimensions(modelKey, root, pendingLegDimensions[modelKey], ctx.footprint, ctx.calibration);
      }
      if (pendingGroundLayoutMarks[modelKey]) {
        const ctx = pendingGroundLayoutContext[modelKey] || {};
        applyGroundLayoutMarks(modelKey, root, pendingGroundLayoutMarks[modelKey], ctx.footprint, ctx.calibration);
      }
      if (pendingMatEdgeMarks[modelKey]) {
        const ctx = pendingMatEdgeContext[modelKey] || {};
        applyMatEdgeMarks(modelKey, root, pendingMatEdgeMarks[modelKey], ctx.footprint, ctx.calibration);
      }
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
// site plan's own "+X = right" convention. xSlope/zSlope are world-metres
// per site-plan-millimetre - always -0.001 or +0.001 here (the formula
// trusts the CAD export's own scale exactly); refineCalibrationFromGeometry
// below may replace them with a measured slope instead.
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
  const lateralSign = calibration.lateralSign || 1;
  const slewZ = frontTipZ + dirSign * fractionFromFront * measuredLength;
  return { groundY, lateralCenter, slewZ, xSlope: lateralSign / 1000, zSlope: dirSign / 1000 };
}

// Ordinary least-squares line fit, y = slope*x + intercept. Returns null
// with fewer than 2 points (a line isn't determined) or when every x is
// identical (vertical line, no defined slope) - refineCalibrationFromGeometry
// falls back to the formula's own estimate for that axis in either case.
function linearFit(pairs) {
  if (pairs.length < 2) return null;
  const n = pairs.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  pairs.forEach(([x, y]) => { sx += x; sy += y; sxy += x * y; sxx += x * x; });
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

// The formula above gets the right general area, but a person comparing
// the rendered pad against the model's own outrigger beam/foot geometry
// noticed a real, visible offset (methodology.txt 10.78) - fair, since
// FOOTPRINTS' front/rear are OEM-sheet figures, not measured off this
// specific CAD export. When the model actually HAS outrigger geometry
// (not every crane's export does - LTM 1650's is missing one of the two
// beam pairs entirely, see 10.76/10.77), that geometry is a much better
// anchor than the formula: it's the real, exported thing, not a derived
// estimate.
//
// For each of the 4 corners, identifies the outrigger FOOT PLATE
// specifically (not the beam it's bolted to, not the jack cylinder above
// it, not incidental nearby hardware) and uses its bounding-box centre as
// the detected point, matched to its real P-id and fed into a per-axis
// least-squares line fit (site mm -> world metres) across however many
// legs' geometry could be confirmed - a per-axis LINE fit, not a single
// averaged offset applied uniformly to every leg, since a uniform
// translation can't correct a genuine per-leg/scale mismatch (only a
// constant frame offset). Falls back to the formula's own slope/intercept
// per-axis wherever fewer than 2 legs' geometry could be confirmed for
// that axis (checked against each leg's own known r, so a missing beam
// pair - like 1650's rear one - doesn't get "corrected" using some
// unrelated far-off part instead).
//
// Identifying "the foot plate" took three attempts before landing on
// something that actually works, root-caused off a person's own
// screenshot that still showed a real, visible offset even in a straight-
// down Top View (where camera-angle parallax can't be the explanation).
// See methodology.txt 10.81 for the full trail:
//   1. Farthest-reaching single VERTEX in each quadrant - wrong, because a
//      long rectangular BEAM's own extreme corner is a real vertex too
//      (unlike a round foot's bounding-box corner, which isn't a point on
//      the shape at all), so this just found the beam's own tip.
//   2. Most compact single MESH - also wrong: this Onshape export splits
//      every real part into hundreds of tiny per-face sub-meshes
//      (millimetre-scale bolt heads, decals, fillets - confirmed by
//      dumping every mesh within 1.5m of one corner and finding 500+ of
//      them), so "compact" just found some near-zero-size decal.
//   3. What works: aggregate sub-meshes back into their own PART first
//      (each real Onshape part occupies exactly one parent node in this
//      export), THEN filter to parts within 15cm of the model's own
//      lowest point (the foot plate TOUCHES THE GROUND - the cylinder
//      above it, the beam, and nearby hardware don't), THEN take the
//      LARGEST footprint among those ground-level survivors (the plate
//      itself, not incidental ground-adjacent hardware).
function refineCalibrationFromGeometry(root, cal, calibration, baseLegs) {
  if (!baseLegs || !baseLegs.length) return cal;

  // Tracks each part's combined bounding box (for the ground/reach/
  // footprint filtering below) AND its vertex centroid (sum + count) -
  // used instead of the bounding-box centre for the part that actually
  // wins, since a plate with any asymmetric detail (an off-centre
  // mounting boss, a bracket on one side) pulls its own bounding-box
  // centre away from where the part visually/physically centres, while
  // the vertex centroid isn't thrown off by a few outlying vertices the
  // same way.
  const partBoxes = new Map(); // parent object -> combined Box3
  const partCentroids = new Map(); // parent object -> { sum: Vector3, count: number }
  const v = new THREE.Vector3();
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.parent) return;
    const box = new THREE.Box3().setFromObject(obj);
    if (!isFinite(box.min.x)) return;
    const existingBox = partBoxes.get(obj.parent);
    if (existingBox) existingBox.union(box);
    else partBoxes.set(obj.parent, box.clone());

    const posAttr = obj.geometry && obj.geometry.attributes && obj.geometry.attributes.position;
    if (!posAttr) return;
    obj.updateWorldMatrix(true, false);
    const centroid = partCentroids.get(obj.parent) || { sum: new THREE.Vector3(), count: 0 };
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld);
      centroid.sum.add(v);
      centroid.count++;
    }
    partCentroids.set(obj.parent, centroid);
  });

  // "Most compact part" alone isn't a safe enough filter on its own - an
  // Onshape assembly like this one has plenty of small hardware (brackets,
  // pins, bolts) sitting near the beam that can be even more compact than
  // the actual foot plate, and would win a pure compactness contest by
  // accident. What actually, uniquely identifies the foot plate is that it
  // TOUCHES THE GROUND - the cylinder above it and any nearby hardware
  // don't. Filtering to parts within 15cm of the model's own lowest point
  // (cal.groundY) first, THEN taking the largest (not smallest) footprint
  // among survivors, reliably picks the plate over both the beam (too
  // high off the ground to pass the filter at all) and small ground-
  // adjacent hardware (present, but smaller than the actual plate).
  const GROUND_TOLERANCE = 0.15;
  const candidateReach = {}; // key -> best reach seen (bbox pass)
  const candidateParts = {}; // key -> Set of ground-level parent objects worth comparing
  partBoxes.forEach((box, parent) => {
    if (box.min.y - cal.groundY > GROUND_TOLERANCE) return; // doesn't touch the ground - can't be the foot
    [box.min.x, box.max.x].forEach((x) => {
      const qx = x >= cal.lateralCenter ? 1 : -1;
      const zMid = (box.min.z + box.max.z) / 2;
      const qz = zMid >= cal.slewZ ? 1 : -1;
      const key = `${qx}_${qz}`;
      const reach = Math.abs(x - cal.lateralCenter);
      if (!candidateReach[key] || reach > candidateReach[key] - 0.3) {
        // Keep anything within 30cm of the current best, not just the
        // single best box - there can be more than one ground-level part
        // in the same corner (foot plate plus a mounting bracket, say).
        candidateReach[key] = Math.max(candidateReach[key] || 0, reach);
        (candidateParts[key] = candidateParts[key] || new Set()).add(parent);
      }
    });
  });

  // Among each quadrant's ground-level candidates, the FARTHEST-REACHING
  // one is the foot - reach is what actually, physically distinguishes an
  // extended outrigger from anything else sitting near the ground (a
  // storage box, a spare-wheel mount, a step). Footprint is only a
  // minimum-size sanity filter here (reject an implausibly tiny sliver -
  // a decal, a bolt head), NOT the primary selector: an earlier version
  // of this picked the LARGEST footprint among candidates instead, which
  // sounds similar but isn't - it let a large, ground-level, but much
  // CLOSER-to-centre part (something incidental, sitting well short of
  // the true foot) win over a smaller but genuinely far-reaching plate,
  // simply because it happened to have a bigger bounding box. Confirmed
  // by dumping every ground-level part's reach directly and finding the
  // real foot candidate sitting right there, un-selected, because a
  // closer/bigger part had won the footprint contest instead. See
  // methodology.txt 10.83.
  const MIN_FOOTPRINT = 0.02; // 2cm x 2cm - well below any real plate, filters decal-scale noise only
  const corners = { '1_-1': null, '1_1': null, '-1_-1': null, '-1_1': null };
  Object.keys(candidateParts).forEach((key) => {
    let best = null;
    candidateParts[key].forEach((parent) => {
      const box = partBoxes.get(parent);
      const footprint = (box.max.x - box.min.x) * (box.max.z - box.min.z);
      if (footprint < MIN_FOOTPRINT) return;
      const reach = Math.abs(box.min.x - cal.lateralCenter) > Math.abs(box.max.x - cal.lateralCenter)
        ? Math.abs(box.min.x - cal.lateralCenter) : Math.abs(box.max.x - cal.lateralCenter);
      if (!best || reach > best.reach) best = { parent, reach };
    });
    if (best) {
      const centroid = partCentroids.get(best.parent);
      if (centroid && centroid.count > 0) {
        best.x = centroid.sum.x / centroid.count;
        best.z = centroid.sum.z / centroid.count;
      } else {
        const box = partBoxes.get(best.parent);
        best.x = (box.min.x + box.max.x) / 2;
        best.z = (box.min.z + box.max.z) / 2;
      }
    }
    corners[key] = best;
  });

  // legAnchors: leg.id -> its own detected point directly, for legs whose
  // geometry was confirmed. Used to place that SPECIFIC leg's CURRENT
  // marker/pad exactly on its own detected point (see applySync below) -
  // a fitted line through all 4 legs is the best available estimate for
  // extrapolating to a SHIFTED position where no real geometry exists to
  // check against, but for a leg's own current position there's no reason
  // to settle for "close, per the fitted line" when the exact detected
  // point is sitting right there. A least-squares fit minimises the total
  // error across all 4 points - it isn't expected to pass through any one
  // of them exactly, so relying on it even for already-confirmed legs
  // re-introduces the very error this whole detection pass exists to
  // remove. See methodology.txt 10.81.
  const legAnchors = {};
  const xPairs = [], zPairs = [];
  baseLegs.forEach((leg) => {
    const siteIsRight = cal.xSlope >= 0 ? leg.x >= 0 : leg.x < 0;
    const siteIsFront = leg.y < 0; // site plan convention: front = negative Y
    const qx = siteIsRight ? 1 : -1;
    const wantMinZ = calibration.frontAtMinZ ? siteIsFront : !siteIsFront;
    const qz = wantMinZ ? -1 : 1;
    const corner = corners[`${qx}_${qz}`];
    if (!corner) return;

    // Sanity check: a genuine match should be within the same ballpark as
    // this leg's own known reach (r), not e.g. the cab or tail block
    // standing in for a beam pair the model doesn't actually have.
    const detectedR = Math.hypot(corner.x - cal.lateralCenter, corner.z - cal.slewZ) * 1000;
    if (detectedR < leg.r * 0.5 || detectedR > leg.r * 1.5) return;

    legAnchors[leg.id] = { x: corner.x, z: corner.z };
    xPairs.push([leg.x, corner.x]);
    zPairs.push([leg.y, corner.z]);
  });

  const xFit = linearFit(xPairs);
  const zFit = linearFit(zPairs);
  const fittedCal = (!xFit && !zFit) ? cal : {
    ...cal,
    xSlope: xFit ? xFit.slope : cal.xSlope,
    lateralCenter: xFit ? xFit.intercept : cal.lateralCenter,
    zSlope: zFit ? zFit.slope : cal.zSlope,
    slewZ: zFit ? zFit.intercept : cal.slewZ
  };
  return { ...fittedCal, legAnchors };
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

// Cheaper fallback for Crane Layout's slew circles, which have no outrigger
// leg geometry to anchor a full refinement against (Crane Layout never
// calls __carrier3dSyncOutriggers - it has its own independent crane
// selector, sc-crane, that Support Pad Placement's cad-crane may never
// have shown a 3D preview for at all). The plain formula estimate is
// already a good slew-centre estimate on its own (it's what the
// refinement itself starts from) - kept in a SEPARATE cache from
// calibrationCache so it can never win out over a genuinely refined
// calibration: computeCalibration always checks calibrationCache first,
// so if Support Pad Placement later opens its own 3D preview for the same
// model, it still gets the full leg-anchored refinement, not this
// cheaper stand-in.
const formulaCalibrationCache = {};
function ensureSlewCalibration(modelKey, root, footprint, calibration) {
  if (calibrationCache[modelKey]) return calibrationCache[modelKey];
  if (formulaCalibrationCache[modelKey]) return formulaCalibrationCache[modelKey];
  if (!footprint || !calibration) return null;
  const cal = computeFormulaCalibration(root, footprint, calibration);
  formulaCalibrationCache[modelKey] = cal;
  return cal;
}

// Site plan convention (see index.html): x = lateral, +right; y =
// longitudinal, front = negative Y, rear = positive Y. mm in, xSlope/
// zSlope already carry the mm->m conversion (see computeFormulaCalibration/
// refineCalibrationFromGeometry above), so no /1000 here.
// legId, when given and present in cal.legAnchors, bypasses the fitted
// line entirely and returns that leg's own directly-detected point - see
// the comment on legAnchors in refineCalibrationFromGeometry above. Only
// pass a legId for a leg's own CURRENT position; a shifted/ghost position
// has no real geometry to anchor to and must use the fitted line.
function siteToWorld(cal, xMm, yMm, legId) {
  const anchor = legId != null && cal.legAnchors && cal.legAnchors[legId];
  if (anchor) return new THREE.Vector3(anchor.x, cal.groundY, anchor.z);
  return new THREE.Vector3(
    cal.lateralCenter + cal.xSlope * xMm,
    cal.groundY,
    cal.slewZ + cal.zSlope * yMm
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
    // leg.id passed through so a confirmed leg's marker/pad lands exactly
    // on its own detected geometry (see siteToWorld's own comment) rather
    // than wherever the fitted line places it.
    const pos = siteToWorld(cal, base.x, base.y, leg.id);

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

// Billboard text label (always faces the camera - a Sprite, not a mesh) for
// the clearance dimension line below. Drawn as a canvas texture rather than
// tracking a projected 2D screen position every frame (the approach the
// transient "Loading..." HTML label uses) - simpler, and correct at any
// camera angle since it's a real object in the 3D scene, not an HTML
// overlay that would need re-projecting on every OrbitControls frame.
function makeTextSprite(text, color) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontPx = 56;
  ctx.font = `bold ${fontPx}px sans-serif`;
  const textWidth = ctx.measureText(text).width;
  const padX = 20, padY = 14;
  canvas.width = textWidth + padX * 2;
  canvas.height = fontPx + padY * 2;
  // measureText above needs the font set BEFORE sizing the canvas, but
  // resizing a canvas clears it - the font has to be set again after.
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padX, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 999; // always drawn on top, same reasoning as depthTest:false above
  const targetHeightM = 0.5; // world-metres tall, tuned to read clearly against a ~10-20m carrier
  const scale = targetHeightM / canvas.height;
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  return sprite;
}

// Draws a straight dimension line between two arbitrary ground-plane
// points into `group` - a line, a short perpendicular tick at each end
// (standard dimension-line convention), and a text label at the midpoint.
// Generalized out of what was originally the clearance-measurement line's
// own inline code (always along world +X) so the same drawing logic can
// also place a line in any direction - needed for the outrigger leg
// dimensions below, where each of the 4 legs sits at its own angle from
// the slew centre, not all sideways like the clearance line.
function addDimensionLine(group, p1, p2, color, labelText) {
  const mat = new THREE.LineBasicMaterial({ color });
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([p1, p2]), mat));

  const dir = new THREE.Vector3().subVectors(p2, p1);
  if (dir.lengthSq() > 1e-9) {
    dir.normalize();
    const tickHalf = 0.12;
    // Perpendicular to the line, in the ground (XZ) plane - a 90 degree
    // rotation of the direction vector about Y.
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(tickHalf);
    [p1, p2].forEach((p) => {
      const tick = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(p.x - perp.x, p.y, p.z - perp.z),
        new THREE.Vector3(p.x + perp.x, p.y, p.z + perp.z)
      ]);
      group.add(new THREE.Line(tick, mat));
    });
  }

  const label = makeTextSprite(labelText, color);
  label.position.set((p1.x + p2.x) / 2, (p1.y + p2.y) / 2 + 0.35, (p1.z + p2.z) / 2);
  group.add(label);
}

// Plain reference connector - a thin, dashed, unlabelled line with no end
// ticks, distinct on purpose from addDimensionLine's own solid+tick+label
// styling so it doesn't read as a third measurement. Used only by the
// ground layout marks below, to show which point on the centerline a
// longitudinal figure is actually measured from without implying that
// short stretch is itself a dimension a crew needs to go remeasure.
function addWitnessLine(group, p1, p2, color) {
  const mat = new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.45, dashSize: 0.12, gapSize: 0.08 });
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p1, p2]), mat);
  line.computeLineDistances();
  group.add(line);
}

// 360 slew clearance radius circles (index.html's Crane Layout sub-tab,
// see SLEW_CLEARANCE_DATA) - draws a flat ring on the ground plane at
// each requested radius, centred on the slew axis, so a person can see
// at a glance whether a nearby wall/stockpile/fence sits inside or
// outside the counterweight/Winch 2's own swing envelope. footprint/
// calibration (FOOTPRINTS[modelKey]/CARRIER_CALIBRATION[modelKey], see
// index.html) are only actually used to compute a fallback calibration
// via ensureSlewCalibration when Support Pad Placement hasn't already
// synced this exact model (see that function's own comment) - prefers
// the real refined one whenever it's available. carrierWidthMm, when
// given (the person's "show clearance measurement" checkbox), also draws
// a dimension line from the carrier's own side out to each circle,
// labelled with the same clearance figure as the numeric table below it.
//
// All distances are drawn directly in world metres (mm / 1000), NOT
// scaled through cal.xSlope/zSlope - those carry the mm-to-model-space
// TRANSLATION mapping for the site plan's own approximate footprint
// figures, but the model itself is dimensionally accurate CAD
// (methodology.txt 10.77), so a real physical distance in mm converts to
// this model's world units by the plain /1000 unit conversion, same as
// every other physical dimension already drawn (pad sizes, etc).
//
// The dimension line always runs along world +X from the slew centre -
// i.e. straight to one side, matching the "parked parallel to the
// structure" worst case the numeric clearance figure itself assumes (see
// index.html's own disclaimer on that card). This is a real 3D line, so
// it's always geometrically correct from any camera angle, but like the
// circles themselves it reads most clearly from a top-down view (Fit
// View gets close to that).
function applySlewCircles(modelKey, root, circles, footprint, calibration, carrierWidthMm) {
  clearSlewCircles();
  if (!circles || !circles.length) return;
  const cal = ensureSlewCalibration(modelKey, root, footprint, calibration);
  if (!cal) return;

  slewCircleGroup = new THREE.Group();
  const center = siteToWorld(cal, 0, 0);
  const SEGMENTS = 96;
  const halfWidthM = carrierWidthMm ? (carrierWidthMm / 1000) / 2 : null;

  circles.forEach((c) => {
    const radiusM = c.radius / 1000;
    const color = c.color || '#ff3b30';
    const points = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const theta = (i / SEGMENTS) * Math.PI * 2;
      points.push(new THREE.Vector3(
        center.x + radiusM * Math.cos(theta),
        center.y + 0.03,
        center.z + radiusM * Math.sin(theta)
      ));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color });
    slewCircleGroup.add(new THREE.LineLoop(geo, mat));

    if (halfWidthM == null) return;

    const y = center.y + 0.04;
    const clearanceMm = Math.round(c.radius - halfWidthM * 1000);
    addDimensionLine(
      slewCircleGroup,
      new THREE.Vector3(center.x + halfWidthM, y, center.z),
      new THREE.Vector3(center.x + radiusM, y, center.z),
      color,
      `${clearanceMm}mm`
    );
  });

  scene.add(slewCircleGroup);
}

window.__carrier3dSetSlewCircles = function (modelKey, circles, footprint, calibration, carrierWidthMm) {
  pendingSlewCircles[modelKey] = circles;
  pendingSlewCircleContext[modelKey] = { footprint, calibration, carrierWidthMm };
  if (currentModelKey !== modelKey || !scene) return;
  const root = modelCache[modelKey];
  if (!root) return; // still loading - replayed once it's in, see __carrier3dActivate
  applySlewCircles(modelKey, root, circles, footprint, calibration, carrierWidthMm);
};

// Crane Layout's "outrigger distances" toggle - OEM-drawing style
// dimension lines from the slew centre straight out to each of C1-C4's
// own BASELINE position (index.html's cadFleetData, the same unshifted
// r/angle the "All Four Legs" table's own "Baseline" column already
// shows on Support Pad Placement - not whatever a shift/pad input might
// currently have configured there, since Crane Layout has no shift
// inputs of its own at all). legs is an array of
// {xMm, yMm, r, label, color} - x/y already resolved from r/angle by
// index.html (same site-plan mm convention siteToWorld expects
// everywhere else), r is the real baseline distance in mm for the label,
// label/color identify which leg (e.g. "C1").
function applyLegDimensions(modelKey, root, legs, footprint, calibration) {
  clearLegDimensions();
  if (!legs || !legs.length) return;
  const cal = ensureSlewCalibration(modelKey, root, footprint, calibration);
  if (!cal) return;

  legDimensionGroup = new THREE.Group();
  const center = siteToWorld(cal, 0, 0);
  const y = center.y + 0.04;
  const p0 = new THREE.Vector3(center.x, y, center.z);

  legs.forEach((leg) => {
    const pos = siteToWorld(cal, leg.xMm, leg.yMm);
    const p1 = new THREE.Vector3(pos.x, y, pos.z);
    addDimensionLine(legDimensionGroup, p0, p1, leg.color || '#f8fafc', `${leg.label}: ${Math.round(leg.r)}mm`);
  });

  scene.add(legDimensionGroup);
}

window.__carrier3dSetLegDimensions = function (modelKey, legs, footprint, calibration) {
  pendingLegDimensions[modelKey] = legs;
  pendingLegDimensionContext[modelKey] = { footprint, calibration };
  if (currentModelKey !== modelKey || !scene) return;
  const root = modelCache[modelKey];
  if (!root) return; // still loading - replayed once it's in, see __carrier3dActivate
  applyLegDimensions(modelKey, root, legs, footprint, calibration);
};

// Crane Layout's "ground layout marks" toggle - the paint-it-out-on-soil
// dimensions a crew uses to lay a crane's footprint out BEFORE it arrives
// (index.html's GROUND_LAYOUT_DATA), genuinely different from the diagonal
// "as the crow flies" C1-C4 lines above (which is what support-pad
// placement needs once the crane is already parked). marks is an array of
// {label, color, stationYMm, edgeXMm, legXMm, lonMm, latMm} - all x/y
// already resolved to site-plan mm by index.html's onGroundLayoutToggle(),
// same convention siteToWorld expects everywhere else.
//
// The longitudinal ("fwd/back") line is drawn OFFSET to that leg's own
// side - at X = legXMm, the leg's own lateral position, not X = 0 - rather
// than straight down the centerline. Two people flagged the centerline
// version in quick succession: the label sat directly under the carrier
// body (unreadable, since the centerline runs straight through it) AND
// all four legs' longitudinal lines stacked on top of each other on that
// one shared line, so a right-side leg's own figure was indistinguishable
// from a left-side one. Offsetting to each leg's own X fixes both at once
// - matches real OEM drawings too, which run the vertical dimension chain
// beside the plan view, not through it. Three pieces per leg, mirroring
// the two-figure OEM convention plus one plain reference connector:
//   1. A thin, dashed, UNLABELLED witness line from the slew centre
//      (0, 0) out to (legXMm, 0) - point level with the slew centre, but
//      already out at this leg's own lateral offset. Shows what the
//      longitudinal figure is measured from without implying it's a
//      distance to go remeasure itself.
//   2. The longitudinal dimension line itself, (legXMm, 0) ->
//      (legXMm, stationYMm) - which is to say, straight to the leg's own
//      position, since legXMm/stationYMm already IS that leg's real
//      site-plan coordinate. Clear of the carrier body the entire way,
//      labelled with the figure a crew reads off the OEM sheet.
//   3. The lateral dimension line, carrier edge (edgeXMm) -> leg
//      (legXMm), same stationYMm - the figure a crew actually measures in
//      the field, starting from the carrier's own edge line (a physical
//      reference locatable without knowing where the slew centre is), not
//      the centerline. The short unmarked gap between the centerline and
//      the edge point is deliberately left undrawn - it's just half the
//      carrier's own (known, fixed) width, not something to remeasure.
function applyGroundLayoutMarks(modelKey, root, marks, footprint, calibration) {
  clearGroundLayoutMarks();
  if (!marks || !marks.length) return;
  const cal = ensureSlewCalibration(modelKey, root, footprint, calibration);
  if (!cal) return;

  groundLayoutGroup = new THREE.Group();
  const center = siteToWorld(cal, 0, 0);
  const y = center.y + 0.04;
  const p0 = new THREE.Vector3(center.x, y, center.z);

  marks.forEach((mark) => {
    const refPos = siteToWorld(cal, mark.legXMm, 0);
    const pRef = new THREE.Vector3(refPos.x, y, refPos.z);
    const edgePos = siteToWorld(cal, mark.edgeXMm, mark.stationYMm);
    const pEdge = new THREE.Vector3(edgePos.x, y, edgePos.z);
    const legPos = siteToWorld(cal, mark.legXMm, mark.stationYMm);
    const pLeg = new THREE.Vector3(legPos.x, y, legPos.z);

    addWitnessLine(groundLayoutGroup, p0, pRef, mark.color);
    addDimensionLine(groundLayoutGroup, pRef, pLeg, mark.color, `${mark.label} fwd/back: ${mark.lonMm}mm`);
    addDimensionLine(groundLayoutGroup, pEdge, pLeg, mark.color, `${mark.label} out from edge: ${mark.latMm}mm`);
  });

  scene.add(groundLayoutGroup);
}

window.__carrier3dSetGroundLayoutMarks = function (modelKey, marks, footprint, calibration) {
  pendingGroundLayoutMarks[modelKey] = marks;
  pendingGroundLayoutContext[modelKey] = { footprint, calibration };
  if (currentModelKey !== modelKey || !scene) return;
  const root = modelCache[modelKey];
  if (!root) return; // still loading - replayed once it's in, see __carrier3dActivate
  applyGroundLayoutMarks(modelKey, root, marks, footprint, calibration);
};

// Support Pad Placement's "mat edge marks" toggle - the 3D counterpart of
// the Bog Mat Marking table (index.html), for a leg that currently has a
// pad toggled on. marks is an array of {label, color, edgeXMm, insideXMm,
// outsideXMm, yMm, insideMm, outsideMm} - all x already resolved to
// site-plan mm by index.html's onMatEdgeToggle() (sharing the exact same
// computeMatMarkingData() the 2D table itself reads from, so the two can
// never drift apart).
//
// Two dimension lines per leg, both starting at the SAME point (the
// carrier's own edge, at that leg's own station) rather than at the leg's
// centre or the centerline - mirrors how a crew actually measures it in
// the field, two separate tape pulls from one reference point. Since
// insideXMm sits between edgeXMm and outsideXMm on the same ray, the two
// lines are collinear - they read on screen as a single line with two
// labels at different points along it (the inside figure closer to the
// carrier, the outside figure further out), not as two disconnected
// segments.
function applyMatEdgeMarks(modelKey, root, marks, footprint, calibration) {
  clearMatEdgeMarks();
  if (!marks || !marks.length) return;
  const cal = ensureSlewCalibration(modelKey, root, footprint, calibration);
  if (!cal) return;

  matEdgeGroup = new THREE.Group();
  const center = siteToWorld(cal, 0, 0);
  const y = center.y + 0.04;

  // insideYMm is offset off the pad's own true Y (mark.yMm, which the
  // OUTSIDE line still uses unchanged) by a fixed 400mm toward the
  // vehicle's own centre - otherwise the inside and outside lines are
  // perfectly collinear (inside is fully contained within outside's own
  // span), and their labels - each sitting at its own line's midpoint -
  // land close enough together at any reasonable zoom to overlap into
  // unreadable stacked text. Offsetting inside onto its own PARALLEL line
  // instead fixes that at any camera angle, including the near-top-down
  // Fit View this is mostly viewed from, and matches how the real OEM
  // dimension chains already read elsewhere in this app - nested
  // measurements drawn as separate parallel lines, not chained along one.
  const OFFSET_MM = 400;
  marks.forEach((mark) => {
    const insideYMm = mark.yMm - Math.sign(mark.yMm || 1) * OFFSET_MM;
    const edgePos = siteToWorld(cal, mark.edgeXMm, mark.yMm);
    const pEdge = new THREE.Vector3(edgePos.x, y, edgePos.z);
    const insideEdgePos = siteToWorld(cal, mark.edgeXMm, insideYMm);
    const pInsideEdge = new THREE.Vector3(insideEdgePos.x, y, insideEdgePos.z);
    const insidePos = siteToWorld(cal, mark.insideXMm, insideYMm);
    const pInside = new THREE.Vector3(insidePos.x, y, insidePos.z);
    const outsidePos = siteToWorld(cal, mark.outsideXMm, mark.yMm);
    const pOutside = new THREE.Vector3(outsidePos.x, y, outsidePos.z);

    addWitnessLine(matEdgeGroup, pEdge, pInsideEdge, mark.color);
    addDimensionLine(matEdgeGroup, pInsideEdge, pInside, mark.color, `${mark.label} inside: ${mark.insideMm}mm`);
    addDimensionLine(matEdgeGroup, pEdge, pOutside, mark.color, `${mark.label} outside: ${mark.outsideMm}mm`);
  });

  scene.add(matEdgeGroup);
}

window.__carrier3dSetMatEdgeMarks = function (modelKey, marks, footprint, calibration) {
  pendingMatEdgeMarks[modelKey] = marks;
  pendingMatEdgeContext[modelKey] = { footprint, calibration };
  if (currentModelKey !== modelKey || !scene) return;
  const root = modelCache[modelKey];
  if (!root) return; // still loading - replayed once it's in, see __carrier3dActivate
  applyMatEdgeMarks(modelKey, root, marks, footprint, calibration);
};
