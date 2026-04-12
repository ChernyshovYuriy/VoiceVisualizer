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
    bloomStrength: 0.18,
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

        // 6 rings, ordered back-to-front so near rings composite over far ones.
        //
        // sigma      — Gaussian half-width of the luminous band, world units.
        //              Defined as a physical size; perspective projection handles
        //              apparent screen thinning for distant rings automatically.
        // maxOpacity — peak alpha at the ring centerline (core pass).
        // haloOpacity— peak alpha for the additive halo pass.
        // color      — dark base color; luminance is applied via the profile
        //              multiplier inside the shader, not via a bright hex value.
        const ringDefinitions = [
            { y:  1.60, z: -3.20, r: 0.52, sigma: 0.045, maxOpacity: 0.18, haloOpacity: 0.04, color: 0x3a4a58 },
            { y:  1.10, z: -2.50, r: 0.74, sigma: 0.058, maxOpacity: 0.28, haloOpacity: 0.06, color: 0x4a5040 },
            { y:  0.48, z: -1.70, r: 1.00, sigma: 0.074, maxOpacity: 0.42, haloOpacity: 0.07, color: 0x5a5245 },
            { y: -0.22, z: -0.88, r: 1.28, sigma: 0.096, maxOpacity: 0.58, haloOpacity: 0.09, color: 0x6e5a38 },
            { y: -0.86, z: -0.18, r: 1.58, sigma: 0.124, maxOpacity: 0.74, haloOpacity: 0.10, color: 0x7a5530 },
            { y: -1.40, z:  0.42, r: 1.92, sigma: 0.160, maxOpacity: 0.92, haloOpacity: 0.12, color: 0x8a6030 },
        ];

        ringDefinitions.forEach((def) => {
            this.group.add(this.createRing(def));
        });
    }

    createRing(def) {
        const group = new THREE.Group();
        group.position.set(0, def.y, def.z);

        const baseColor = new THREE.Color(def.color);

        // Quad size: covers ring radius + worst-case halo reach (sigma * 3.5 * 3.5 = ~12×sigma).
        // Any fragment beyond 3*sigma_halo contributes < 1% and is discarded in the shader.
        const haloReach = def.sigma * 3.5 * 3.5;
        const extent    = def.r + haloReach;

        // ------------------------------------------------------------------
        // PASS 1 — CORE  (NormalBlending)
        //
        // Single Gaussian: profile = exp(-d²/2σ²) where d = |dist_from_centerline|.
        // No smoothstep. No stacked luminance bands. No hard edges.
        //
        // Luminance:  baseColor * (0.40 + 0.60 * profile)
        //             → dim at falloff edge, full-bright only at centerline.
        // Saturation: mix(0.12, 0.78, dF)
        //             → primary depth cue; far rings read near-grey.
        // Depth:      dF = exp(-|viewZ| * 0.088)
        //             → exponential, not linear; range ~[0.42, 0.58] across stack.
        // Alpha:      profile * maxOpacity * dF, hard cap 0.88.
        // ------------------------------------------------------------------
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
                uMaxOpacity: { value: def.maxOpacity },
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

                vec3 applySaturation(vec3 color, float sat) {
                    float lum = dot(color, vec3(0.299, 0.587, 0.114));
                    return mix(vec3(lum), color, sat);
                }

                void main() {
                    // Circular distance in local XY.
                    // The ring plane is horizontal (rotation.x = -PI/2); perspective
                    // naturally produces ellipses — no manual Y warp needed or wanted.
                    float d            = length(vLocal);
                    float distFromEdge = abs(d - uRadius);

                    // One Gaussian. No plateaus, no shoulders, no hard cutoffs.
                    float profile = exp(-(distFromEdge * distFromEdge) / (2.0 * uSigma * uSigma));
                    if (profile < 0.005) discard;

                    // Exponential depth factor.
                    // Ring 5 at viewZ≈6.28 → dF≈0.575
                    // Ring 0 at viewZ≈9.90 → dF≈0.418
                    float dF = exp(-vViewZ * 0.088);

                    // Saturation is the primary depth cue — drops aggressively.
                    // At dF=0.418 (far): sat=0.19. At dF=0.575 (near): sat=0.38.
                    float sat   = mix(0.12, 0.78, dF);
                    vec3  color = uBaseColor * (0.40 + 0.60 * profile);
                    color       = applySaturation(color, sat);

                    float alpha = profile * uMaxOpacity * dF;
                    alpha = min(alpha, 0.88);

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

        // ------------------------------------------------------------------
        // PASS 2 — HALO  (AdditiveBlending)
        //
        // Wider Gaussian representing light scattered into surrounding space.
        //
        // sigmaHalo = sigmaCore * mix(2.2, 3.5, dF)
        //   Near rings (dF=0.575) → multiplier=2.95 → looser, wider glow.
        //   Far  rings (dF=0.418) → multiplier=2.74 → tighter, more focused.
        //
        // Asymmetric falloff: inward side uses sigmaHalo * 0.55.
        //   A real emissive torus scatters more light into open space (outside)
        //   than toward the hollow center (inside). This reproduces that behavior.
        //
        // Alpha: profile * haloOpacity * dF  (no cap — additive so it won't clip).
        // ------------------------------------------------------------------
        const haloMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: {
                uBaseColor:   { value: baseColor.clone() },
                uRadius:      { value: def.r },
                uSigmaCore:   { value: def.sigma },
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
                uniform float uSigmaCore;
                uniform float uHaloOpacity;

                vec3 applySaturation(vec3 color, float sat) {
                    float lum = dot(color, vec3(0.299, 0.587, 0.114));
                    return mix(vec3(lum), color, sat);
                }

                void main() {
                    float d          = length(vLocal);
                    // Signed: positive = outside the ring, negative = inside the hollow.
                    float signedDist = d - uRadius;

                    float dF = exp(-vViewZ * 0.088);

                    // Halo width grows toward the camera.
                    float sigmaHalo = uSigmaCore * mix(2.2, 3.5, dF);
                    // Inward side is tighter — glow radiates into open space, not inward.
                    float sigmaUsed = (signedDist >= 0.0) ? sigmaHalo : sigmaHalo * 0.55;

                    float profile = exp(-(signedDist * signedDist) / (2.0 * sigmaUsed * sigmaUsed));
                    if (profile < 0.004) discard;

                    // Halo saturation — slightly lower than core at same depth.
                    float sat   = mix(0.08, 0.65, dF);
                    vec3  color = applySaturation(uBaseColor, sat);

                    float alpha = profile * uHaloOpacity * dF;

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
