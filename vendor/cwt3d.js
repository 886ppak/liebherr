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
import { OrbitControls } from './three/OrbitControls.js';

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

// Nudges every named part outward from the model's overall center so the
// stack reads as an exploded view (matching the 2D diagrams) rather than
// its real assembled position, which the GLB itself stores as-is.
function explodeParts(root, namedParts) {
  const box = new THREE.Box3().setFromObject(root);
  const modelCenter = box.getCenter(new THREE.Vector3());
  const modelSize = box.getSize(new THREE.Vector3());
  const explodeDistance = Math.max(modelSize.x, modelSize.y, modelSize.z) * 0.18;

  const byGroup = new Map();
  namedParts.forEach(p => {
    if (!byGroup.has(p.group)) byGroup.set(p.group, p.group);
  });
  byGroup.forEach(group => {
    const gBox = new THREE.Box3().setFromObject(group);
    const gCenter = gBox.getCenter(new THREE.Vector3());
    const dir = gCenter.clone().sub(modelCenter);
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize();
    group.position.add(dir.multiplyScalar(explodeDistance));
  });
}

function loadModel(modelKey, data, onDone) {
  if (modelCache[modelKey]) { onDone(modelCache[modelKey]); return; }
  if (loadingInProgress[modelKey]) return;
  loadingInProgress[modelKey] = true;

  const labelEl = document.getElementById('cwt-3d-label');
  labelEl.textContent = 'Loading 3D model…';

  const loader = new GLTFLoader();
  loader.load(data.model3d.url, (gltf) => {
    const root = gltf.scene;
    const partMap = data.model3d.partMap;
    const namedParts = [];
    const groupsSeen = new Set();

    root.traverse((obj) => {
      const m = /^Part[ _](\d+)$/.exec(obj.name);
      if (!m) return;
      const glbName = obj.name.replace(' ', '_');
      const appId = partMap[glbName];
      if (!appId) return; // unmapped part - shown but not selectable
      groupsSeen.add(obj);
      obj.traverse((child) => {
        if (child.isMesh) {
          child.material = child.material.clone();
          namedParts.push({ appId, glbName, mesh: child, group: obj, baseColor: child.material.color.clone() });
        }
      });
    });

    explodeParts(root, namedParts);

    const entry = { root, namedParts };
    modelCache[modelKey] = entry;
    loadingInProgress[modelKey] = false;
    onDone(entry);
  }, undefined, (err) => {
    loadingInProgress[modelKey] = false;
    labelEl.textContent = '3D model failed to load. Falling back to the 2D diagram is recommended.';
    console.error('cwt3d load error', err);
  });
}

function frameCamera(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  camera.position.set(center.x + maxDim * 0.65, center.y + maxDim * 0.5, center.z + maxDim * 0.65);
  camera.near = maxDim / 100;
  camera.far = maxDim * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

// Ambiguous-slot components (e.g. LTM 1110's Winch 2*/Replacement Ballast
// slotGroup pair) aren't addressed by this - LTM 1130 has none. If a future
// crane's model3d covers one, clicking its mesh should call
// window.cycleCwtSlotGroup(groupName) instead; not needed yet.
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
  if (hit && window.toggleCwtPlate) window.toggleCwtPlate(hit.appId);
}

const SELECTED_COLOR = new THREE.Color(0x10b981);

function syncHighlight(modelKey, selectedSet) {
  const entry = modelCache[modelKey];
  if (!entry) return;
  entry.namedParts.forEach(p => {
    p.mesh.material.color.copy(selectedSet.has(p.appId) ? SELECTED_COLOR : p.baseColor);
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
      syncHighlight(modelKey, selectedSet);
    } else {
      loadModel(modelKey, data, (entry) => {
        if (currentModelKey !== modelKey) return; // user switched away while loading
        scene.add(entry.root);
        frameCamera(entry.root);
        syncHighlight(modelKey, selectedSet);
      });
    }
  } else {
    syncHighlight(modelKey, selectedSet);
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
  if (currentModelKey === modelKey) syncHighlight(modelKey, selectedSet);
};
