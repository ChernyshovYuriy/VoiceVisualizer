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

        const yMin = -1.7;
        const yMax = 2.05;
        const gap = (yMax - yMin) / (VISUAL_SCENE_CONFIG.pitchBandCount - 1);
        const bandGeo = new THREE.PlaneGeometry(9.2, 1.05, 1, 1);

        for (let i = 0; i < VISUAL_SCENE_CONFIG.pitchBandCount; i++) {
            const t = i / (VISUAL_SCENE_CONFIG.pitchBandCount - 1);
            const color = this.colorForBand(t);
            const mat = new THREE.ShaderMaterial({
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                uniforms: {
                    uColor: { value: color },
                    uOpacity: { value: VISUAL_SCENE_CONFIG.bandOpacity },
                    uSoftness: { value: VISUAL_SCENE_CONFIG.bandSoftness }
                },
                vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
                fragmentShader: `
                    varying vec2 vUv;
                    uniform vec3 uColor;
                    uniform float uOpacity;
                    uniform float uSoftness;
                    void main(){
                        float verticalSoft = exp(-pow((vUv.y - 0.5) * 2.35 / uSoftness, 2.0));
                        float horizontalCore = exp(-pow((vUv.x - 0.5) * 1.7, 2.0));
                        float horizontalFade = smoothstep(0.0, 0.16, vUv.x) * (1.0 - smoothstep(0.84, 1.0, vUv.x));
                        float alpha = verticalSoft * (horizontalCore * 0.85 + horizontalFade * 0.4) * uOpacity;
                        gl_FragColor = vec4(uColor, alpha);
                    }
                `
            });
            const band = new THREE.Mesh(bandGeo, mat);
            band.position.set(0, yMin + i * gap, -1.55);
            this.group.add(band);
        }
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
            { y: -1.22, r: 0.88, thicknessMul: 0.9, opacityMul: 0.8, glowMul: 0.9, color: 0xb47947 },
            { y: -0.46, r: 1.38, thicknessMul: 1.22, opacityMul: 1.1, glowMul: 1.08, color: 0xc9964f },
            { y: 0.22, r: 1.04, thicknessMul: 0.96, opacityMul: 0.76, glowMul: 0.76, color: 0x6f9472 },
            { y: 0.98, r: 0.9, thicknessMul: 0.72, opacityMul: 0.52, glowMul: 0.55, color: 0x65859a },
            { y: 1.64, r: 0.73, thicknessMul: 0.58, opacityMul: 0.36, glowMul: 0.45, color: 0x87a0b4 }
        ];

        ringDefinitions.forEach((def) => {
            const ring = this.createRing(def);
            this.group.add(ring);
        });
    }

    createRing(def) {
        const group = new THREE.Group();
        group.position.y = def.y;

        const thickness = VISUAL_SCENE_CONFIG.ringThickness * def.thicknessMul;
        const innerRadius = Math.max(0.01, def.r - thickness * 0.5);
        const outerRadius = def.r + thickness * 0.5;
        const baseColor = new THREE.Color(def.color);
        const rimColor = baseColor.clone().lerp(new THREE.Color(0xf3d7a8), 0.28);
        const haloColor = baseColor.clone().multiplyScalar(0.82);

        const ringGeometry = new THREE.RingGeometry(innerRadius, outerRadius, 220, 1);
        const ringMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uColor: { value: baseColor },
                uRimColor: { value: rimColor },
                uOpacity: { value: VISUAL_SCENE_CONFIG.ringOpacity * def.opacityMul },
                uGlow: { value: VISUAL_SCENE_CONFIG.ringGlow * def.glowMul }
            },
            vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uColor;
                uniform vec3 uRimColor;
                uniform float uOpacity;
                uniform float uGlow;
                void main(){
                    float rad = 1.0 - vUv.y;
                    float body = exp(-pow((rad - 0.42) * 2.3, 2.0));
                    float innerRim = exp(-pow(rad * 9.4, 2.0));
                    float outerFade = 1.0 - smoothstep(0.34, 1.0, rad);
                    float alpha = (body * 0.8 + innerRim * uGlow + outerFade * 0.35) * uOpacity;
                    vec3 col = mix(uColor * 0.82, uRimColor, innerRim * 0.9 + body * 0.35);
                    gl_FragColor = vec4(col, alpha);
                }
            `
        });

        const ring = new THREE.Mesh(ringGeometry, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.scale.set(1.0, 0.7, 1.0);
        group.add(ring);

        const haloMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uColor: { value: haloColor },
                uOpacity: { value: VISUAL_SCENE_CONFIG.ringOpacity * 0.28 * def.opacityMul },
                uGlow: { value: VISUAL_SCENE_CONFIG.ringGlow * 0.7 * def.glowMul }
            },
            vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uColor;
                uniform float uOpacity;
                uniform float uGlow;
                void main(){
                    float rad = 1.0 - vUv.y;
                    float halo = exp(-pow((rad - 0.66) * 1.75, 2.0));
                    float fringe = exp(-pow((rad - 0.87) * 3.5, 2.0));
                    float alpha = (halo * 0.75 + fringe * uGlow * 0.65) * uOpacity;
                    gl_FragColor = vec4(uColor, alpha);
                }
            `
        });
        const halo = new THREE.Mesh(
            new THREE.RingGeometry(innerRadius, outerRadius + thickness * 0.68, 220, 1),
            haloMat
        );
        halo.rotation.x = -Math.PI / 2;
        halo.scale.set(1.0, 0.72, 1.0);
        group.add(halo);

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
                uOpacity: { value: VISUAL_SCENE_CONFIG.axisOpacity }
            },
            vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec3 vPos;
                uniform vec3 uCore;
                uniform vec3 uHalo;
                uniform float uOpacity;
                void main(){
                    float r = length(vPos.xz);
                    float core = exp(-pow(r * 24.0, 2.0));
                    float halo = exp(-pow(r * 8.0, 2.0));
                    float alpha = (core * 0.8 + halo * 0.4) * uOpacity;
                    vec3 col = mix(uHalo, uCore, core);
                    gl_FragColor = vec4(col, alpha);
                }
            `
        });

        const axisMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 3.7, 32, 1, true), axisMat);
        axisMesh.geometry.dispose();
        axisMesh.geometry = new THREE.CylinderGeometry(0.023, 0.02, VISUAL_SCENE_CONFIG.axisHeight, 28, 1, true);
        axisMesh.position.y = 0.1;
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
