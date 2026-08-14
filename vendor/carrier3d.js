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
// length. calibration.frontAtMinZ says which end of the box (min or max Z)
// is the front, confirmed per-crane by rendering a straight-down view and
// visually identifying the driving cab (see methodology.txt 10.77) -
// that's the one thing that can't be derived from the geometry alone.
// calibration.lateralSign flips left/right if a crane's export happens to
// have +X reading as the opposite side from the site plan's own "+X =
// right" convention.
function computeCalibration(root, footprint, calibration) {
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

function applySync(modelKey, root, args) {
  clearOutriggers();
  const cal = computeCalibration(root, args.footprint, args.calibration);
  outriggerGroup = new THREE.Group();

  args.legs.forEach(leg => {
    const pos = siteToWorld(cal, leg.x, leg.y);

    const markerGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.35, 16);
    const markerMat = new THREE.MeshStandardMaterial({ color: LEG_MARKER_COLOR });
    const marker = new THREE.Mesh(markerGeo, markerMat);
    marker.position.set(pos.x, pos.y + 0.18, pos.z);
    outriggerGroup.add(marker);

    if (!leg.pad) return;

    const padGeo = new THREE.BoxGeometry(leg.pad.width / 1000, 0.08, leg.pad.length / 1000);
    const padMat = new THREE.MeshStandardMaterial({ color: PAD_CURRENT_COLOR, transparent: true, opacity: 0.9 });
    const padMesh = new THREE.Mesh(padGeo, padMat);
    padMesh.position.set(pos.x, pos.y + 0.04, pos.z);
    outriggerGroup.add(padMesh);

    // Ghost "if moved" pad - same condition the 2D plan itself uses (only
    // drawn when it actually differs from the current spot).
    if (leg.movedX !== leg.x || leg.movedY !== leg.y) {
      const movedPos = siteToWorld(cal, leg.movedX, leg.movedY);
      const ghostGeo = new THREE.BoxGeometry(leg.pad.width / 1000, 0.08, leg.pad.length / 1000);
      const ghostFill = new THREE.Mesh(ghostGeo, new THREE.MeshBasicMaterial({ color: PAD_GHOST_COLOR, transparent: true, opacity: 0.18 }));
      ghostFill.position.set(movedPos.x, movedPos.y + 0.04, movedPos.z);
      outriggerGroup.add(ghostFill);

      const wire = new THREE.LineSegments(new THREE.EdgesGeometry(ghostGeo), new THREE.LineBasicMaterial({ color: PAD_GHOST_COLOR }));
      wire.position.copy(ghostFill.position);
      outriggerGroup.add(wire);
    }
  });

  scene.add(outriggerGroup);
}

// Called from calcCAD() whenever the outrigger tab recalculates, if this
// crane has a carrier model. footprint = FOOTPRINTS[modelKey], calibration
// = CARRIER_CALIBRATION[modelKey], legs = calcCAD()'s own mappedOutriggers
// array (same objects the 2D canvas draws from - x/y/movedX/movedY/pad
// mean exactly what they mean there, deliberately not reinterpreted here).
window.__carrier3dSyncOutriggers = function (modelKey, footprint, calibration, legs) {
  pendingSync[modelKey] = { footprint, calibration, legs };
  if (currentModelKey !== modelKey || !scene) return;
  const root = modelCache[modelKey];
  if (!root) return; // still loading - applySync() replays this once it's in
  applySync(modelKey, root, pendingSync[modelKey]);
};
