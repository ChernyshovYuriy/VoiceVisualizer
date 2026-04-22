/**
 * VOICE VISUALIZER ENGINE
 *
 * Architecture (per AGENTS.md):
 *   BackgroundSystem  — deep navy gradient sphere
 *   RingSystem        — 1 main + 2 echo rings, each a single PlaneGeometry
 *   AxisSystem        — hairline vertical reference
 *
 * Data mapping:
 *   pitch     → Y position
 *   loudness  → radius
 *   energy    → thickness
 *   onset     → brightness flash
 *   centroid  → color (warm ↔ cool)
 */

var CFG = {
    // camera
    cameraFOV:      44,
    cameraDistance: 11.5,
    // ring shape
    ringThickness:  0.052,
    ringOpacity:    0.92,
    // echo rings
    echoNear:       0.38,   // Y offset for echo 1
    echoFar:        0.76,   // Y offset for echo 2
    echoOpacity1:   0.48,
    echoOpacity2:   0.28,
    echoScale1:     0.93,
    echoScale2:     0.87,
    // motion easing
    yAttack:        0.18,
    yRelease:       0.07,
    rAttack:        0.18,
    rRelease:       0.075,
    flashDecay:     0.22,
    // pitch field
    yMin: -3.6,
    yMax:  3.6,
    // color palette stops: pitch norm 0→1
    palette: [
        { t: 0.00, r: 0.43, g: 0.15, b: 0.12 },  // deep ember
        { t: 0.25, r: 0.61, g: 0.28, b: 0.14 },  // burnt orange
        { t: 0.48, r: 0.72, g: 0.46, b: 0.18 },  // amber
        { t: 0.65, r: 0.62, g: 0.58, b: 0.28 },  // muted gold
        { t: 0.80, r: 0.30, g: 0.55, b: 0.47 },  // jade
        { t: 1.00, r: 0.21, g: 0.56, b: 0.64 },  // cyan-blue
    ],
    // axis
    axisOpacity:    0.14,
    // pixel ratio cap
    maxDPR: 1.5,
};

/* ─────────────────────────────── helpers ─────────────── */
// M is the internal alias; MathUtils is declared globally in visualizer.html
// Use var so this doesn't conflict with the HTML's const MathUtils
var M = {
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    lerp:  (a, b, t)   => a + (b - a) * t,
};

function samplePalette(t) {
    const p = CFG.palette;
    if (t <= p[0].t) return { r: p[0].r, g: p[0].g, b: p[0].b };
    if (t >= p[p.length - 1].t) { const last = p[p.length - 1]; return { r: last.r, g: last.g, b: last.b }; }
    for (let i = 0; i < p.length - 1; i++) {
        if (t >= p[i].t && t <= p[i + 1].t) {
            const f = (t - p[i].t) / (p[i + 1].t - p[i].t);
            return {
                r: M.lerp(p[i].r, p[i + 1].r, f),
                g: M.lerp(p[i].g, p[i + 1].g, f),
                b: M.lerp(p[i].b, p[i + 1].b, f),
            };
        }
    }
}

/* ─────────────────────────────── BackgroundSystem ──────── */
class BackgroundSystem {
    constructor(scene) {
        const geo = new THREE.SphereGeometry(48, 24, 24);
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            uniforms: {
                uTop:    { value: new THREE.Color(0x050a14) },
                uBottom: { value: new THREE.Color(0x010306) },
            },
            vertexShader: `
                varying float vY;
                void main() {
                    vY = (modelMatrix * vec4(position,1.0)).y;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
                }`,
            fragmentShader: `
                varying float vY;
                uniform vec3 uTop, uBottom;
                void main() {
                    float h = clamp((vY + 10.0) / 22.0, 0.0, 1.0);
                    gl_FragColor = vec4(mix(uBottom, uTop, smoothstep(0.0, 1.0, h)), 1.0);
                }`,
        });
        scene.add(new THREE.Mesh(geo, mat));
    }
}

/* ─────────────────────────────── AxisSystem ─────────────── */
class AxisSystem {
    constructor(scene) {
        const geo = new THREE.CylinderGeometry(0.012, 0.012, 9.0, 8, 1, true);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x8fa5c2,
            transparent: true,
            opacity: CFG.axisOpacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        this.mesh = new THREE.Mesh(geo, mat);
        scene.add(this.mesh);
    }
    update(y) { this.mesh.position.y = y; }
}

/* ─────────────────────────────── Ring material ──────────── */
/**
 * Single ring drawn as a full-screen PlaneGeometry.
 * Fragment shader: compute distance from ring radius, apply
 * layered glow profile (sharp inner edge + soft halo).
 * No noise, no harmonics, no multi-pass — one evaluation per pixel.
 */
