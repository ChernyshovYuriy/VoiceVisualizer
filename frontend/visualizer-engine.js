// Static ring-based baseline scene for Stage 1.
// Relies on globals: THREE.

const VISUAL_SCENE_CONFIG = {
    backgroundTop: 0x0a1322,
    backgroundBottom: 0x02060d,
    backgroundHaze: 0x101d2e,
    ringThickness: 0.32,
    ringGlow: 0.52,
    ringOpacity: 0.64,
    ringEchoCount: 2,
    bandOpacity: 0.23,
    bandSoftness: 1.25,
    axisOpacity: 0.085,
    axisHeight: 2.35,
    bloomStrength: 0.18,
    cameraDistance: 6.45,
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

        const yMin = -1.8;
        const yMax = 2.05;
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
                    float sideFalloff = exp(-pow(vWorldPos.x * 0.14, 2.0));
                    float alpha = (weightAccum / float(max(uCount, 1))) * uOpacity * sideFalloff;
                    alpha *= distanceFactor;

                    if (alpha < 0.003) {
                        discard;
                    }

                    vec3 color = colorAccum / weightAccum;
                    color = applySaturation(color, mix(0.45, 0.9, distanceFactor));
                    color *= mix(0.6, 1.0, distanceFactor);
                    gl_FragColor = vec4(color, min(alpha, 0.22));
                }
            `
        });

        const fogPlane = new THREE.Mesh(new THREE.PlaneGeometry(17.0, 10.5, 1, 1), material);
        fogPlane.position.set(0.0, 0.1, -3.6);
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
            { t: 0.0, color: new THREE.Color(0x4b2532) },
            { t: 0.35, color: new THREE.Color(0x86552f) },
            { t: 0.6, color: new THREE.Color(0xab8a44) },
            { t: 0.82, color: new THREE.Color(0x4f7f7c) },
            { t: 1.0, color: new THREE.Color(0x5f8da0) }
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
            { y: -1.2, z: 0.45, r: 1.38, thicknessMul: 1.25, opacityMul: 1.15, glowMul: 1.0, color: 0xbf8650 },
            { y: -0.55, z: -0.2, r: 1.18, thicknessMul: 1.05, opacityMul: 0.95, glowMul: 0.85, color: 0xc99a58 },
            { y: 0.14, z: -0.9, r: 1.0, thicknessMul: 0.85, opacityMul: 0.7, glowMul: 0.66, color: 0x719072 },
            { y: 0.92, z: -1.55, r: 0.86, thicknessMul: 0.66, opacityMul: 0.5, glowMul: 0.52, color: 0x648497 },
            { y: 1.62, z: -2.15, r: 0.72, thicknessMul: 0.52, opacityMul: 0.37, glowMul: 0.42, color: 0x8298ac }
        ];

        ringDefinitions.forEach((def) => {
            this.group.add(this.createRing(def));
        });
    }

    createRing(def) {
        const group = new THREE.Group();
        group.position.set(0, def.y, def.z);

        const thickness = VISUAL_SCENE_CONFIG.ringThickness * def.thicknessMul;
        const baseColor = new THREE.Color(def.color);

        const layers = [
            { radiusOffset: 0.0, thicknessMul: 0.72, opacityMul: 1.0, glowMul: 1.0, blend: THREE.NormalBlending, yOff: 0.0, scaleX: 1.0, scaleY: 0.72 },
            { radiusOffset: -0.02, thicknessMul: 0.45, opacityMul: 0.56, glowMul: 0.9, blend: THREE.AdditiveBlending, yOff: 0.016, scaleX: 0.98, scaleY: 0.70 },
            { radiusOffset: 0.04, thicknessMul: 1.1, opacityMul: 0.3, glowMul: 0.62, blend: THREE.AdditiveBlending, yOff: -0.02, scaleX: 1.04, scaleY: 0.74 }
        ];

        layers.slice(0, VISUAL_SCENE_CONFIG.ringEchoCount + 1).forEach((layer) => {
            const mat = new THREE.ShaderMaterial({
                transparent: true,
                depthWrite: false,
                depthTest: true,
                blending: layer.blend,
                side: THREE.DoubleSide,
                uniforms: {
                    uBaseColor: { value: baseColor.clone() },
                    uRadius: { value: def.r + layer.radiusOffset },
                    uThickness: { value: thickness * layer.thicknessMul },
                    uOpacity: { value: VISUAL_SCENE_CONFIG.ringOpacity * def.opacityMul * layer.opacityMul },
                    uGlow: { value: VISUAL_SCENE_CONFIG.ringGlow * def.glowMul * layer.glowMul },
                    uDepthK: { value: VISUAL_SCENE_CONFIG.depthAttenuation },
                    uExtent: { value: def.r + thickness * 2.8 }
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
                    uniform float uThickness;
                    uniform float uOpacity;
                    uniform float uGlow;
                    uniform float uDepthK;
                    uniform float uExtent;

                    vec3 applySaturation(vec3 color, float sat) {
                        float l = dot(color, vec3(0.299, 0.587, 0.114));
                        return mix(vec3(l), color, sat);
                    }

                    void main() {
                        vec2 p = (vLocal / max(uExtent, 0.001));
                        float ellipseRadius = length(vec2(p.x, p.y * 1.08)) * uExtent;
                        float distance = abs(ellipseRadius - uRadius);

                        float inner = smoothstep(uThickness * 0.2, 0.0, distance);
                        float outer = smoothstep(uThickness, uThickness * 0.4, distance);
                        float alphaBand = inner * outer;

                        if (alphaBand < 0.001) {
                            discard;
                        }

                        float distanceFactor = clamp(1.0 - vViewDepth * uDepthK, 0.2, 1.0);
                        float alpha = alphaBand * uOpacity * (0.65 + 0.35 * uGlow) * distanceFactor;

                        vec3 color = uBaseColor * (0.6 + 0.4 * inner);
                        color = applySaturation(color, mix(0.42, 1.0, distanceFactor));
                        color *= mix(0.56, 1.0, distanceFactor);

                        gl_FragColor = vec4(color, alpha);
                    }
                `
            });

            const extent = def.r + thickness * 3.2;
            const ringMesh = new THREE.Mesh(new THREE.PlaneGeometry(extent * 2.0, extent * 2.0, 1, 1), mat);
            ringMesh.rotation.x = -Math.PI / 2;
            ringMesh.position.y = layer.yOff;
            ringMesh.scale.set(layer.scaleX, layer.scaleY, 1.0);
            group.add(ringMesh);
        });

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
        this.target = new THREE.Vector3(0, -0.12, -0.35);
        this.apply();
    }

    apply() {
        this.camera.position.set(0, 1.72, VISUAL_SCENE_CONFIG.cameraDistance);
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
