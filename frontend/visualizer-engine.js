// Static ring-based baseline scene for Stage 1.
// Relies on globals: THREE.

const VISUAL_SCENE_CONFIG = {
    backgroundTop: 0x0b1423,
    backgroundBottom: 0x030711,
    backgroundHaze: 0x112033,
    bandOpacity: 0.2,
    bandSoftness: 1.34,
    axisOpacity: 0.07,
    axisHeight: 2.35,
    cameraDistance: 6.7,
    depthAttenuation: 0.14,
    pitchBandCount: 7
};

class BackgroundSystem {
    constructor(scene) {
        const domeGeometry = new THREE.SphereGeometry(28, 48, 48);
        const domeMaterial = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            uniforms: {
                uTop: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundTop) },
                uBottom: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundBottom) },
                uHaze: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundHaze) }
            },
            vertexShader: `varying vec3 vWorldPos; void main(){ vec4 world = modelMatrix * vec4(position, 1.0); vWorldPos = world.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec3 vWorldPos;
                uniform vec3 uTop;
                uniform vec3 uBottom;
                uniform vec3 uHaze;
                void main(){
                    float h = clamp((vWorldPos.y + 6.0) / 12.0, 0.0, 1.0);
                    float t = smoothstep(0.06, 0.9, h);
                    float centerGlow = exp(-pow(vWorldPos.y * 0.16, 2.0)) * exp(-pow(vWorldPos.x * 0.09, 2.0));
                    vec3 col = mix(uBottom, uTop, t);
                    col = mix(col, uHaze, centerGlow * 0.28);
                    gl_FragColor = vec4(col, 1.0);
                }
            `
        });

        this.mesh = new THREE.Mesh(domeGeometry, domeMaterial);
        scene.add(this.mesh);
    }

    update() {}
}

class PitchBandSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);

        const yMin = -1.95;
        const yMax = 2.1;
        const gap = (yMax - yMin) / (VISUAL_SCENE_CONFIG.pitchBandCount - 1);
        const centers = [];
        const colors = [];

        for (let i = 0; i < VISUAL_SCENE_CONFIG.pitchBandCount; i++) {
            const t = i / (VISUAL_SCENE_CONFIG.pitchBandCount - 1);
            const col = this.colorForBand(t);
            centers.push(yMin + i * gap);
            colors.push(new THREE.Vector3(col.r, col.g, col.b));
        }

        const material = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.NormalBlending,
            uniforms: {
                uOpacity: { value: VISUAL_SCENE_CONFIG.bandOpacity },
                uCenters: { value: centers },
                uColors: { value: colors },
                uCount: { value: VISUAL_SCENE_CONFIG.pitchBandCount },
                uSoftness: { value: VISUAL_SCENE_CONFIG.bandSoftness },
                uDepthK: { value: VISUAL_SCENE_CONFIG.depthAttenuation }
            },
            vertexShader: `
                varying vec3 vWorldPos;
                varying float vViewDepth;
                void main() {
                    vec4 world = modelMatrix * vec4(position, 1.0);
                    vec4 view = viewMatrix * world;
                    vWorldPos = world.xyz;
                    vViewDepth = abs(view.z);
                    gl_Position = projectionMatrix * view;
                }
            `,
            fragmentShader: `
                varying vec3 vWorldPos;
                varying float vViewDepth;
                uniform float uOpacity;
                uniform float uCenters[7];
                uniform vec3 uColors[7];
                uniform int uCount;
                uniform float uSoftness;
                uniform float uDepthK;

                vec3 applySaturation(vec3 color, float sat) {
                    float l = dot(color, vec3(0.299, 0.587, 0.114));
                    return mix(vec3(l), color, sat);
                }

                void main() {
                    vec3 colorAccum = vec3(0.0);
                    float weightAccum = 0.0;

                    for (int i = 0; i < 7; i++) {
                        if (i >= uCount) { break; }
                        float dy = vWorldPos.y - uCenters[i];
                        float layer = exp(-(dy * dy) / max(uSoftness, 0.001));
                        colorAccum += uColors[i] * layer;
                        weightAccum += layer;
                    }

                    if (weightAccum < 0.0005) {
                        discard;
                    }

                    float distanceFactor = clamp(1.0 - vViewDepth * uDepthK, 0.2, 1.0);
                    float sideFalloff = exp(-pow(vWorldPos.x * 0.13, 2.0));
                    float verticalWindow = exp(-pow(vWorldPos.y * 0.22, 2.0));
                    float alpha = (weightAccum / float(max(uCount, 1))) * uOpacity * sideFalloff;
                    alpha *= mix(0.45, 1.0, verticalWindow);
                    alpha *= distanceFactor;

                    if (alpha < 0.003) {
                        discard;
                    }

                    vec3 color = colorAccum / weightAccum;
                    color = applySaturation(color, mix(0.45, 0.9, distanceFactor));
                    color *= mix(0.56, 0.95, distanceFactor);
                    gl_FragColor = vec4(color, min(alpha, 0.22));
                }
            `
        });

        const fogPlane = new THREE.Mesh(new THREE.PlaneGeometry(17.0, 10.5, 1, 1), material);
        fogPlane.position.set(0.0, 0.0, -3.6);
        this.group.add(fogPlane);

        const echoPlane = fogPlane.clone();
        echoPlane.material = material.clone();
        echoPlane.material.blending = THREE.AdditiveBlending;
        echoPlane.material.uniforms.uOpacity.value = VISUAL_SCENE_CONFIG.bandOpacity * 0.55;
        echoPlane.position.z = -4.2;
        this.group.add(echoPlane);
    }

    colorForBand(t) {
        const stops = [
            { t: 0.0, color: new THREE.Color(0x472733) },
            { t: 0.36, color: new THREE.Color(0x7d5331) },
            { t: 0.6, color: new THREE.Color(0x9d8449) },
            { t: 0.82, color: new THREE.Color(0x4a766f) },
            { t: 1.0, color: new THREE.Color(0x5e7f94) }
        ];

        for (let i = 0; i < stops.length - 1; i++) {
            const a = stops[i];
            const b = stops[i + 1];
            if (t >= a.t && t <= b.t) {
                return a.color.clone().lerp(b.color, (t - a.t) / (b.t - a.t));
            }
        }

        return stops[stops.length - 1].color.clone();
    }

    update() {}
}

class RingSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);

        // 5 rings, back-to-front.
        //
        // Colors match the mockup's neon spectrum exactly:
        //   cyan (farthest/top) → teal → gold → amber → deep orange (nearest/bottom).
        //
        // sigma        — core Gaussian half-width, world units. Kept narrow so the
        //               centerline reads as a sharp luminous tube, not a soft band.
        // coreOpacity  — peak alpha at centerline. Near-opaque to produce solid neon.
        // haloOpacity  — peak alpha of the wide additive bloom pass.
        const ringDefinitions = [
            { y:  1.32, z: -2.15, r: 0.66, sigma: 0.022, coreOpacity: 0.82, haloOpacity: 0.35, color: 0x00ccff },
            { y:  0.68, z: -1.50, r: 0.88, sigma: 0.026, coreOpacity: 0.88, haloOpacity: 0.40, color: 0x00ffcc },
            { y:  0.04, z: -0.84, r: 1.12, sigma: 0.030, coreOpacity: 0.90, haloOpacity: 0.43, color: 0xffd700 },
            { y: -0.62, z: -0.16, r: 1.40, sigma: 0.036, coreOpacity: 0.93, haloOpacity: 0.47, color: 0xff9900 },
            { y: -1.22, z:  0.50, r: 1.75, sigma: 0.044, coreOpacity: 0.96, haloOpacity: 0.52, color: 0xff5500 },
        ];

        ringDefinitions.forEach((def) => {
            this.group.add(this.createRing(def));
        });
    }

    createRing(def) {
        const group = new THREE.Group();
        group.position.set(0, def.y, def.z);

        const baseColor  = new THREE.Color(def.color);

        // Halo sigma is 7.5× the core — this wide ratio is what produces the
        // characteristic spill of colored light seen around each ring in the mockup.
        // Quad extent covers ring radius + 3.2 * sigma_halo so fragments at the
        // very edge of the bloom are still sampled before the discard threshold.
        const haloSigma = def.sigma * 7.5;
        const extent    = def.r + haloSigma * 3.2;

        // -----------------------------------------------------------------
        // PASS 1 — CORE  (NormalBlending)
        //
        // Narrow Gaussian. Near-opaque at centerline.
        //
        // Depth model: exp(-viewZ * 0.042) — very gentle fade.
        //   At the camera distances used (viewZ 6–9), this gives dF 0.69–0.78.
        //   Rings dim slightly with depth but never desaturate. Saturation = 1.0
        //   everywhere — the mockup shows fully saturated cyan at the farthest ring.
        //
        // Luminance: baseColor * (0.70 + 0.30 * profile)
        //   Centerline gets full color, edge gets 70% — a gentle inner falloff
        //   that keeps the tube body bright without a hard boundary.
        // -----------------------------------------------------------------
        const coreMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.NormalBlending,
            side: THREE.DoubleSide,
            uniforms: {
                uBaseColor:  { value: baseColor.clone() },
                uRadius:     { value: def.r },
                uSigma:      { value: def.sigma },
                uMaxOpacity: { value: def.coreOpacity },
            },
            vertexShader: `
                varying vec2  vLocal;
                varying float vViewZ;
                void main() {
                    vec4 world = modelMatrix * vec4(position, 1.0);
                    vec4 view  = viewMatrix * world;
                    vLocal = position.xy;
                    vViewZ = abs(view.z);
                    gl_Position = projectionMatrix * view;
                }
            `,
            fragmentShader: `
                varying vec2  vLocal;
                varying float vViewZ;
                uniform vec3  uBaseColor;
                uniform float uRadius;
                uniform float uSigma;
                uniform float uMaxOpacity;

                void main() {
                    float d       = length(vLocal);
                    float dist    = abs(d - uRadius);
                    float profile = exp(-(dist * dist) / (2.0 * uSigma * uSigma));

                    if (profile < 0.005) discard;

                    // Gentle depth fade — neon color and saturation never change.
                    float dF    = exp(-vViewZ * 0.042);
                    float alpha = profile * uMaxOpacity * dF;
                    alpha = min(alpha, 0.96);

                    vec3 color = uBaseColor * (0.70 + 0.30 * profile);

                    gl_FragColor = vec4(color, alpha);
                }
            `
        });

        const coreMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(extent * 2.0, extent * 2.0, 1, 1),
            coreMat
        );
        coreMesh.rotation.x = -Math.PI / 2;
        group.add(coreMesh);

        // -----------------------------------------------------------------
        // PASS 2 — BLOOM HALO  (AdditiveBlending)
        //
        // sigma_halo = sigma_core * 7.5
        // This extreme ratio separates the bloom visually from the core,
        // producing the wide colored spill seen in the mockup — especially
        // visible at the bottom two rings where orange light pools broadly.
        //
        // Asymmetric falloff:
        //   signedDist >= 0 (outside ring) → full sigma_halo
        //   signedDist <  0 (inside ring)  → sigma_halo * 0.55
        // Glow radiates outward into open space more than inward.
        //
        // No alpha cap — additive blending accumulates luminance but
        // cannot exceed the display maximum, so capping is unnecessary.
        // -----------------------------------------------------------------
        const haloMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: {
                uBaseColor:   { value: baseColor.clone() },
                uRadius:      { value: def.r },
                uHaloSigma:   { value: haloSigma },
                uHaloOpacity: { value: def.haloOpacity },
            },
            vertexShader: `
                varying vec2  vLocal;
                varying float vViewZ;
                void main() {
                    vec4 world = modelMatrix * vec4(position, 1.0);
                    vec4 view  = viewMatrix * world;
                    vLocal = position.xy;
                    vViewZ = abs(view.z);
                    gl_Position = projectionMatrix * view;
                }
            `,
            fragmentShader: `
                varying vec2  vLocal;
                varying float vViewZ;
                uniform vec3  uBaseColor;
                uniform float uRadius;
                uniform float uHaloSigma;
                uniform float uHaloOpacity;

                void main() {
                    float d          = length(vLocal);
                    float signedDist = d - uRadius;

                    // Asymmetric: outward = full sigma, inward = 55%
                    float sigma   = (signedDist >= 0.0) ? uHaloSigma : uHaloSigma * 0.55;
                    float profile = exp(-(signedDist * signedDist) / (2.0 * sigma * sigma));

                    if (profile < 0.003) discard;

                    float dF    = exp(-vViewZ * 0.042);
                    float alpha = profile * uHaloOpacity * dF;

                    // Halo color: same hue, slightly dimmer than core so the
                    // centerline still reads as the brightest point.
                    vec3 color = uBaseColor * 0.85;

                    gl_FragColor = vec4(color, alpha);
                }
            `
        });

        const haloMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(extent * 2.0, extent * 2.0, 1, 1),
            haloMat
        );
        haloMesh.rotation.x = -Math.PI / 2;
        group.add(haloMesh);

        return group;
    }

    update() {}
}

class AxisSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);

        const axisMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uCore: { value: new THREE.Color(0xd7c19c) },
                uHalo: { value: new THREE.Color(0x6488a0) },
                uOpacity: { value: Math.min(0.09, VISUAL_SCENE_CONFIG.axisOpacity) }
            },
            vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec3 vPos;
                uniform vec3 uCore;
                uniform vec3 uHalo;
                uniform float uOpacity;
                void main(){
                    float r = length(vPos.xz);
                    float yFade = smoothstep(1.2, 0.2, abs(vPos.y));
                    float core = exp(-pow(r * 36.0, 2.0));
                    float halo = exp(-pow(r * 12.5, 2.0));
                    float alpha = (core * 0.45 + halo * 0.16) * yFade * uOpacity;
                    vec3 col = mix(uHalo, uCore, core);
                    gl_FragColor = vec4(col, alpha);
                }
            `
        });

        const axisMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.008, VISUAL_SCENE_CONFIG.axisHeight * 0.72, 20, 1, true), axisMat);
        axisMesh.position.y = 0.05;
        this.group.add(axisMesh);
    }

    update() {}
}

class CameraSystem {
    constructor(camera) {
        this.camera = camera;
        this.target = new THREE.Vector3(0, -0.06, -0.42);
        this.apply();
    }

    apply() {
        this.camera.position.set(0, 1.84, VISUAL_SCENE_CONFIG.cameraDistance);
        this.camera.lookAt(this.target);
    }

    update() {}
}

class VisualizerEngine {
    constructor(canvasId, audioManager) {
        this.audio = audioManager;
        this.canvas = document.getElementById(canvasId);

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 0.9;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 100);

        this.buildStaticScene();
        this.bindEvents();
        this.renderStaticFrame();
    }

    buildStaticScene() {
        this.systems = {
            background: new BackgroundSystem(this.scene),
            pitchBands: new PitchBandSystem(this.scene),
            rings: new RingSystem(this.scene),
            axis: new AxisSystem(this.scene),
            camera: new CameraSystem(this.camera)
        };
    }

    bindEvents() {
        window.addEventListener('resize', () => {
            const width = window.innerWidth;
            const height = window.innerHeight;
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(width, height);
            this.renderStaticFrame();
        });
    }

    renderStaticFrame() {
        Object.values(this.systems).forEach((system) => system.update());
        this.renderer.render(this.scene, this.camera);
    }
}

window.VisualizerEngine = VisualizerEngine;
