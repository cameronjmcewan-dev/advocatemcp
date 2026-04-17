/**
 * Earth at Night texture: NASA Visible Earth / Black Marble 2016
 * (public domain, credit NASA Earth Observatory).
 * Downsampled from original 13500×6750 → 2048×1024 for web delivery.
 *
 * ═══════════════════════════════════════════════════════════════════
 * Advocate — Hero scene (rotating Earth at night + arc beams)
 * Lazy-loaded only when:
 *   - viewport width >= 900px
 *   - prefers-reduced-motion != reduce
 *   - .ln-hero is intersecting the viewport
 * Falls back to the CSS gradient backdrop otherwise.
 * ═══════════════════════════════════════════════════════════════════
 */

import * as THREE from '/assets/three@0.160.0.module.min.js';
import { theme } from './theme.js';

const CANVAS_SELECTOR  = '.rd-hero-canvas';
const HERO_SELECTOR    = '.ln-hero';
const EARTH_TEXTURE_URL = '/assets/earth-night.jpg';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const tooNarrow     = window.innerWidth < 900;

if (!reducedMotion && !tooNarrow) {
  initHeroLazy();
}

function initHeroLazy() {
  const canvas = document.querySelector(CANVAS_SELECTOR);
  const hero   = document.querySelector(HERO_SELECTOR);
  if (!canvas || !hero) return;

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          io.disconnect();
          bootHero(canvas, hero).catch((err) => {
            console.warn('[advocate] earth hero: boot failed', err);
          });
        }
      }
    },
    { rootMargin: '200px' }
  );
  io.observe(hero);
}

// ── lat/lon → Vec3 on a sphere of the given radius ──
function latLonToVec3(latDeg, lonDeg, radius) {
  const phi   = (90 - latDeg) * Math.PI / 180;
  const theta = (lonDeg + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
     radius * Math.cos(phi),
     radius * Math.sin(phi) * Math.sin(theta)
  );
}

// ── Fresnel-ish rim shader for the atmospheric halo ──
const atmosphereVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal  = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;
const atmosphereFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float rim = 1.0 - abs(dot(vNormal, vViewDir));
    rim = pow(rim, 2.8);
    gl_FragColor = vec4(uColor, rim * uOpacity);
  }
