/* game-extension.js
   Extension for existing Three.js Asphalt-style game
   - Attach SVG logo into DOM container
   - Attach nitro flames to any Three.Group
   - Boost system and HUD binding
   - Countdown sequence and GO banner
   - Minimap renderer using trackPoints or fallback
   - Particle smoke system
   - Settings save/load via localStorage
   - Safe init API: GameExt.init(options)
   - Call GameExt.update(dt, now, speed, boostInput) from your main loop
*/

/* Usage:
   1. Save as game-extension.js and include after your main script:
      <script src="main.js"></script>
      <script src="game-extension.js"></script>

   2. Initialize (optional auto-init runs after 200ms if not called):
      GameExt.init({
        carName: 'car',
        svgTarget: '#logo',
        svgSource: null, // or URL or inline SVG string
        hud: { timer: '#hud-timer', speed: '#hud-speed', boost: '#hud-boost', boostBar: '#boost-bar-fill' },
        minimapCanvas: '#minimap-canvas',
        trackPointsName: 'trackPoints'
      });

   3. In your main loop call:
      GameExt.update(dt, performance.now(), speed, isBoostInputActive);

   4. Start countdown:
      GameExt.runCountdown({ lights: '.light', banner: '#banner' }).then(() => { /* race started */ });
*/

