// 3D carrier (chassis) preview for the Outrigger Support Positioning tab.
// Loaded as a <script type="module">, same reasoning as cwt3d.js: can't see
// the main app's classic-script top-level bindings, talks back only via
// plain functions on window (__carrier3dActivate).
//
// Deliberately much simpler than cwt3d.js: this is a "look and see" preview
// only, not tied into the tab's own must-move/clash-detection math (that's
// scoped as possible later work, not part of this). No partMap, no click
// selection/highlighting, no explode logic - the carrier's own real
// assembled position IS the intended view (it's one rigid chassis, not a
// counterweight stack to pull apart), and its materials already carry the
// crane's own Liebherr colours baked in from the CAD export, so nothing
// needs recolouring either. One scene/renderer/camera/controls set, reused
// across cranes the same way cwt3d.js does, keyed model cache so switching
// back to an already-viewed carrier doesn't re-fetch/re-parse its
// (multi-MB) model. See methodology.txt 10.76.

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

// modelKey -> THREE.Object3D (the loaded scene root)
const modelCache = {};
const loadingInProgress = {};

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
    labelEl.textContent = 'Preview only — not tied to the site plan positions above yet.';
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
    document.getElementById('carrier-3d-label').textContent = 'Preview only — not tied to the site plan positions above yet.';
  } else {
    loadModel(modelKey, url, (root) => {
      if (currentModelKey !== modelKey) return; // user switched away while loading
      scene.add(root);
      frameCamera(root);
    });
  }
};
