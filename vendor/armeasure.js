// Standalone WebXR AR point-to-point measurement - "tap a start point, tap
// a second point to set direction, get a marker at a computed real-world
// distance along that line". First use: Chain Shortening's "Mark in AR"
// (tap the reference link, tap further along the chain, see exactly where
// the Nth link away falls in real space, so a rigger can align/count the
// physical chain against it instead of trusting a tape measure end to
// stay put). Deliberately NOT folded into carrier3d.js: that file's AR
// entry point places a whole loaded GLB model at a tapped point; this one
// has no model at all, just two taps and a projected point, so sharing its
// GLTFLoader/DRACOLoader/OrbitControls machinery would only add dead
// weight to this file's own first-load cost. See methodology.txt 51.
//
// Android Chrome / WebXR only - iOS Safari has no WebXR AR support. Callers
// feature-detect via window.__arMeasureSupported() before ever showing a
// button for this, same convention as carrier3d.js's own
// __carrier3dARSupported().
import * as THREE from './three/three.module.min.js';

let renderer = null, scene = null, camera = null;
let xrSession = null, xrHitTestSource = null, xrRefSpace = null;
let reticle = null;
let anchorMarker = null, targetMarker = null;
let resultGroup = null;
let aimLine = null;
let overlayEl = null;
let animating = false;

// 'anchor' - waiting for the first tap (the reference point). 'direction' -
// anchor placed, waiting for a second tap further along to set direction.
// 'done' - both taps placed, result drawn; a further tap restarts.
let phase = 'idle';
let anchorPos = null;
let targetDistanceM = 0;
let resultLabel = '';
let startLabel = '';

const MARKER_ANCHOR_COLOR = 0xe5a900; // matches the app's own accent-gold, "current/reference" convention
const MARKER_TARGET_COLOR = 0x38bdf8; // matches carrier3d.js's own PAD_GHOST_COLOR - "target" convention reused here

function ensureRenderer() {
  if (renderer) return;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.domElement.style.cssText = 'position:fixed; inset:0; z-index:9999;';
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(1, 1, 1);
  scene.add(dir);

  window.addEventListener('resize', onResize);

  if (!animating) {
    animating = true;
    renderer.setAnimationLoop(onFrame);
  }
}

function onResize() {
  if (!renderer || !camera) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function buildReticle() {
  const geo = new THREE.RingGeometry(0.025, 0.032, 32).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xe5a900 });
  const ring = new THREE.Mesh(geo, mat);
  ring.matrixAutoUpdate = false;
  ring.visible = false;
  return ring;
}

function buildMarker(color) {
  const geo = new THREE.SphereGeometry(0.012, 20, 16);
  const mat = new THREE.MeshBasicMaterial({ color });
  return new THREE.Mesh(geo, mat);
}

// Small billboard text label - same canvas-texture-sprite approach as
// carrier3d.js's makeTextSprite, sized down (targetHeightM 0.06 vs that
// file's 0.5) since this is read up close against a chain link, not across
// a whole parked crane.
function makeLabel(text, color) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontPx = 48;
  ctx.font = `bold ${fontPx}px sans-serif`;
  const textWidth = ctx.measureText(text).width;
  const padX = 18, padY = 12;
  canvas.width = textWidth + padX * 2;
  canvas.height = fontPx + padY * 2;
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padX, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 999;
  const targetHeightM = 0.06;
  const scale = targetHeightM / canvas.height;
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  return sprite;
}

function buildOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'armeasure-overlay';
  overlay.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:10000;';
  overlay.innerHTML = `
    <div id="armeasure-msg" style="position:absolute; top:16px; left:50%; transform:translateX(-50%); background:rgba(15,23,42,0.85); color:#f8fafc; padding:8px 14px; border-radius:8px; font-size:13px; text-align:center; max-width:80vw; font-family:sans-serif;"></div>
    <div style="position:absolute; bottom:24px; left:50%; transform:translateX(-50%); display:flex; gap:10px; pointer-events:auto;">
      <button id="armeasure-restart" style="display:none; padding:0 18px; height:48px; border-radius:24px; border:1px solid rgba(255,255,255,0.4); background:rgba(15,23,42,0.85); color:#e5a900; font-size:14px; font-family:sans-serif; cursor:pointer;">Restart</button>
      <button id="armeasure-exit" style="padding:0 20px; height:48px; border-radius:24px; border:1px solid rgba(255,255,255,0.4); background:rgba(15,23,42,0.85); color:#f8fafc; font-size:14px; font-family:sans-serif; cursor:pointer;">Exit AR</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#armeasure-exit').onclick = () => { if (xrSession) xrSession.end(); };
  overlay.querySelector('#armeasure-restart').onclick = resetPlacement;
  return overlay;
}

function setMessage(text) {
  const el = document.getElementById('armeasure-msg');
  if (el) el.textContent = text;
}

function setRestartVisible(visible) {
  const btn = document.getElementById('armeasure-restart');
  if (btn) btn.style.display = visible ? '' : 'none';
}

function resetPlacement() {
  phase = 'anchor';
  anchorPos = null;
  if (anchorMarker) { scene.remove(anchorMarker); anchorMarker = null; }
  if (targetMarker) { scene.remove(targetMarker); targetMarker = null; }
  if (resultGroup) { scene.remove(resultGroup); disposeGroup(resultGroup); resultGroup = null; }
  if (aimLine) { scene.remove(aimLine); aimLine = null; }
  setRestartVisible(false);
  setMessage(`Tap ${startLabel || 'the start point'}`);
}

function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  });
}

function updateHitTest(frame) {
  if (!frame || !xrHitTestSource || !reticle) return;
  const results = frame.getHitTestResults(xrHitTestSource);
  if (results.length) {
    const pose = results[0].getPose(xrRefSpace);
    reticle.visible = true;
    reticle.matrix.fromArray(pose.transform.matrix);
  } else {
    reticle.visible = false;
  }

  // Live aim line while choosing the direction point - shows exactly which
  // way "further along the chain" is currently pointing, before it's
  // locked in by the second tap. Same idea as a laser-pointer preview.
  if (phase === 'direction' && anchorPos && reticle.visible) {
    const currentPos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
    if (aimLine) { scene.remove(aimLine); aimLine = null; }
    const geo = new THREE.BufferGeometry().setFromPoints([anchorPos, currentPos]);
    const mat = new THREE.LineBasicMaterial({ color: MARKER_ANCHOR_COLOR, transparent: true, opacity: 0.6 });
    aimLine = new THREE.Line(geo, mat);
    scene.add(aimLine);
  } else if (aimLine && phase !== 'direction') {
    scene.remove(aimLine);
    aimLine = null;
  }
}

function onSelect() {
  if (!reticle || !reticle.visible) return;
  const pos = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);

  if (phase === 'anchor') {
    anchorPos = pos.clone();
    anchorMarker = buildMarker(MARKER_ANCHOR_COLOR);
    anchorMarker.position.copy(anchorPos);
    scene.add(anchorMarker);
    phase = 'direction';
    setMessage('Tap again further along, in the direction to measure');
    return;
  }

  if (phase === 'direction') {
    const dirPoint = pos.clone();
    const direction = dirPoint.clone().sub(anchorPos);
    // Too close to the anchor to get a reliable direction from - a
    // fingertip-width tap error swings wildly at that range. Stay in
    // 'direction' phase and ask for a tap further away instead of locking
    // in a direction that's mostly noise.
    if (direction.length() < 0.05) {
      setMessage('Tap a bit further away to set the direction clearly');
      return;
    }
    direction.normalize();
    const targetPos = anchorPos.clone().add(direction.multiplyScalar(targetDistanceM));

    if (aimLine) { scene.remove(aimLine); aimLine = null; }
    targetMarker = buildMarker(MARKER_TARGET_COLOR);
    targetMarker.position.copy(targetPos);
    scene.add(targetMarker);

    resultGroup = new THREE.Group();
    const lineGeo = new THREE.BufferGeometry().setFromPoints([anchorPos, targetPos]);
    const lineMat = new THREE.LineBasicMaterial({ color: MARKER_TARGET_COLOR });
    resultGroup.add(new THREE.Line(lineGeo, lineMat));

    const label = makeLabel(resultLabel, MARKER_TARGET_COLOR);
    const mid = anchorPos.clone().lerp(targetPos, 0.5);
    mid.y += 0.04;
    label.position.copy(mid);
    resultGroup.add(label);

    scene.add(resultGroup);
    phase = 'done';
    setRestartVisible(true);
    setMessage(`${resultLabel} - tap anywhere to redo`);
    return;
  }

  if (phase === 'done') {
    resetPlacement();
  }
}

function onFrame(timestamp, frame) {
  if (renderer.xr.isPresenting) {
    updateHitTest(frame);
  }
  renderer.render(scene, camera);
}

function onSessionEnd() {
  if (xrHitTestSource) { xrHitTestSource.cancel(); xrHitTestSource = null; }
  xrRefSpace = null;
  xrSession = null;

  if (reticle) { scene.remove(reticle); reticle = null; }
  if (anchorMarker) { scene.remove(anchorMarker); anchorMarker = null; }
  if (targetMarker) { scene.remove(targetMarker); targetMarker = null; }
  if (resultGroup) { scene.remove(resultGroup); disposeGroup(resultGroup); resultGroup = null; }
  if (aimLine) { scene.remove(aimLine); aimLine = null; }
  phase = 'idle';
  anchorPos = null;

  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  if (renderer && renderer.domElement && renderer.domElement.parentNode) {
    renderer.domElement.parentNode.removeChild(renderer.domElement);
  }
  window.removeEventListener('resize', onResize);
  if (animating) { renderer.setAnimationLoop(null); animating = false; }
  renderer = null; scene = null; camera = null;
  window.__arMeasureOnEnded && window.__arMeasureOnEnded();
}

window.__arMeasureSupported = function () {
  if (!navigator.xr || !navigator.xr.isSessionSupported) return Promise.resolve(false);
  return navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
};

// distanceMm: the real-world distance to project from the start tap.
// label: short text drawn at the result point (e.g. "54 links / 2340mm").
// startPrompt: what to ask for on the first tap (e.g. "the reference link").
window.__arMeasureStart = async function (distanceMm, label, startPrompt) {
  if (!navigator.xr) return;
  targetDistanceM = distanceMm / 1000;
  resultLabel = label;
  startLabel = startPrompt;

  ensureRenderer();
  overlayEl = buildOverlay();
  phase = 'anchor';
  setMessage(`Tap ${startPrompt}`);

  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: overlayEl }
    });
  } catch (err) {
    console.error('armeasure AR session request failed', err);
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    return;
  }

  xrSession = session;
  session.addEventListener('end', onSessionEnd);
  session.addEventListener('select', onSelect);

  reticle = buildReticle();
  scene.add(reticle);

  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(session);
  const viewerSpace = await session.requestReferenceSpace('viewer');
  xrHitTestSource = await session.requestHitTestSource({ space: viewerSpace });
  xrRefSpace = await session.requestReferenceSpace('local');
};

window.__arMeasureExit = function () {
  if (xrSession) xrSession.end();
};