const GameExt = (function () {
  const _ext = {};

  /* ---------- Helpers ---------- */
  function $(sel, root = document) { return root.querySelector(sel); }
  function $all(sel, root = document) { return Array.from((root || document).querySelectorAll(sel)); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function nowMs() { return performance.now(); }

  /* ---------- SVG Attachment ---------- */
  _ext.attachSvg = function attachSvg(targetSelectorOrElement, svgOrUrl) {
    const container = (typeof targetSelectorOrElement === 'string') ? $(targetSelectorOrElement) : targetSelectorOrElement;
    if (!container) return Promise.reject(new Error('SVG target container not found'));
    if (typeof svgOrUrl === 'string' && svgOrUrl.trim().startsWith('<svg')) {
      container.innerHTML = svgOrUrl;
      return Promise.resolve(container.querySelector('svg'));
    }
    return fetch(svgOrUrl)
      .then(resp => {
        if (!resp.ok) throw new Error('Failed to fetch SVG');
        return resp.text();
      })
      .then(text => {
        const start = text.indexOf('<svg');
        const end = text.lastIndexOf('</svg>');
        if (start >= 0 && end >= 0) {
          const svgText = text.slice(start, end + 6);
          container.innerHTML = svgText;
          return container.querySelector('svg');
        } else {
          container.innerHTML = text;
          return container.querySelector('svg');
        }
      });
  };

  /* ---------- Particle Smoke System ---------- */
  const particles = [];
  function spawnSmoke(x, y, z, opts = {}) {
    if (typeof THREE === 'undefined') return null;
    const size = opts.size || 0.5;
    const color = opts.color || 0x222222;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false });
    const geo = new THREE.PlaneGeometry(size, size);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    if (opts.parent && opts.parent.add) opts.parent.add(mesh);
    else if (window.scene && scene.add) scene.add(mesh);
    particles.push({ mesh, life: 1.0, vx: (Math.random() - 0.5) * 0.2, vz: (Math.random() - 0.5) * 0.2 });
    return mesh;
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt * 0.6;
      p.mesh.position.x += p.vx * dt * 60;
      p.mesh.position.z += p.vz * dt * 60;
      p.mesh.material.opacity = Math.max(0, p.life * 0.6);
      p.mesh.scale.setScalar(1 + (1 - p.life) * 1.2);
      if (p.life <= 0) {
        if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
        particles.splice(i, 1);
      }
    }
  }

  /* ---------- Flames (attach/update) ---------- */
  function attachFlamesToGroup(group, opts = {}) {
    if (typeof THREE === 'undefined') throw new Error('Three.js not found');
    if (!group || !group.add) throw new Error('Invalid group to attach flames');

    if (group._extFlames) {
      group._extFlames.forEach(f => { if (f.parent) f.parent.remove(f); });
      group._extFlames = null;
    }

    const style = opts.style || 'blue';
    const colorMap = { blue: 0x00c8ff, orange: 0xff6a00, purple: 0xc84bff };
    const color = colorMap[style] || colorMap.blue;

    const flameGeo = new THREE.ConeGeometry(0.32, 1.4, 12);
    const baseMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false });

    const flames = [];
    function mk(x, y, z) {
      const m = baseMat.clone();
      const f = new THREE.Mesh(flameGeo, m);
      f.rotation.x = Math.PI;
      f.position.set(x, y, z);
      group.add(f);
      flames.push(f);
    }

    const offsets = opts.offsets || [{ x: -0.42, y: 0.32, z: -1.6 }, { x: 0.42, y: 0.32, z: -1.6 }];
    offsets.forEach(o => mk(o.x, o.y, o.z));

    group._extFlames = flames;
    group._extFlameOptions = opts;
    return flames;
  }

  function updateFlames(group, boosting, dt) {
    if (!group || !group._extFlames) return;
    const target = boosting ? 1.0 : 0.0;
    group._extFlames.forEach(f => {
      f.material.opacity += (target - f.material.opacity) * Math.min(1, dt * 12);
      if (boosting) {
        f.scale.set(1 + Math.random() * 1.0, 1 + Math.random() * 1.6, 1);
        if (Math.random() < 0.25) {
          spawnSmoke(group.position.x + (Math.random() - 0.5) * 0.6, 0.2, group.position.z - 1.6, { parent: (window.scene || scene) });
        }
      } else {
        f.scale.set(1, 1, 1);
      }
    });
  }

  /* ---------- Boost System ---------- */
  const boostState = {
    boost: 100,
    maxBoost: 100,
    active: false,
    drainRate: 40,
    regenRate: 15,
    multiplier: 1.7
  };

  function initBoost(opts = {}) {
    Object.assign(boostState, opts);
  }

  function updateBoost(inputActive, dt) {
    if (inputActive && boostState.boost > 0) {
      boostState.active = true;
      boostState.boost -= boostState.drainRate * dt;
      if (boostState.boost <= 0) { boostState.boost = 0; boostState.active = false; }
    } else {
      boostState.active = false;
      boostState.boost += boostState.regenRate * dt;
      if (boostState.boost > boostState.maxBoost) boostState.boost = boostState.maxBoost;
    }
    return boostState;
  }

  function bindBoostToHUD(hudSelectors = {}) {
    const timerEl = hudSelectors.timer ? $(hudSelectors.timer) : null;
    const speedEl = hudSelectors.speed ? $(hudSelectors.speed) : null;
    const boostEl = hudSelectors.boost ? $(hudSelectors.boost) : null;
    const boostBar = hudSelectors.boostBar ? $(hudSelectors.boostBar) : null;

    return function refreshHUD(now, speedValue) {
      if (timerEl && now != null) timerEl.textContent = 'Time: ' + (now / 1000).toFixed(3);
      if (speedEl && typeof speedValue !== 'undefined') speedEl.textContent = 'Speed: ' + Math.round(Math.max(0, speedValue * 3.6)) + ' km/h';
      if (boostEl) boostEl.textContent = 'Boost: ' + Math.round((boostState.boost / boostState.maxBoost) * 100) + '%';
      if (boostBar) boostBar.style.transform = 'scaleX(' + (boostState.boost / boostState.maxBoost) + ')';
    };
  }

  /* ---------- Countdown ---------- */
  function runCountdown(selectors = {}) {
    const lights = selectors.lights ? $all(selectors.lights) : $all('.light');
    const banner = selectors.banner ? $(selectors.banner) : document.getElementById('banner');
    if (!lights || lights.length === 0) {
      if (banner) {
        banner.textContent = 'GO!';
        banner.style.display = 'block';
        setTimeout(() => banner.style.display = 'none', 800);
      }
      return Promise.resolve();
    }

    return new Promise(async (resolve) => {
      try {
        lights.forEach(l => l.classList.remove('on'));
        for (let i = 0; i < lights.length; i++) {
          lights[i].classList.add('on');
          if (window.AudioContext || window.webkitAudioContext) {
            try {
              const ctx = new (window.AudioContext || window.webkitAudioContext)();
              const o = ctx.createOscillator();
              const g = ctx.createGain();
              o.type = 'sine';
              o.frequency.value = 880 + i * 60;
              g.gain.value = 0.02;
              o.connect(g); g.connect(ctx.destination);
              o.start();
              setTimeout(() => { o.stop(); ctx.close(); }, 120);
            } catch (e) { /* ignore */ }
          }
          await new Promise(r => setTimeout(r, 650));
        }
        lights.forEach(l => l.classList.remove('on'));
        if (banner) {
          banner.textContent = 'GO!';
          banner.style.display = 'block';
          setTimeout(() => { banner.style.display = 'none'; }, 900);
        }
      } catch (e) { /* ignore */ }
      resolve();
    });
  }

  /* ---------- Minimap ---------- */
  function renderMinimap(canvasSelector, trackPointsArray, objects = []) {
    const canvas = (typeof canvasSelector === 'string') ? $(canvasSelector) : canvasSelector;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0b0b';
    ctx.fillRect(0, 0, w, h);

    let pts = trackPointsArray && trackPointsArray.length ? trackPointsArray : [];
    if (!pts.length) {
      pts = [];
      for (let i = 0; i < 360; i += 6) {
        const a = i * Math.PI / 180;
        pts.push({ x: Math.cos(a) * 120, z: Math.sin(a) * 120 });
      }
    }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    pts.forEach(p => {
      const x = p.x;
      const z = p.z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    });
    const pad = 20;
    minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;
    const scaleX = w / (maxX - minX || 1);
    const scaleZ = h / (maxZ - minZ || 1);
    const scale = Math.min(scaleX, scaleZ);

    ctx.strokeStyle = '#444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (p.x - minX) * scale;
      const y = (p.z - minZ) * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();

    objects.forEach(o => {
      const x = (o.x - minX) * scale;
      const y = (o.z - minZ) * scale;
      ctx.fillStyle = o.color || '#ff2b2b';
      const s = (o.size || 6);
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    });
  }

  /* ---------- Settings ---------- */
  const SETTINGS_KEY = 'game_ext_settings_v1';
  function saveSettings(obj) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj)); } catch (e) {} }
  function loadSettings() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; } }

  /* ---------- Init API ---------- */
  _ext.init = function init(options = {}) {
    const opts = Object.assign({
      carName: 'car',
      svgTarget: '#logo',
      svgSource: null,
      hud: { timer: '#hud-timer', speed: '#hud-speed', boost: '#hud-boost', boostBar: '#boost-bar-fill' },
      minimapCanvas: '#minimap-canvas',
      trackPointsName: 'trackPoints'
    }, options);

    if (opts.svgSource) {
      _ext.attachSvg(opts.svgTarget, opts.svgSource).catch(err => console.warn('SVG attach failed', err));
    }

    const carGroup = (typeof window[opts.carName] !== 'undefined') ? window[opts.carName] : (window.car || null);
    if (!carGroup) console.warn('GameExt: car group not found by name', opts.carName);
    else {
      try {
        attachFlamesToGroup(carGroup, { style: (loadSettings().flame || 'blue') });
        _ext._car = carGroup;
      } catch (e) { console.warn('GameExt: attachFlamesToGroup failed', e); }
    }

    _ext.refreshHUD = bindBoostToHUD(opts.hud);
    _ext._minimapCanvas = $(opts.minimapCanvas);
    _ext._trackPoints = (window[opts.trackPointsName] && window[opts.trackPointsName].length) ? window[opts.trackPointsName] : null;

    _ext.update = function update(dt, now, playerSpeed, boostInput) {
      initBoost();
      updateBoost(boostInput, dt);
      if (_ext._car) updateFlames(_ext._car, boostState.active, dt);
      updateParticles(dt);
      if (_ext.refreshHUD) _ext.refreshHUD(now, playerSpeed);
      if (_ext._minimapCanvas) {
        const objects = [];
        if (_ext._car) objects.push({ x: _ext._car.position.x, z: _ext._car.position.z, color: '#ff2b2b', size: 8 });
        if (window.aiCars && Array.isArray(window.aiCars)) window.aiCars.forEach(a => objects.push({ x: a.position.x, z: a.position.z, color: '#22aaff', size: 6 }));
        renderMinimap(_ext._minimapCanvas, _ext._trackPoints, objects);
      }
    };

    _ext._particles = particles;
    _ext._boostState = boostState;
    _ext.saveSettings = saveSettings;
    _ext.loadSettings = loadSettings;

    return _ext;
  };

  /* ---------- Expose helpers ---------- */
  _ext.attachFlamesToGroup = attachFlamesToGroup;
  _ext.updateFlames = updateFlames;
  _ext.spawnSmoke = spawnSmoke;
  _ext.updateParticles = updateParticles;
  _ext.runCountdown = runCountdown;
  _ext.initBoost = initBoost;
  _ext.updateBoost = updateBoost;
  _ext.renderMinimap = renderMinimap;

  return _ext;
})();

/* Auto-expose and auto-init (safe, non-fatal) */
if (typeof window !== 'undefined') {
  window.GameExt = GameExt;
  setTimeout(() => {
    try {
      GameExt.init({
        carName: window.car ? 'car' : 'car',
        svgTarget: '#logo',
        svgSource: null,
        hud: { timer: '#hud-timer', speed: '#hud-speed', boost: '#hud-boost', boostBar: '#boost-bar-fill' },
        minimapCanvas: '#minimap-canvas',
        trackPointsName: 'trackPoints'
      });
    } catch (e) { /* ignore */ }
  }, 200);
}
