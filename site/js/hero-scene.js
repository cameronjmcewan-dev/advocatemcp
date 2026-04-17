// ═══════════════════════════════════════════════════════════════════
// Advocate — Hero scene (floating layered-glass logo)
// Lazy-loaded only when:
//   - viewport width >= 900px
//   - prefers-reduced-motion != reduce
//   - .ln-hero is intersecting the viewport
// ═══════════════════════════════════════════════════════════════════

const CANVAS_SELECTOR  = '.rd-hero-canvas';
const HERO_SELECTOR    = '.ln-hero';
const LOGO_TEXTURE_URL = '/icon-512.png'; // PNG with transparency, already in /site

// Feature gate
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const tooNarrow     = window.innerWidth < 900;
if (reducedMotion || tooNarrow) {
  // Bail early — CSS has already hidden the canvas. Don't load three.
} else {
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
          bootHero(canvas);
        }
      }
    },
    { rootMargin: '200px' }
  );
  io.observe(hero);
}

async function bootHero(canvas) {
  let THREE;
  try {
    THREE = await import('https://esm.sh/three@0.160.0');
  } catch (e) {
    console.warn('[advocate] hero scene: three failed to load', e);
    return;
  }

  const width  = canvas.clientWidth  || canvas.parentElement.clientWidth;
  const height = canvas.clientHeight || canvas.parentElement.clientHeight;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100);
  camera.position.set(0, 0, 6);

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const keyLight = new THREE.DirectionalLight(0xfff2ea, 1.15);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);
  const rimLight = new THREE.PointLight(0x7d2550, 4.0, 18);
  rimLight.position.set(-2, -1, -3);
  scene.add(rimLight);
  const fillLight = new THREE.PointLight(0x7d2550, 1.6, 14);
  fillLight.position.set(0, -2.5, 1);
  scene.add(fillLight);

  // Load the logo texture
  const texture = await new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(LOGO_TEXTURE_URL, resolve, undefined, reject);
  }).catch(() => null);

  if (!texture) return;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  // Build layered stack — 4 planes at slight Z-offset for Vercel-like depth.
  const logo = new THREE.Group();
  const layerCount = 4;
  const baseSize   = 2.6;
  const accent     = new THREE.Color('#7d2550');

  for (let i = 0; i < layerCount; i++) {
    const material = new THREE.MeshPhysicalMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.02,
      transmission: 0.85,
      roughness: 0.15,
      thickness: 1.2,
      ior: 1.5,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
      color: new THREE.Color().lerpColors(new THREE.Color('#ffffff'), accent, 0.22 + i * 0.08),
      opacity: 1 - i * 0.18,
      depthWrite: i === 0,
      side: THREE.DoubleSide,
    });
    const geom = new THREE.PlaneGeometry(baseSize, baseSize);
    const mesh = new THREE.Mesh(geom, material);
    mesh.position.z = -i * 0.05;
    mesh.scale.setScalar(1 - i * 0.015);
    logo.add(mesh);
  }
  scene.add(logo);

  // Soft rear glow plane
  const glowMat = new THREE.MeshBasicMaterial({
    color: accent,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const glow = new THREE.Mesh(new THREE.CircleGeometry(2.2, 48), glowMat);
  glow.position.z = -1.2;
  scene.add(glow);

  // Mouse parallax
  let mouseX = 0, mouseY = 0;
  const onMove = (ev) => {
    const rect = canvas.getBoundingClientRect();
    mouseX = ((ev.clientX - rect.left) / rect.width)  * 2 - 1;
    mouseY = ((ev.clientY - rect.top)  / rect.height) * 2 - 1;
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  // Resize
  const onResize = () => {
    const w = canvas.parentElement.clientWidth;
    const h = canvas.parentElement.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);

  // Reveal
  canvas.classList.add('rd-ready');

  // Animation loop
  const start = performance.now();
  function tick(now) {
    const t = (now - start) / 1000;
    // Idle rotation (continuous)
    const idleY = t * 0.08;
    // Parallax tilt — max ~8°. Blend mouse offset with idle spin for Y.
    const targetX =  mouseY * 0.14;
    const targetY =  idleY + mouseX * 0.12;
    logo.rotation.x += (targetX - logo.rotation.x) * 0.06;
    logo.rotation.y += (targetY - logo.rotation.y) * 0.06;
    logo.position.x += (mouseX * 0.2 - logo.position.x) * 0.04;
    logo.position.y += (-mouseY * 0.15 - logo.position.y) * 0.04;

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(tick);
  }
  let rafId = requestAnimationFrame(tick);

  // Pause when tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      rafId = requestAnimationFrame(tick);
    }
  });
}
