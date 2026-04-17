// ═══════════════════════════════════════════════════════════════════
// Advocate — Network constellation centerpiece
// Glowing maroon arcs from AI nodes → logo → lead dots, with bloom.
// Lazy-loaded, mobile/reduced-motion gated (CSS also hides canvas).
// ═══════════════════════════════════════════════════════════════════

const SECTION_SELECTOR = '.rd-network';
const CANVAS_SELECTOR  = '.rd-network-canvas';
const LOGO_TEXTURE_URL = '/icon-512.png';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const tooNarrow     = window.innerWidth < 900;

if (!reducedMotion && !tooNarrow) {
  initNetworkLazy();
}

function initNetworkLazy() {
  const canvas  = document.querySelector(CANVAS_SELECTOR);
  const section = document.querySelector(SECTION_SELECTOR);
  if (!canvas || !section) return;

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          io.disconnect();
          bootNetwork(canvas, section);
        }
      }
    },
    { rootMargin: '200px' }
  );
  io.observe(section);
}

async function bootNetwork(canvas, section) {
  let THREE, UnrealBloomPass, EffectComposer, RenderPass;
  try {
    THREE = await import('https://esm.sh/three@0.160.0');
    ({ EffectComposer }    = await import('https://esm.sh/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js'));
    ({ RenderPass }        = await import('https://esm.sh/three@0.160.0/examples/jsm/postprocessing/RenderPass.js'));
    ({ UnrealBloomPass }   = await import('https://esm.sh/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js'));
  } catch (e) {
    console.warn('[advocate] network scene: load failed', e);
    return;
  }

  section.classList.add('rd-has-webgl');

  const width  = canvas.clientWidth  || section.clientWidth;
  const height = canvas.clientHeight || section.clientHeight;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
  camera.position.set(0, 0, 12);

  const accent       = new THREE.Color('#4A0E0E');
  const accentBright = new THREE.Color('#8B2A2A');

  // Lighting (the scene is mostly emissive but we still want a little fill)
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  const key = new THREE.DirectionalLight(0xffffff, 0.5);
  key.position.set(3, 4, 5);
  scene.add(key);
  const rim = new THREE.PointLight(accent, 3.5, 24);
  rim.position.set(0, 0, -4);
  scene.add(rim);

  // ── Center logo (reuse the hero's layered-plane approach, smaller) ──
  const texture = await new Promise((resolve) => {
    new THREE.TextureLoader().load(LOGO_TEXTURE_URL, resolve, undefined, () => resolve(null));
  });

  const logo = new THREE.Group();
  if (texture) {
    texture.colorSpace = THREE.SRGBColorSpace;
    const layers = 3;
    for (let i = 0; i < layers; i++) {
      const mat = new THREE.MeshPhysicalMaterial({
        map: texture,
        transparent: true,
        alphaTest: 0.02,
        transmission: 0.85,
        roughness: 0.15,
        thickness: 1.2,
        ior: 1.5,
        clearcoat: 1.0,
        color: new THREE.Color().lerpColors(new THREE.Color('#ffffff'), accent, 0.25 + i * 0.1),
        opacity: 1 - i * 0.22,
        depthWrite: i === 0,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.8), mat);
      mesh.position.z = -i * 0.05;
      logo.add(mesh);
    }
  }
  scene.add(logo);

  // ── Orbiting AI nodes (positions in a loose sphere around logo) ──
  const aiNodePositions = [
    new THREE.Vector3(-3.2,  1.4,  0.6),  // Claude
    new THREE.Vector3( 3.4,  1.6,  0.4),  // ChatGPT
    new THREE.Vector3(-2.6, -1.8,  1.2),  // Perplexity
    new THREE.Vector3( 2.8, -1.6,  1.0),  // Gemini
    new THREE.Vector3( 0.0,  2.4, -0.8),  // Copilot
  ];
  const aiNodes = aiNodePositions.map((p) => {
    const geom = new THREE.SphereGeometry(0.14, 24, 24);
    const mat = new THREE.MeshBasicMaterial({ color: 0xf5ede4 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(p);
    scene.add(mesh);
    // halo
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 24, 24),
      new THREE.MeshBasicMaterial({
        color: accentBright,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    halo.position.copy(p);
    scene.add(halo);
    return { mesh, halo, basePos: p.clone() };
  });

  // ── Lead dots scattered at the edges ──
  const leadCount = 12;
  const leadDots = [];
  for (let i = 0; i < leadCount; i++) {
    const angle = (i / leadCount) * Math.PI * 2 + Math.random() * 0.2;
    const r     = 5.0 + Math.random() * 0.8;
    const y     = (Math.random() - 0.5) * 4.2;
    const pos   = new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r * 0.45);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 16, 16),
      new THREE.MeshBasicMaterial({
        color: accentBright,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
      })
    );
    dot.position.copy(pos);
    scene.add(dot);
    leadDots.push({ mesh: dot, basePos: pos.clone() });
  }

  // ── Arcs: AI → logo, then logo → random lead dot ──
  const arcs = [];
  function buildArc(from, to) {
    const mid = from.clone().add(to).multiplyScalar(0.5);
    // Lift the mid-point above the line for a visible curve
    mid.y += 0.8 + Math.random() * 0.6;
    mid.z += (Math.random() - 0.5) * 0.6;
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    const tube  = new THREE.TubeGeometry(curve, 48, 0.025, 8, false);
    const mat = new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(tube, mat);
    scene.add(mesh);

    // Pulse sphere travelling along the curve
    const pulse = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 16, 16),
      new THREE.MeshBasicMaterial({
        color: accentBright,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    scene.add(pulse);

    return { mesh, mat, curve, pulse, pulseMat: pulse.material };
  }

  // Inbound: each AI → logo
  for (const node of aiNodes) {
    arcs.push({
      ...buildArc(node.basePos.clone(), new THREE.Vector3(0, 0, 0)),
      phase: Math.random() * Math.PI * 2,
      speed: 0.55 + Math.random() * 0.2,
      kind: 'in',
    });
  }
  // Outbound: logo → random lead dots
  for (let i = 0; i < 7; i++) {
    const target = leadDots[Math.floor(Math.random() * leadDots.length)].basePos.clone();
    arcs.push({
      ...buildArc(new THREE.Vector3(0, 0, 0), target),
      phase: Math.random() * Math.PI * 2,
      speed: 0.45 + Math.random() * 0.25,
      kind: 'out',
    });
  }

  // ── Background particle field ──
  const particleCount = 280;
  const pGeom = new THREE.BufferGeometry();
  const pPos  = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i++) {
    pPos[i * 3 + 0] = (Math.random() - 0.5) * 24;
    pPos[i * 3 + 1] = (Math.random() - 0.5) * 14;
    pPos[i * 3 + 2] = (Math.random() - 0.5) * 8 - 2;
  }
  pGeom.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  const pMat = new THREE.PointsMaterial({
    color: accent,
    size: 0.05,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const particles = new THREE.Points(pGeom, pMat);
  scene.add(particles);

  // ── Bloom post-processing ──
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    0.85, // strength
    0.45, // radius
    0.12  // threshold
  );
  composer.addPass(bloom);

  const onResize = () => {
    const w = section.clientWidth;
    const h = section.clientHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);

  canvas.classList.add('rd-ready');

  const start = performance.now();
  function tick(now) {
    const t = (now - start) / 1000;
    logo.rotation.y = t * 0.15;
    logo.rotation.x = Math.sin(t * 0.4) * 0.06;

    // Orbit nodes subtly
    aiNodes.forEach((n, i) => {
      const ph = t * 0.3 + i * 1.1;
      n.mesh.position.x = n.basePos.x + Math.sin(ph) * 0.12;
      n.mesh.position.y = n.basePos.y + Math.cos(ph * 0.8) * 0.1;
      n.halo.position.copy(n.mesh.position);
      n.halo.material.opacity = 0.28 + 0.12 * Math.sin(t * 1.5 + i);
    });

    // Particle drift
    particles.rotation.y = t * 0.02;

    // Arc pulses
    arcs.forEach((a, idx) => {
      const u = ((t * a.speed + a.phase / (Math.PI * 2)) % 1);
      const pt = a.curve.getPoint(u);
      a.pulse.position.copy(pt);

      // Arc material glows and fades
      const fade = 0.35 + 0.35 * Math.sin(t * 0.8 + a.phase);
      a.mat.opacity     = Math.max(0.08, fade * 0.7);
      a.pulseMat.opacity = Math.min(1, 0.4 + fade);
    });

    composer.render();
    rafId = requestAnimationFrame(tick);
  }
  let rafId = requestAnimationFrame(tick);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(rafId);
    else rafId = requestAnimationFrame(tick);
  });
}