`;

async function bootHero(canvas, hero) {
  // Lazily import the post-processing chain; if any of it fails we just
  // fall back to rendering without bloom.
  let EffectComposer, RenderPass, UnrealBloomPass, bloomAvailable = true;
  try {
    ({ EffectComposer }  = await import('/assets/three-examples/postprocessing/EffectComposer.js'));
    ({ RenderPass }      = await import('/assets/three-examples/postprocessing/RenderPass.js'));
    ({ UnrealBloomPass } = await import('/assets/three-examples/postprocessing/UnrealBloomPass.js'));
  } catch (e) {
    console.warn('[advocate] earth hero: post-processing unavailable, using plain render', e);
    bloomAvailable = false;
  }

  const parent = canvas.parentElement || hero;
  const width  = canvas.clientWidth  || parent.clientWidth;
  const height = canvas.clientHeight || parent.clientHeight;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  camera.position.set(0, 0, 3.5);
  camera.lookAt(0, 0, 0);

  const accent       = new THREE.Color(theme.accent);
  const accentBright = new THREE.Color(theme.accentBright);

  // ── Lighting ──
  scene.add(new THREE.AmbientLight(0x332222, 0.6));
  const keyLight = new THREE.DirectionalLight(0xffe6dd, 0.9);
  keyLight.position.set(5, 3, 5);
  scene.add(keyLight);

  // ── Earth texture ──
  const loader = new THREE.TextureLoader();
  const earthTex = await new Promise((resolve) => {
    loader.load(EARTH_TEXTURE_URL, (t) => resolve(t), undefined, () => resolve(null));
  });
  if (!earthTex) {
    console.warn('[advocate] earth hero: texture failed to load, bailing');
    return;
  }
  earthTex.colorSpace = THREE.SRGBColorSpace;
  earthTex.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);

  // ── Earth sphere ──
  // emissiveMap with the same night texture + emissive tint = oxblood-coloured
  // city lights, replacing NASA's native amber.
  const EARTH_RADIUS = 1.2;
  const earthGeom = new THREE.SphereGeometry(EARTH_RADIUS, 96, 96);
  const earthMat = new THREE.MeshStandardMaterial({
    map: earthTex,
    emissive: accentBright.clone(),
    emissiveIntensity: 0.15,
    emissiveMap: earthTex,
    roughness: 0.9,
    metalness: 0.1,
  });
  const earth = new THREE.Mesh(earthGeom, earthMat);
  scene.add(earth);

  // ── Atmospheric rim (back-side sphere with fresnel shader) ──
  const atmoGeom = new THREE.SphereGeometry(EARTH_RADIUS * 1.06, 64, 64);
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor:   { value: accent.clone() },
      uOpacity: { value: 0.15 },
    },
    vertexShader:   atmosphereVertex,
    fragmentShader: atmosphereFragment,
    transparent: true,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const atmosphere = new THREE.Mesh(atmoGeom, atmoMat);
  scene.add(atmosphere);

  // ── City anchors ──
  // Arcs and city dots are all children of this group so they rotate with
  // the Earth — connections stay pinned to the continents.
  const rotatingGroup = new THREE.Group();
  scene.add(rotatingGroup);
  rotatingGroup.add(earth);

  const cities = {
    NYC:      latLonToVec3( 40.7,  -74.0, EARTH_RADIUS),
    London:   latLonToVec3( 51.5,   -0.1, EARTH_RADIUS),
    Tokyo:    latLonToVec3( 35.7,  139.7, EARTH_RADIUS),
    SaoPaulo: latLonToVec3(-23.5,  -46.6, EARTH_RADIUS),
    Sydney:   latLonToVec3(-33.9,  151.2, EARTH_RADIUS),
    Lagos:    latLonToVec3(  6.5,    3.4, EARTH_RADIUS),
    Jakarta:  latLonToVec3( -6.2,  106.8, EARTH_RADIUS),
    LA:       latLonToVec3( 34.0, -118.2, EARTH_RADIUS),
  };

  // Glowing dot at every city terminal.
  const dotGeom = new THREE.SphereGeometry(0.015, 16, 16);
  const dotMat = new THREE.MeshBasicMaterial({
    color: accentBright,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (const key of Object.keys(cities)) {
    const dot = new THREE.Mesh(dotGeom, dotMat);
    dot.position.copy(cities[key]);
    rotatingGroup.add(dot);
  }

  // ── Arc beams ──
  const arcPairs = [
    ['NYC',      'London'],
    ['NYC',      'SaoPaulo'],
    ['London',   'Lagos'],
    ['London',   'Tokyo'],
    ['Tokyo',    'Sydney'],
    ['Tokyo',    'LA'],
    ['LA',       'Sydney'],
    ['Jakarta',  'Lagos'],
    ['Jakarta',  'SaoPaulo'],
    ['NYC',      'Jakarta'],
  ];

  // If bloom wasn't available we goose the emissive look on the arcs to
  // compensate — brighter colour, higher opacity. Logged above.
  const arcOpacity = bloomAvailable ? 0.55 : 0.85;
  const beadColor  = bloomAvailable ? 0xffffff : 0xfff0e0;

  const arcMat = new THREE.MeshBasicMaterial({
    color: accentBright,
    transparent: true,
    opacity: arcOpacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const beadGeom = new THREE.SphereGeometry(0.02, 12, 12);
  const beadMat = new THREE.MeshBasicMaterial({
    color: beadColor,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const arcs = [];
  arcPairs.forEach(([aKey, bKey], idx) => {
    const a = cities[aKey];
    const b = cities[bKey];
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dist = a.distanceTo(b);
    // Push the control point outward along the chord midpoint normal.
    const midLen = mid.length() || 1;
    mid.multiplyScalar(1 + (dist * 0.35) / midLen);
    const curve = new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
    const tube = new THREE.TubeGeometry(curve, 40, 0.006, 8, false);
    const mesh = new THREE.Mesh(tube, arcMat);
    rotatingGroup.add(mesh);

    const bead = new THREE.Mesh(beadGeom, beadMat);
    rotatingGroup.add(bead);

    arcs.push({
      curve,
      bead,
      // Stagger start phases over a 3s cycle.
      phaseOffset: (idx / arcPairs.length) * 3,
    });
  });

  // ── Post-processing ──
  let composer = null;
  if (bloomAvailable) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      0.85, // strength
      0.6,  // radius
      0.0   // threshold — bloom everything that emits
    );
    composer.addPass(bloom);
  }

  // ── Resize ──
  const onResize = () => {
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(parent);
  window.addEventListener('resize', onResize);

  canvas.classList.add('rd-ready');

  // ── Animation loop ──
  const start = performance.now();
  let running = true;
  let rafId;

  function tick(now) {
    const t = (now - start) / 1000;

    // Slow Earth rotation: 0.04 rad/sec
    rotatingGroup.rotation.y = t * 0.04;

    // Camera breathing — ease in/out between y=0 and y=0.08 over ~12s
    const breath = 0.5 - 0.5 * Math.cos((t / 12) * Math.PI * 2);
    camera.position.y = breath * 0.08;
    camera.lookAt(0, 0, 0);

    // Animate each arc's traveling bead over a 3s cycle, staggered per arc.
    for (const a of arcs) {
      const u = (((t + a.phaseOffset) % 3) / 3);
      const pt = a.curve.getPoint(u);
      a.bead.position.copy(pt);
      // Pulse brightness: ease-in, ease-out of visibility so beads "light up"
      // as they travel rather than just sliding.
      const fade = Math.sin(u * Math.PI); // 0 → 1 → 0
      a.bead.scale.setScalar(0.7 + fade * 0.9);
      beadMat.opacity = 0.35 + fade * 0.65;
    }

    if (composer) composer.render();
    else renderer.render(scene, camera);

    if (running) rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  // Pause when the tab is hidden.
  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else if (running) {
      rafId = requestAnimationFrame(tick);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Dispose — GPU resource cleanup on unmount (SPA-safety).
  const dispose = () => {
    running = false;
    cancelAnimationFrame(rafId);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('resize', onResize);
    ro.disconnect();
    earthGeom.dispose();
    earthMat.dispose();
    earthTex.dispose();
    atmoGeom.dispose();
    atmoMat.dispose();
    dotGeom.dispose();
    dotMat.dispose();
    beadGeom.dispose();
    beadMat.dispose();
    arcMat.dispose();
    for (const a of arcs) {
      a.bead.geometry?.dispose?.();
    }
    rotatingGroup.traverse((obj) => {
      if (obj.isMesh && obj.geometry && obj.geometry !== earthGeom && obj.geometry !== dotGeom && obj.geometry !== beadGeom) {
        obj.geometry.dispose();
      }
    });
    renderer.dispose();
  };
  // Expose for debugging / potential future unmount hooks.
  canvas.__advocateEarthDispose = dispose;
}
