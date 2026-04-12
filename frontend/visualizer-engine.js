// Static ring-based baseline scene for Stage 1.
// Relies on globals: THREE.

const VISUAL_SCENE_CONFIG = {
    backgroundTop: 0x0a1322,
    backgroundBottom: 0x02060d,
    ringThickness: 0.11,
    ringGlow: 0.32,
    ringOpacity: 0.56,
    bandOpacity: 0.1,
    axisOpacity: 0.22,
    cameraDistance: 7.4,
    pitchBandCount: 7
};

class BackgroundSystem {
    constructor(scene) {
        const domeGeometry = new THREE.SphereGeometry(28, 48, 48);
        const domeMaterial = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            uniforms: {
                uTop: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundTop) },
                uBottom: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundBottom) }
            },
            vertexShader: `varying vec3 vWorldPos; void main(){ vec4 world = modelMatrix * vec4(position, 1.0); vWorldPos = world.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec3 vWorldPos;
                uniform vec3 uTop;
                uniform vec3 uBottom;
                void main(){
                    float h = clamp((vWorldPos.y + 6.0) / 12.0, 0.0, 1.0);
                    float t = smoothstep(0.1, 0.85, h);
                    vec3 col = mix(uBottom, uTop, t);
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

        const yMin = -1.4;
        const yMax = 1.8;
        const gap = (yMax - yMin) / (VISUAL_SCENE_CONFIG.pitchBandCount - 1);
        const bandGeo = new THREE.PlaneGeometry(7.6, 0.62, 1, 1);

        for (let i = 0; i < VISUAL_SCENE_CONFIG.pitchBandCount; i++) {
            const t = i / (VISUAL_SCENE_CONFIG.pitchBandCount - 1);
            const color = this.colorForBand(t);
            const mat = new THREE.ShaderMaterial({
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                uniforms: {
                    uColor: { value: color },
                    uOpacity: { value: VISUAL_SCENE_CONFIG.bandOpacity }
                },
                vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
                fragmentShader: `
                    varying vec2 vUv;
                    uniform vec3 uColor;
                    uniform float uOpacity;
                    void main(){
                        float verticalSoft = exp(-pow((vUv.y - 0.5) * 3.2, 2.0));
                        float horizontalSoft = smoothstep(0.0, 0.24, vUv.x) * (1.0 - smoothstep(0.76, 1.0, vUv.x));
                        gl_FragColor = vec4(uColor, verticalSoft * horizontalSoft * uOpacity);
                    }
                `
            });
            const band = new THREE.Mesh(bandGeo, mat);
            band.position.set(0, yMin + i * gap, -0.9);
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
            { y: -1.1, r: 0.72, color: 0xb27344 },
            { y: -0.42, r: 1.05, color: 0xc89a56 },
            { y: 0.15, r: 0.86, color: 0x86a773 },
            { y: 0.82, r: 1.18, color: 0x6f93a5 },
            { y: 1.45, r: 0.94, color: 0x7298ac }
        ];

        ringDefinitions.forEach((def) => {
            const ring = this.createRing(def);
            this.group.add(ring);
        });
    }

    createRing(def) {
        const group = new THREE.Group();
        group.position.y = def.y;

        const thickness = VISUAL_SCENE_CONFIG.ringThickness;
        const innerRadius = Math.max(0.01, def.r - thickness * 0.5);
        const outerRadius = def.r + thickness * 0.5;

        const ringMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uColor: { value: new THREE.Color(def.color) },
                uOpacity: { value: VISUAL_SCENE_CONFIG.ringOpacity },
                uGlow: { value: VISUAL_SCENE_CONFIG.ringGlow }
            },
            vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uColor;
                uniform float uOpacity;
                uniform float uGlow;
                void main(){
                    float ringBody = exp(-pow((vUv.y - 0.5) * 2.9, 2.0));
                    float innerEdge = smoothstep(0.2, 0.0, vUv.y);
                    float outerSoft = 1.0 - smoothstep(0.5, 1.0, vUv.y);
                    float alpha = ringBody * 0.72 + innerEdge * uGlow + outerSoft * 0.18;
                    gl_FragColor = vec4(uColor, alpha * uOpacity);
                }
            `
        });

        const ring = new THREE.Mesh(new THREE.RingGeometry(innerRadius, outerRadius, 160), ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.scale.set(1.0, 0.74, 1.0);
        group.add(ring);

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
        axisMesh.position.y = 0.2;
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
        this.camera.position.set(0, 1.2, VISUAL_SCENE_CONFIG.cameraDistance);
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
