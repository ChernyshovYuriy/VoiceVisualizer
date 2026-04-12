// Refactored visualizer scene systems for static mockup-first composition.
// Relies on globals: THREE, MathUtils, CONFIG.

const VISUAL_SCENE_CONFIG = {
    background: 0x030712,
    fog: { color: 0x030712, density: 0.05 },
    camera: {
        fov: 34,
        distance: 6.1,
        height: 2.35,
        targetY: 2.2,
        driftAmount: 0.006,
        driftSpeed: 0.12
    },
    bloom: {
        strength: 0.16,
        radius: 0.2,
        threshold: 0.9
    },
    palette: {
        zoneLower: 0xd3a55c,
        zoneLowerMid: 0xb98e4e,
        zoneMid: 0x637ca7,
        zoneUpperMid: 0x61a2bf,
        zoneUpper: 0x78c4d8,
        axisCore: 0xf6e0bc,
        axisHalo: 0x6ea6c0
    },
    zones: {
        count: 7,
        yMin: 0.65,
        yMax: 4.55,
        alpha: 0.105
    },
    rings: {
        count: 7,
        thickness: 0.17,
        minRadius: 0.42,
        maxRadius: 1.02,
        glowLayers: 3,
        alpha: 0.86
    }
};

class EnvironmentSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);

        const dome = new THREE.SphereGeometry(14, 48, 48);
        this.domeMaterial = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            transparent: false,
            uniforms: {
                uTopColor: { value: new THREE.Color(0x0b1525) },
                uBottomColor: { value: new THREE.Color(0x030712) },
                uHorizon: { value: 0.56 }
            },
            vertexShader: `varying vec3 vWorld; void main(){ vec4 world = modelMatrix * vec4(position,1.0); vWorld = world.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
            fragmentShader: `
                varying vec3 vWorld;
                uniform vec3 uTopColor;
                uniform vec3 uBottomColor;
                uniform float uHorizon;
                void main(){
                    float h = clamp((vWorld.y + 2.0) / 9.0, 0.0, 1.0);
                    float blend = smoothstep(uHorizon - 0.24, uHorizon + 0.22, h);
                    vec3 color = mix(uBottomColor, uTopColor, blend);
                    gl_FragColor = vec4(color, 1.0);
                }
            `
        });

        this.group.add(new THREE.Mesh(dome, this.domeMaterial));

        const floor = new THREE.CircleGeometry(7, 128);
        floor.rotateX(-Math.PI / 2);
        this.floor = new THREE.Mesh(floor, new THREE.MeshStandardMaterial({
            color: 0x050a12,
            emissive: 0x091426,
            emissiveIntensity: 0.11,
            roughness: 0.92,
            metalness: 0.02,
            transparent: true,
            opacity: 0.92
        }));
        this.floor.position.y = -0.06;
        this.group.add(this.floor);

        this.zoneGroup = new THREE.Group();
        this.group.add(this.zoneGroup);
        this.buildZones();
    }

    zoneColorFor(normY) {
        const palette = VISUAL_SCENE_CONFIG.palette;
        const stops = [
            { t: 0.0, color: new THREE.Color(palette.zoneLower) },
            { t: 0.35, color: new THREE.Color(palette.zoneLowerMid) },
            { t: 0.6, color: new THREE.Color(palette.zoneMid) },
            { t: 0.8, color: new THREE.Color(palette.zoneUpperMid) },
            { t: 1.0, color: new THREE.Color(palette.zoneUpper) }
        ];

        for (let i = 0; i < stops.length - 1; i++) {
            const a = stops[i];
            const b = stops[i + 1];
            if (normY >= a.t && normY <= b.t) {
                const local = (normY - a.t) / (b.t - a.t);
                return a.color.clone().lerp(b.color, local);
            }
        }
        return stops[stops.length - 1].color.clone();
    }

    buildZones() {
        const cfg = VISUAL_SCENE_CONFIG.zones;
        const gap = (cfg.yMax - cfg.yMin) / (cfg.count - 1);
        const plane = new THREE.PlaneGeometry(4.8, 0.5);

        for (let i = 0; i < cfg.count; i++) {
            const y = cfg.yMin + i * gap;
            const t = i / (cfg.count - 1);
            const color = this.zoneColorFor(t);
            const mat = new THREE.ShaderMaterial({
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                uniforms: {
                    uColor: { value: color },
                    uAlpha: { value: cfg.alpha * (0.84 + t * 0.5) }
                },
                vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
                fragmentShader: `
                    varying vec2 vUv;
                    uniform vec3 uColor;
                    uniform float uAlpha;
                    void main(){
                        float core = exp(-pow((vUv.y - 0.5) * 4.4, 2.0));
                        float xFade = smoothstep(0.05, 0.35, vUv.x) * (1.0 - smoothstep(0.65, 0.95, vUv.x));
                        gl_FragColor = vec4(uColor, core * xFade * uAlpha);
                    }
                `
            });
            const strip = new THREE.Mesh(plane, mat);
            strip.position.set(0, y, -0.26);
            this.zoneGroup.add(strip);
        }
    }

    update() {}
}

class AxisSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);

        const material = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: {
                uCoreColor: { value: new THREE.Color(VISUAL_SCENE_CONFIG.palette.axisCore) },
                uHaloColor: { value: new THREE.Color(VISUAL_SCENE_CONFIG.palette.axisHalo) },
                uOpacity: { value: 0.42 }
            },
            vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);} `,
            fragmentShader: `
                varying vec3 vPos;
                uniform vec3 uCoreColor;
                uniform vec3 uHaloColor;
                uniform float uOpacity;
                void main(){
                    float r = length(vPos.xz);
                    float core = exp(-pow(r * 26.0, 2.0));
                    float halo = exp(-pow(r * 9.0, 2.0));
                    float yFade = smoothstep(-0.1, 0.4, vPos.y) * (1.0 - smoothstep(4.8, 5.2, vPos.y));
                    vec3 col = mix(uHaloColor, uCoreColor, clamp(core * 1.35, 0.0, 1.0));
                    float alpha = (halo * 0.62 + core * 0.85) * uOpacity * yFade;
                    gl_FragColor = vec4(col, alpha);
                }
            `
        });

        const axisGeo = new THREE.CylinderGeometry(0.085, 0.065, 5.2, 40, 1, true);
        this.axis = new THREE.Mesh(axisGeo, material);
        this.axis.position.y = 2.45;
        this.group.add(this.axis);

        const baseGlow = new THREE.Mesh(
            new THREE.SphereGeometry(0.18, 28, 28),
            new THREE.MeshBasicMaterial({
                color: VISUAL_SCENE_CONFIG.palette.axisCore,
                transparent: true,
                opacity: 0.24,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            })
        );
        baseGlow.position.set(0, 0.6, 0);
        this.group.add(baseGlow);
    }

    update() {}
}

class RingSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);
        this.rings = [];

        const cfg = VISUAL_SCENE_CONFIG.rings;
        const zcfg = VISUAL_SCENE_CONFIG.zones;

        for (let i = 0; i < cfg.count; i++) {
            const norm = i / (cfg.count - 1);
            const y = zcfg.yMin + norm * (zcfg.yMax - zcfg.yMin);
            const radius = THREE.MathUtils.lerp(cfg.minRadius, cfg.maxRadius, 1.0 - Math.abs(norm - 0.52) * 1.15);
            const color = this.colorForZone(norm);
            const ring = this.buildRing({ radius, y, color, thickness: cfg.thickness });
            this.group.add(ring.group);
            this.rings.push(ring);
        }
    }

    colorForZone(normY) {
        const p = VISUAL_SCENE_CONFIG.palette;
        const low = new THREE.Color(p.zoneLower);
        const mid = new THREE.Color(p.zoneMid);
        const up = new THREE.Color(p.zoneUpper);
        if (normY < 0.5) return low.lerp(mid, normY * 2.0);
        return mid.lerp(up, (normY - 0.5) * 2.0);
    }

    buildRing({ radius, y, color, thickness }) {
        const group = new THREE.Group();
        group.position.y = y;

        const segs = 180;
        const ringGeo = new THREE.RingGeometry(radius - thickness * 0.5, radius + thickness * 0.5, segs);
        const ringMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uColor: { value: color },
                uAlpha: { value: VISUAL_SCENE_CONFIG.rings.alpha },
                uInnerBoost: { value: 1.15 }
            },
            vertexShader: `varying vec2 vUv; varying vec3 vPos; void main(){ vUv=uv; vPos=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
            fragmentShader: `
                varying vec2 vUv;
                varying vec3 vPos;
                uniform vec3 uColor;
                uniform float uAlpha;
                uniform float uInnerBoost;
                void main(){
                    float center = abs(vUv.y - 0.5) * 2.0;
                    float thicknessMask = exp(-pow(center * 2.6, 2.0));
                    float innerEdge = smoothstep(0.08, 0.0, vUv.y) * uInnerBoost;
                    float outerFalloff = 1.0 - smoothstep(0.58, 1.0, vUv.y);
                    float layered = thicknessMask * 0.7 + innerEdge * 0.45 + outerFalloff * 0.22;
                    gl_FragColor = vec4(uColor, layered * uAlpha);
                }
            `
        });

        const ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.rotation.x = -Math.PI / 2;
        group.add(ringMesh);

        const glowLayers = VISUAL_SCENE_CONFIG.rings.glowLayers;
        for (let l = 0; l < glowLayers; l++) {
            const scale = 1.0 + l * 0.06;
            const glowGeo = new THREE.RingGeometry(
                (radius - thickness * 0.5) * scale,
                (radius + thickness * (0.9 + l * 0.6)) * scale,
                120
            );
            const glowMat = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.08 / (l + 1),
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide
            });
            const glow = new THREE.Mesh(glowGeo, glowMat);
            glow.rotation.x = -Math.PI / 2;
            glow.position.y = 0.001 + l * 0.0004;
            group.add(glow);
        }

        return { group, ringMesh };
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
        this.renderer.toneMappingExposure = 0.94;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(VISUAL_SCENE_CONFIG.background);
        this.scene.fog = new THREE.FogExp2(VISUAL_SCENE_CONFIG.fog.color, VISUAL_SCENE_CONFIG.fog.density);

        const cam = VISUAL_SCENE_CONFIG.camera;
        this.camera = new THREE.PerspectiveCamera(cam.fov, window.innerWidth / window.innerHeight, 0.1, 80);
        this.camera.position.set(0.08, cam.height, cam.distance);
        this.camera.lookAt(0, cam.targetY, 0);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, cam.targetY, 0);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.04;
        this.controls.enablePan = false;
        this.controls.enableRotate = false;
        this.controls.enableZoom = false;

        this.composer = new THREE.EffectComposer(this.renderer);
        this.composer.addPass(new THREE.RenderPass(this.scene, this.camera));
        this.bloom = new THREE.UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            VISUAL_SCENE_CONFIG.bloom.strength,
            VISUAL_SCENE_CONFIG.bloom.radius,
            VISUAL_SCENE_CONFIG.bloom.threshold
        );
        this.composer.addPass(this.bloom);

        this.buildScene();
        this.bindEvents();

        this.lastTime = performance.now();
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    buildScene() {
        const ambient = new THREE.AmbientLight(0x0b1220, 0.42);
        const key = new THREE.DirectionalLight(0x3f6784, 0.24);
        key.position.set(0.4, 5.8, 2.4);
        const fill = new THREE.DirectionalLight(0x9d8b68, 0.15);
        fill.position.set(-1.5, 2.2, 1.6);
        this.scene.add(ambient, key, fill);

        this.systems = {
            environment: new EnvironmentSystem(this.scene),
            axis: new AxisSystem(this.scene),
            rings: new RingSystem(this.scene),
            uiHooks: { update: () => {} }
        };
    }

    bindEvents() {
        window.addEventListener('resize', () => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
            this.composer.setSize(w, h);
            this.bloom.resolution.set(w, h);
        });
    }

    animate(now) {
        requestAnimationFrame(this.animate);
        const dt = Math.min(0.05, (now - this.lastTime) / 1000 || 0.016);
        this.lastTime = now;

        this.audio.updateTime(dt);
        this.updateScene(now * 0.001);

        const cam = VISUAL_SCENE_CONFIG.camera;
        const driftT = now * 0.001 * cam.driftSpeed;
        this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, 0.08 + Math.sin(driftT) * cam.driftAmount, 0.018);
        this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, cam.height + Math.cos(driftT * 0.7) * cam.driftAmount * 0.8, 0.018);
        this.controls.update();

        this.composer.render();
    }

    updateScene() {
        this.systems.environment.update();
        this.systems.axis.update();
        this.systems.rings.update();
        this.systems.uiHooks.update();

        // Keep bloom low for readability in paused/static composition.
        this.bloom.strength = VISUAL_SCENE_CONFIG.bloom.strength;
        this.bloom.radius = VISUAL_SCENE_CONFIG.bloom.radius;
        this.bloom.threshold = VISUAL_SCENE_CONFIG.bloom.threshold;
    }
}

window.VisualizerEngine = VisualizerEngine;