function makeRingMaterial() {
    return new THREE.ShaderMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
        uniforms: {
            uColor:     { value: new THREE.Color(0.8, 0.55, 0.25) },
            uRadius:    { value: 1.0 },
            uThickness: { value: CFG.ringThickness },
            uOpacity:   { value: CFG.ringOpacity },
            uFlash:     { value: 0.0 },
            uTime:      { value: 0.0 },
            uOrganic:   { value: 0.0 }, // 0..1 subtle warp from energy/onset
            uAspect:    { value: 1.0 }, // slight ellipse for perspective feel
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`,
        fragmentShader: `
            varying vec2 vUv;
            uniform vec3  uColor;
            uniform float uRadius, uThickness, uOpacity, uFlash, uTime, uOrganic, uAspect;

            void main() {
                vec2 uv = vUv * 2.0 - 1.0;
                uv.x *= uAspect;

                // Subtle organic deformation — single low-freq term, data-driven amplitude
                float theta = atan(uv.y, uv.x);
                float warp = sin(theta * 3.0 + uTime * 0.4) * uOrganic * 0.028;
                float dist = length(uv) * (4.0 + warp * 4.0);

                float d = abs(dist - uRadius);
                float t = uThickness;

                // Three-layer profile: sharp inner edge, gaussian body, wide soft halo
                float inner = smoothstep(t * 1.3,  t * 0.5,  d);
                float body  = exp(-pow(d / (t * 0.9), 2.0));
                float halo  = exp(-pow(d / (t * 2.4), 2.0));

                float alpha = (inner * 0.55 + body * 0.38 + halo * 0.14) * uOpacity;

                // Flash brightens toward white on onset
                vec3 col = mix(uColor, vec3(1.0, 0.95, 0.85), uFlash * 0.28);
                // Inner edge is slightly warmer/brighter
                col = mix(col, col * 1.18 + vec3(0.04, 0.02, 0.0), inner * 0.5);

                gl_FragColor = vec4(col, alpha);
            }`,
    });
}

/* ─────────────────────────────── RingSystem ─────────────── */
class RingSystem {
    constructor(scene) {
        this.smState = 'IDLE';

        // Display state (smoothed)
        this.dispY      = 0;
        this.dispR      = 1.0;
        this.dispFlash  = 0;
        this.dispColor  = new THREE.Color(0.72, 0.45, 0.22);
        this._targetCol = new THREE.Color();

        // Shared plane geometry for all rings
        const geo = new THREE.PlaneGeometry(14, 14);

        // Build: main + 2 echo rings
        this._rings = [];
        const specs = [
            { opacity: CFG.ringOpacity,   yOff: 0,            scale: 1.00 },
            { opacity: CFG.echoOpacity1,  yOff: CFG.echoNear, scale: CFG.echoScale1 },
            { opacity: CFG.echoOpacity2,  yOff: CFG.echoFar,  scale: CFG.echoScale2 },
            { opacity: CFG.echoOpacity1,  yOff: -CFG.echoNear, scale: CFG.echoScale1 },
            { opacity: CFG.echoOpacity2,  yOff: -CFG.echoFar,  scale: CFG.echoScale2 },
        ];

        for (const spec of specs) {
            const mat  = makeRingMaterial();
            mat.uniforms.uOpacity.value = spec.opacity;
            const mesh = new THREE.Mesh(geo, mat);
            mesh.rotation.x = -Math.PI / 2;
            scene.add(mesh);
            this._rings.push({ mesh, mat, spec });
        }

        // Central axis (reuses AxisSystem via reference)
        this._axisY = 0;
    }

    update(live, dt) {
        const voiced = live?.active || false;
        this.smState = voiced ? 'TRACKING' : 'IDLE';

        const tY = voiced ? live.y : 0.0;
        const tR = voiced ? live.radius : 0.78;

        // Y easing — fast attack, slow release
        const yAlpha = (tY > this.dispY)
            ? Math.max(live.followY ?? CFG.yAttack, CFG.yAttack)
            : CFG.yRelease;
        const rAlpha = (tR > this.dispR) ? CFG.rAttack : CFG.rRelease;

        this.dispY     = M.lerp(this.dispY, tY, yAlpha);
        this.dispR     = M.lerp(this.dispR, tR, rAlpha);
        this.dispFlash = M.lerp(this.dispFlash, voiced ? live.transient : 0, CFG.flashDecay);

        // Color from pitch
        const col = samplePalette(M.clamp(live?.pitchNorm ?? 0.5, 0, 1));
        this._targetCol.setRGB(col.r, col.g, col.b);
        this.dispColor.lerp(this._targetCol, 0.09);

        // Organic warp: mild, only from energy+onset
        const organic = M.clamp((live?.energy ?? 0) * 0.6 + (live?.onsetExcite ?? 0) * 0.4, 0, 1);
        // Slight ellipse to suggest perspective tilt
        const aspect  = 1.0 + (live?.pitchNorm ?? 0.5) * 0.06;

        // Thickness reflects stability (tighter voice = thinner, crisper ring)
        const thickness = M.lerp(0.068, 0.038, M.clamp(live?.stability ?? 0, 0, 1));

        for (let i = 0; i < this._rings.length; i++) {
            const { mesh, mat, spec } = this._rings[i];
            const yOff = spec.yOff;
            const scl  = spec.scale;

            mesh.position.y = this.dispY + yOff;

            const u = mat.uniforms;
            u.uRadius.value    = this.dispR * scl;
            u.uThickness.value = thickness * (i === 0 ? 1.0 : 0.82);
            u.uFlash.value     = this.dispFlash * (i === 0 ? 1.0 : 0.4);
            u.uTime.value     += dt;
            u.uOrganic.value   = organic * (i === 0 ? 1.0 : 0.5);
            u.uAspect.value    = aspect;

            // Echoes share the same color but slightly cooler/dimmer
            const dimFactor = i === 0 ? 1.0 : (i <= 2 ? 0.78 : 0.72);
            u.uColor.value.copy(this.dispColor).multiplyScalar(dimFactor);
        }
    }
}

/* ─────────────────────────────── VisualizerEngine ──────── */
class VisualizerEngine {
    constructor(canvasId, audioManager) {
        this.audio  = audioManager;
        this.canvas = document.getElementById(canvasId);

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.maxDPR));
        this.renderer.setSize(window.innerWidth, window.innerHeight);

        this.scene  = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(CFG.cameraFOV, window.innerWidth / window.innerHeight, 0.1, 100);
        this.camera.position.set(0, 1.2, CFG.cameraDistance);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.enablePan = false;
        this.controls.minDistance = 5;
        this.controls.maxDistance = 20;

        this.clock = new THREE.Clock();

        this.systems = {
            bg:   new BackgroundSystem(this.scene),
            axis: new AxisSystem(this.scene),
            rings: new RingSystem(this.scene),
        };

        // Reused per-frame state object
        this._live = {};
        this.animate();
    }

    _buildLive() {
        const sm = this.audio.smoothed;
        const S  = this.audio.state;
        const conf = M.clamp(sm.pitchConf, 0, 1);

        const LOG_LO    = Math.log(65.4);
        const LOG_RANGE = Math.log(2093.0) - LOG_LO;
        const hzNorm = hz => M.clamp((Math.log(M.clamp(hz, 65.4, 2093.0)) - LOG_LO) / LOG_RANGE, 0, 1);

        const pitchNorm = M.lerp(
            M.lerp(sm.histPitchNorm, sm.pitchNorm, conf),
            hzNorm(sm.pitch),
            0.3
        );
        const loudMix = M.clamp(0.6 * sm.loudNorm + 0.3 * sm.energyNorm + 0.1 * sm.histLoudNorm, 0, 1);
        const transient = M.clamp(this.audio.transientFlash * 0.8 + sm.histOnset * 0.3, 0, 1);

        const ls = this._live;
        ls.active     = sm.pitch > 40 && conf > 0.08;
        ls.y          = M.lerp(CFG.yMin, CFG.yMax, pitchNorm);
        ls.followY    = M.lerp(0.05, 0.20, conf);
        ls.pitchNorm  = pitchNorm;
        ls.radius     = 0.76 + loudMix * 1.82 + transient * 0.18;
        ls.transient  = transient;
        ls.stability  = conf;
        ls.energy     = sm.energyNorm;
        ls.onsetExcite = M.clamp(0.7 * transient + 0.3 * sm.histOnset, 0, 1);
        return ls;
    }

    renderFrame() {
        const dt = Math.min(this.clock.getDelta(), 0.033);
        this.controls.update();
        this.audio.update(dt);

        const live = this._buildLive();
        this.systems.rings.update(live, dt);
        this.systems.axis.update(this.systems.rings.dispY);

        this.renderer.render(this.scene, this.camera);
    }

    animate() {
        this.renderFrame();
        requestAnimationFrame(() => this.animate());
    }
}
