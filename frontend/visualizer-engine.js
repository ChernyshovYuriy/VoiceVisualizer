// Static ring-based baseline scene for Stage 1.
// Relies on globals: THREE.

const VISUAL_SCENE_CONFIG = {
    backgroundTop: 0x0a1322,
    backgroundBottom: 0x02060d,
    backgroundHaze: 0x101d2e,
    ringThickness: 0.32,
    ringGlow: 0.52,
    ringOpacity: 0.64,
    bandOpacity: 0.23,
    bandSoftness: 1.25,
    axisOpacity: 0.085,
    axisHeight: 2.35,
    cameraDistance: 6.45,
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

        const volumeMaterial = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uOpacity: { value: VISUAL_SCENE_CONFIG.bandOpacity * 0.55 },
                uCenters: { value: centers },
                uColors: { value: colors },
                uCount: { value: VISUAL_SCENE_CONFIG.pitchBandCount },
                uSoftness: { value: 0.62 }
            },
            vertexShader: `
                varying vec3 vWorldPos;
                void main() {
                    vec4 world = modelMatrix * vec4(position, 1.0);
                    vWorldPos = world.xyz;
                    gl_Position = projectionMatrix * viewMatrix * world;
                }
            `,
            fragmentShader: `
                varying vec3 vWorldPos;
                uniform float uOpacity;
                uniform float uCenters[7];
                uniform vec3 uColors[7];
                uniform int uCount;
                uniform float uSoftness;

                void main() {
                    vec3 sumColor = vec3(0.0);
                    float alpha = 0.0;

                    for (int i = 0; i < 7; i++) {
                        if (i >= uCount) { break; }
                        float dy = (vWorldPos.y - uCenters[i]) / uSoftness;
                        float layer = exp(-dy * dy);
                        sumColor += uColors[i] * layer;
                        alpha += layer;
                    }

                    float depthFade = exp(-pow(vWorldPos.x * 0.11, 2.0));
                    depthFade *= exp(-pow((vWorldPos.z + 4.8) * 0.2, 2.0));
                    float edgeFade = exp(-pow(vWorldPos.x * 0.08, 2.0));
                    alpha = alpha * uOpacity * depthFade * edgeFade;

                    if (alpha < 0.003) {
                        discard;
                    }

                    vec3 color = sumColor / max(alpha / max(uOpacity, 0.0001), 0.0001);
                    gl_FragColor = vec4(color, min(alpha, 0.28));
                }
            `
        });

        const volume = new THREE.Mesh(new THREE.PlaneGeometry(16.0, 10.0, 1, 1), volumeMaterial);
        volume.position.set(0, 0.1, -3.8);
        this.group.add(volume);
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
            const ring = this.createRing(def);
            this.group.add(ring);
        });
    }

    createRing(def) {
        const group = new THREE.Group();
        group.position.set(0, def.y, def.z);

        const thickness = VISUAL_SCENE_CONFIG.ringThickness * def.thicknessMul;
        const depthT = THREE.MathUtils.clamp((def.z + 2.3) / 2.8, 0.0, 1.0);
        const depthSaturation = THREE.MathUtils.lerp(0.72, 1.0, depthT);
        const nearBoost = THREE.MathUtils.lerp(0.78, 1.0, depthT);
        const baseColor = new THREE.Color(def.color);
        baseColor.lerp(new THREE.Color(0x64748a), 1.0 - depthSaturation);
        const rimColor = baseColor.clone().lerp(new THREE.Color(0xf2d7aa), 0.26);
        const haloColor = baseColor.clone().multiplyScalar(0.78);

        const ringGeometry = new THREE.CircleGeometry(def.r + thickness * 1.65, 280);

        const makeBandMaterial = (profile) => new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uColor: { value: baseColor },
                uRimColor: { value: rimColor },
                uInner: { value: profile.inner },
                uOuter: { value: profile.outer },
                uSoftInner: { value: profile.softInner },
                uSoftOuter: { value: profile.softOuter },
                uRimWeight: { value: profile.rimWeight },
                uBodyWeight: { value: profile.bodyWeight },
                uOpacity: { value: VISUAL_SCENE_CONFIG.ringOpacity * def.opacityMul * profile.opacity * nearBoost },
                uGlow: { value: VISUAL_SCENE_CONFIG.ringGlow * def.glowMul * profile.glow }
            },
            vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uColor;
                uniform vec3 uRimColor;
                uniform float uInner;
                uniform float uOuter;
                uniform float uSoftInner;
                uniform float uSoftOuter;
                uniform float uRimWeight;
                uniform float uBodyWeight;
                uniform float uOpacity;
                uniform float uGlow;
                void main(){
                    vec2 p = vUv * 2.0 - 1.0;
                    float radial = length(p);
                    float inside = smoothstep(uInner - uSoftInner, uInner + uSoftInner, radial);
                    float outside = 1.0 - smoothstep(uOuter - uSoftOuter, uOuter + uSoftOuter, radial);
                    float ringMask = inside * outside;

                    if (ringMask < 0.001) {
                        discard;
                    }

                    float ringT = clamp((radial - uInner) / max(uOuter - uInner, 0.001), 0.0, 1.0);
                    float innerRim = exp(-pow(ringT * 8.0, 2.0));
                    float body = exp(-pow((ringT - 0.48) * 2.2, 2.0));
                    float outerGlow = exp(-pow((ringT - 0.92) * 3.0, 2.0));
                    float alpha = ringMask * (innerRim * uRimWeight * uGlow + body * uBodyWeight + outerGlow * 0.45 * uGlow) * uOpacity;
                    vec3 col = mix(uColor * 0.8, uRimColor, innerRim * 0.9 + body * 0.32);
                    gl_FragColor = vec4(col, alpha);
                }
            `
        });

        const layers = [
            { inner: def.r - thickness * 0.54, outer: def.r + thickness * 0.46, softInner: 0.012, softOuter: 0.035, rimWeight: 1.15, bodyWeight: 0.72, opacity: 1.0, glow: 1.0, yOff: 0.0, xScale: 1.0, zScale: 0.68, colorShift: 0.0 },
            { inner: def.r - thickness * 0.35, outer: def.r + thickness * 0.26, softInner: 0.01, softOuter: 0.03, rimWeight: 0.78, bodyWeight: 0.66, opacity: 0.52, glow: 0.78, yOff: 0.018, xScale: 0.98, zScale: 0.67, colorShift: 0.06 },
            { inner: def.r - thickness * 0.6, outer: def.r + thickness * 0.95, softInner: 0.05, softOuter: 0.08, rimWeight: 0.34, bodyWeight: 0.56, opacity: 0.3, glow: 0.65, yOff: -0.024, xScale: 1.03, zScale: 0.7, colorShift: -0.08 }
        ];

        layers.forEach((layer) => {
            const mat = makeBandMaterial(layer);
            mat.uniforms.uColor.value = haloColor.clone().lerp(baseColor, 0.5 + layer.colorShift);
            mat.uniforms.uRimColor.value = rimColor.clone().lerp(baseColor, 0.25);
            const mesh = new THREE.Mesh(ringGeometry, mat);
            mesh.rotation.x = -Math.PI / 2;
            mesh.position.y = layer.yOff;
            mesh.scale.set(layer.xScale, 1.0, layer.zScale);
            group.add(mesh);
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
                uOpacity: { value: VISUAL_SCENE_CONFIG.axisOpacity * 0.38 }
            },
            vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec3 vPos;
                uniform vec3 uCore;
                uniform vec3 uHalo;
                uniform float uOpacity;
                void main(){
                    float r = length(vPos.xz);
                    float core = exp(-pow(r * 34.0, 2.0));
                    float halo = exp(-pow(r * 11.0, 2.0));
                    float alpha = (core * 0.55 + halo * 0.2) * uOpacity;
                    vec3 col = mix(uHalo, uCore, core);
                    gl_FragColor = vec4(col, alpha);
                }
            `
        });

        const axisMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.01, 2.1, 22, 1, true), axisMat);
        axisMesh.geometry.dispose();
        axisMesh.geometry = new THREE.CylinderGeometry(0.011, 0.009, VISUAL_SCENE_CONFIG.axisHeight * 0.72, 20, 1, true);
        axisMesh.position.y = 0.05;
        this.group.add(axisMesh);
    }

    update() {}
}

class CameraSystem {
    constructor(camera) {
        this.camera = camera;
        this.target = new THREE.Vector3(0, 0.2, 0);
        this.apply();
    }

    apply() {
        this.camera.position.set(0, 1.48, VISUAL_SCENE_CONFIG.cameraDistance);
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
