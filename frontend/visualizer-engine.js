// Static ring-based baseline scene for Stage 1.
// Relies on globals: THREE.

const VISUAL_SCENE_CONFIG = {
    backgroundTop: 0x0b1423,
    backgroundBottom: 0x030711,
    backgroundHaze: 0x112033,
    ringThickness: 0.34,
    ringGlow: 0.46,
    ringOpacity: 0.58,
    ringEchoCount: 2,
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

        const ringDefinitions = [
            { y: 1.32, z: -2.15, radius: 0.66, thicknessMul: 0.6, opacityMul: 0.4, color: 0x7b8ea1 },
            { y: 0.68, z: -1.5, radius: 0.84, thicknessMul: 0.78, opacityMul: 0.58, color: 0x6d857a },
            { y: 0.04, z: -0.84, radius: 1.02, thicknessMul: 0.92, opacityMul: 0.74, color: 0x7b916f },
            { y: -0.62, z: -0.16, radius: 1.2, thicknessMul: 1.08, opacityMul: 0.9, color: 0xb89159 },
            { y: -1.22, z: 0.5, radius: 1.4, thicknessMul: 1.24, opacityMul: 1.0, color: 0xaf7f4d }
        ];

        ringDefinitions.forEach((def) => {
            this.group.add(this.createRing(def));
        });
    }

    createRing(def) {
        const ringGroup = new THREE.Group();
        ringGroup.position.set(0, def.y, def.z);

        const thickness = VISUAL_SCENE_CONFIG.ringThickness * def.thicknessMul;
        const sigma = Math.max(thickness * 0.55, 0.001);
        const extent = def.radius + thickness * 3.8;

        const corePass = this.createRingPass({
            baseColor: new THREE.Color(def.color),
            radius: def.radius,
            sigma,
            opacity: VISUAL_SCENE_CONFIG.ringOpacity * def.opacityMul,
            glow: VISUAL_SCENE_CONFIG.ringGlow,
            extent,
            blendMode: THREE.NormalBlending,
            yOffset: 0.0,
            scaleX: 1.0,
            scaleY: 0.7,
            halo: 0.0
        });

        const haloPass = this.createRingPass({
            baseColor: new THREE.Color(def.color),
            radius: def.radius,
            sigma: sigma * 1.85,
            opacity: VISUAL_SCENE_CONFIG.ringOpacity * def.opacityMul * 0.52,
            glow: VISUAL_SCENE_CONFIG.ringGlow,
            extent,
            blendMode: THREE.AdditiveBlending,
            yOffset: 0.01,
            scaleX: 1.015,
            scaleY: 0.715,
            halo: 1.0
        });

        ringGroup.add(corePass);
        ringGroup.add(haloPass);
        return ringGroup;
    }

    createRingPass(params) {
        const material = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: params.blendMode,
            side: THREE.DoubleSide,
            uniforms: {
                uBaseColor: { value: params.baseColor.clone() },
                uRadius: { value: params.radius },
                uSigma: { value: params.sigma },
                uOpacity: { value: params.opacity },
                uGlow: { value: params.glow },
                uDepthK: { value: VISUAL_SCENE_CONFIG.depthAttenuation },
                uExtent: { value: params.extent },
                uHalo: { value: params.halo }
            },
            vertexShader: `
                varying vec2 vLocal;
                varying float vViewDepth;
                void main() {
                    vec4 world = modelMatrix * vec4(position, 1.0);
                    vec4 view = viewMatrix * world;
                    vLocal = position.xy;
                    vViewDepth = abs(view.z);
                    gl_Position = projectionMatrix * view;
                }
            `,
            fragmentShader: `
                varying vec2 vLocal;
                varying float vViewDepth;
                uniform vec3 uBaseColor;
                uniform float uRadius;
                uniform float uSigma;
                uniform float uOpacity;
                uniform float uGlow;
                uniform float uDepthK;
                uniform float uExtent;
                uniform float uHalo;

                vec3 applySaturation(vec3 color, float sat) {
                    float l = dot(color, vec3(0.299, 0.587, 0.114));
                    return mix(vec3(l), color, sat);
                }

                float gaussianProfile(float d, float sigma) {
                    return exp(-(d * d) / (2.0 * sigma * sigma));
                }

                void main() {
                    vec2 p = vLocal / max(uExtent, 0.001);
                    float ellipseRadius = length(vec2(p.x, p.y * 1.08)) * uExtent;
                    float distanceToRing = abs(ellipseRadius - uRadius);

                    float profile = gaussianProfile(distanceToRing, max(uSigma, 0.0001));
                    if (profile < 0.001) {
                        discard;
                    }

                    float distanceFactor = clamp(1.0 - vViewDepth * uDepthK, 0.2, 1.0);
                    float alpha = profile * uOpacity * (0.62 + 0.26 * uGlow);
                    alpha *= mix(1.0, 0.8, uHalo);
                    alpha *= distanceFactor;
                    alpha = min(alpha, 0.68);

                    vec3 color = uBaseColor * (0.5 + 0.5 * profile);
                    color = applySaturation(color, mix(0.44, 1.0, distanceFactor));
                    color *= mix(0.55, 0.95, distanceFactor);

                    gl_FragColor = vec4(color, alpha);
                }
            `
        });

        const geometry = new THREE.PlaneGeometry(params.extent * 2.0, params.extent * 2.0, 1, 1);
        const ringMesh = new THREE.Mesh(geometry, material);
        ringMesh.rotation.x = -Math.PI / 2;
        ringMesh.position.y = params.yOffset;
        ringMesh.scale.set(params.scaleX, params.scaleY, 1.0);
        return ringMesh;
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
