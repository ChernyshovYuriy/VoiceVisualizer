// Extracted VisualizerEngine class from visualizer.html
// Redesigned into cinematic layers: beam, helix, sparks, ground, atmosphere.
// Relies on globals: THREE, MathUtils, CONFIG.

class BeamLayer {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);

        // Visual budget: narrow hero beam with clamped, controllable radiance.
        this.mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: {
                uIntensity: { value: 0.35 },
                uCore: { value: 0.42 },
                uFalloff: { value: 1.9 },
                uColorWarm: { value: new THREE.Color(0xffd190) },
                uColorHot: { value: new THREE.Color(0xfff6df) }
            },
            vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
            fragmentShader: `
                varying vec3 vPos;
                uniform float uIntensity;
                uniform float uCore;
                uniform float uFalloff;
                uniform vec3 uColorWarm;
                uniform vec3 uColorHot;
                void main(){
                    float r = length(vPos.xz);
                    float coreMask = 1.0 - smoothstep(0.0, uCore * 0.22, r);
                    float haloMask = 1.0 - smoothstep(uCore * 0.22, uCore, r);
                    float yFade = 0.86 + smoothstep(-2.6, 2.6, vPos.y) * 0.14;
                    float beam = clamp(coreMask * 0.9 + pow(haloMask, uFalloff) * 0.55, 0.0, 1.0);
                    float alpha = clamp(beam * uIntensity * yFade, 0.0, 0.72);
                    vec3 col = mix(uColorWarm, uColorHot, coreMask * 0.7 + beam * 0.25);
                    gl_FragColor = vec4(col, alpha);
                }
            `
        });

        const beamGeo = new THREE.CylinderGeometry(0.016, 0.009, 5.2, 24, 1, true);
        this.beam = new THREE.Mesh(beamGeo, this.mat);
        this.beam.position.y = 2.6;
        this.group.add(this.beam);

        const coreGeo = new THREE.SphereGeometry(0.07, 18, 18);
        this.core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({
            color: 0xfff2d6,
            transparent: true,
            opacity: 0.58,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        }));
        this.core.position.y = 0.06;
        this.group.add(this.core);

        this.light = new THREE.PointLight(0xffbc6a, 0.7, 5.2, 2.0);
        this.light.position.set(0, 2.4, 0.2);
        scene.add(this.light);
    }

    update(audio, t) {
        const loud = audio.smoothed.loudNorm;
        const onset = audio.smoothed.onset;
        const flash = audio.transientFlash;
        const alive = MathUtils.smoothstep(0.02, 0.12, loud);

        const pulse = 0.94 + Math.sin(t * 1.8) * 0.04;
        const unclampedIntensity = (0.18 + loud * 0.72 + onset * 0.28 + flash * 0.12) * pulse;
        const intensity = MathUtils.clamp(unclampedIntensity, 0.16, 0.82);

        this.mat.uniforms.uIntensity.value = intensity;
        this.mat.uniforms.uCore.value = 0.36 + loud * 0.04;
        this.mat.uniforms.uFalloff.value = 2.1;

        this.beam.scale.set(0.95 + loud * 0.08, 1.0 + loud * 0.16, 0.95 + loud * 0.08);
        this.core.material.opacity = MathUtils.clamp(0.08 + intensity * 0.45, 0.08, 0.38);
        this.core.scale.setScalar(0.35 + loud * 0.28 + onset * 0.2);

        this.light.intensity = 0.08 + intensity * 0.55;
        this.light.color.setRGB(1.0, 0.72 + loud * 0.1, 0.42 + loud * 0.12);
        this.group.visible = alive > 0.02;
    }
}

class HelixLayer {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);

        this.helixCount = 2; // dominant warm + faint cool counter-helix.
        this.height = 4.8;
        this.helices = [];

        for (let i = 0; i < this.helixCount; i++) {
            const isWarm = i === 0;
            const mat = new THREE.MeshStandardMaterial({
                color: isWarm ? 0xffc57a : 0x78a8ff,
                transparent: true,
                opacity: isWarm ? 0.58 : 0.1,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
                roughness: 0.35,
                metalness: 0.05,
                emissive: isWarm ? new THREE.Color(0xff8e3a) : new THREE.Color(0x365d9c),
                emissiveIntensity: isWarm ? 0.38 : 0.07
            });

            const curve = this.buildAuthoredHelix({
                radius: isWarm ? 0.145 : 0.19,
                turns: isWarm ? 3.35 : -3.0,
                phase: isWarm ? 0 : Math.PI * 0.78,
                yOffset: 0.14,
                yScale: 1,
                wobble: isWarm ? 0.015 : 0.008
            });

            const geo = new THREE.TubeGeometry(curve, 180, isWarm ? 0.018 : 0.009, 10, false);
            const mesh = new THREE.Mesh(geo, mat);
            this.group.add(mesh);

            this.helices.push({
                geo, mesh, mat, isWarm,
                baseRot: isWarm ? 0.22 : -0.1
            });
        }
    }

    buildAuthoredHelix({ radius, turns, phase, yOffset, yScale, wobble }) {
        const points = [];
        const steps = 24;
        for (let i = 0; i <= steps; i++) {
            const u = i / steps;
            const theta = phase + u * Math.PI * 2 * turns;
            const radialContour = radius * (1 - 0.12 * u + Math.sin(u * Math.PI * 2) * wobble);
            const x = Math.cos(theta) * radialContour;
            const z = Math.sin(theta) * radialContour;
            const y = yOffset + u * this.height * yScale;
            points.push(new THREE.Vector3(x, y, z));
        }
        return new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
    }

    update(audio, t) {
        const loud = audio.smoothed.loudNorm;
        const onset = audio.smoothed.onset;

        for (const h of this.helices) {
            h.mat.opacity = (h.isWarm ? 0.4 : 0.05) + loud * (h.isWarm ? 0.24 : 0.08) + onset * (h.isWarm ? 0.09 : 0.04);
            h.mat.emissiveIntensity = (h.isWarm ? 0.3 : 0.05) + loud * (h.isWarm ? 0.22 : 0.04);
            h.mesh.rotation.y = h.baseRot + t * (h.isWarm ? 0.08 : -0.06);
        }
    }
}

class SparkLayer {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);

        // Visual budget: sparse near-beam sparks only.
        this.count = 110;
        this.positions = new Float32Array(this.count * 3);
        this.colors = new Float32Array(this.count * 3);
        this.sizes = new Float32Array(this.count);
        this.life = new Float32Array(this.count);
        this.vel = new Float32Array(this.count * 3);

        for (let i = 0; i < this.count; i++) this.reset(i, true);

        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        g.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
        g.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));

        const vtx = `
            attribute float size;
            varying vec3 vColor;
            void main(){
                vColor = color;
                vec4 mv = modelViewMatrix * vec4(position,1.0);
                gl_PointSize = size * (260.0 / -mv.z);
                gl_Position = projectionMatrix * mv;
            }
        `;
        const frag = `
            varying vec3 vColor;
            void main(){
                float d = length(gl_PointCoord - 0.5) * 2.0;
                float a = (1.0 - smoothstep(0.0, 1.0, d));
                if (a < 0.01) discard;
                gl_FragColor = vec4(vColor, a * 0.85);
            }
        `;

        this.points = new THREE.Points(g, new THREE.ShaderMaterial({
            vertexShader: vtx,
            fragmentShader: frag,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            vertexColors: true
        }));

        this.group.add(this.points);
    }

    reset(i, init = false, spawnLift = 0) {
        const i3 = i * 3;
        const angle = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.07 + (init ? 0.05 : 0.03);
        this.positions[i3] = Math.cos(angle) * r;
        const hotZoneY = 0.5 + Math.random() * 3.6;
        this.positions[i3 + 1] = (init ? hotZoneY : 0.3 + Math.random() * 3.0 + spawnLift * 0.3);
        this.positions[i3 + 2] = Math.sin(angle) * r;

        this.vel[i3] = (Math.random() - 0.5) * 0.012;
        this.vel[i3 + 1] = 0.015 + Math.random() * 0.028;
        this.vel[i3 + 2] = (Math.random() - 0.5) * 0.012;

        this.life[i] = init ? Math.random() : 1;
        this.sizes[i] = 0.9 + Math.random() * 1.2;

        const warm = Math.random() < 0.82;
        const c = warm ? MathUtils.hsl(36 + Math.random() * 8, 0.72, 0.55) : MathUtils.hsl(208, 0.55, 0.35);
        this.colors[i3] = c.r;
        this.colors[i3 + 1] = c.g;
        this.colors[i3 + 2] = c.b;
    }

    update(audio, dt) {
        const loud = audio.smoothed.loudNorm;
        const onset = audio.smoothed.onset;

        const spawnRate = 0.001 + loud * 0.007 + onset * 0.018;
        for (let i = 0; i < this.count; i++) {
            const i3 = i * 3;
            this.life[i] -= dt * (0.36 + loud * 0.45);

            this.positions[i3] += this.vel[i3] * (0.7 + loud * 1.2);
            this.positions[i3 + 1] += this.vel[i3 + 1] * (0.9 + loud * 1.6);
            this.positions[i3 + 2] += this.vel[i3 + 2] * (0.7 + loud * 1.2);

            this.sizes[i] = Math.max(0.1, this.sizes[i] * 0.995);

            if (this.life[i] <= 0 || this.positions[i3 + 1] > 4.7 || Math.random() < spawnRate * dt * 60) {
                this.reset(i, false, onset * 0.35);
            }
        }

        this.points.geometry.attributes.position.needsUpdate = true;
        this.points.geometry.attributes.size.needsUpdate = true;
    }
}

class GroundLayer {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);

        // Visual budget: subtle aperture rings anchoring the beam.
        const g = new THREE.CircleGeometry(3.6, 96);
        g.rotateX(-Math.PI / 2);
        this.mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            uniforms: {
                uTime: { value: 0 },
                uPulse: { value: 0 }
            },
            vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
            fragmentShader: `
                uniform float uTime;
                uniform float uPulse;
                varying vec3 vP;
                void main(){
                    float d = length(vP.xz);
                    float core = 1.0 - smoothstep(0.0, 0.9, d);
                    float ring1 = smoothstep(0.45,0.42,abs(d - (0.6 + sin(uTime*0.3)*0.02)));
                    float ring2 = smoothstep(0.72,0.69,abs(d - (1.1 + sin(uTime*0.22)*0.03)));
                    float ring3 = smoothstep(0.96,0.93,abs(d - (1.7 + sin(uTime*0.2)*0.03)));
                    float rings = (ring1 * 0.9 + ring2 * 0.6 + ring3 * 0.4) * (0.14 + uPulse * 0.45);
                    vec3 warm = vec3(0.95, 0.70, 0.42);
                    vec3 cool = vec3(0.22, 0.36, 0.55);
                    vec3 col = mix(cool, warm, core * 0.65 + rings * 0.4);
                    float alpha = core * (0.022 + uPulse * 0.05) + rings * 0.1;
                    gl_FragColor = vec4(col, alpha);
                }
            `
        });

        this.mesh = new THREE.Mesh(g, this.mat);
        this.mesh.position.y = -0.02;
        this.group.add(this.mesh);
    }

    update(audio, t) {
        this.mat.uniforms.uTime.value = t;
        this.mat.uniforms.uPulse.value = audio.smoothed.loudNorm * 0.75 + audio.smoothed.onset * 0.8;
    }
}

class AtmosphereLayer {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);

        // Visual budget: very low-density depth, no nebula clutter.
        const plane = new THREE.PlaneGeometry(14, 8);
        this.mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: { uTime: { value: 0 }, uGlow: { value: 0.12 } },
            vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform float uTime;
                uniform float uGlow;
                void main(){
                    vec2 uv = vUv - 0.5;
                    float vignette = 1.0 - smoothstep(0.08, 0.75, length(uv));
                    float haze = (0.18 + sin(uTime*0.08 + uv.y*4.0) * 0.03) * vignette;
                    vec3 col = mix(vec3(0.01,0.015,0.02), vec3(0.04,0.06,0.09), uv.y + 0.5);
                    gl_FragColor = vec4(col * uGlow, haze * 0.08 * uGlow);
                }
            `
        });
        this.backdrop = new THREE.Mesh(plane, this.mat);
        this.backdrop.position.set(0, 2.2, -4.8);
        this.group.add(this.backdrop);
    }

    update(audio, t) {
        this.mat.uniforms.uTime.value = t;
        this.mat.uniforms.uGlow.value = 0.08 + audio.smoothed.loudNorm * 0.08;
    }
}

class VisualizerEngine {
    constructor(canvasId, audioManager) {
        this.audio = audioManager;
        this.canvas = document.getElementById(canvasId);

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 0.92;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x010102);
        this.scene.fog = new THREE.FogExp2(0x010102, 0.0065);

        this.camera = new THREE.PerspectiveCamera(33, window.innerWidth / window.innerHeight, 0.1, 60);
        this.camera.position.set(0.18, 1.95, 5.8);
        this.camera.lookAt(0, 2.0, 0);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 2.0, 0);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.04;
        this.controls.enablePan = false;
        this.controls.enableRotate = false;
        this.controls.enableZoom = false;

        this.composer = new THREE.EffectComposer(this.renderer);
        this.composer.addPass(new THREE.RenderPass(this.scene, this.camera));
        this.bloom = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.28, 0.24, 0.84);
        this.composer.addPass(this.bloom);

        this.buildScene();
        this.bindEvents();

        this.lastTime = performance.now();
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    buildScene() {
        const ambient = new THREE.AmbientLight(0x0b0d12, 0.12);
        const rim = new THREE.DirectionalLight(0x2a3d66, 0.08);
        rim.position.set(-1.5, 2.8, -2.5);
        this.scene.add(ambient, rim);

        this.layers = {
            atmosphere: new AtmosphereLayer(this.scene),
            ground: new GroundLayer(this.scene),
            beam: new BeamLayer(this.scene),
            helix: new HelixLayer(this.scene),
            sparks: new SparkLayer(this.scene)
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
        this.updateScene(now * 0.001, dt);

        // Cinematic near-lock with subtle drift.
        const t = now * 0.00004;
        this.camera.position.x = MathUtils.lerp(this.camera.position.x, 0.18 + Math.sin(t) * 0.012, 0.008);
        this.camera.position.y = MathUtils.lerp(this.camera.position.y, 1.95 + Math.cos(t * 0.9) * 0.01, 0.008);
        this.controls.update();

        this.composer.render();
    }

    updateScene(t, dt) {
        this.layers.atmosphere.update(this.audio, t);
        this.layers.ground.update(this.audio, t);
        this.layers.beam.update(this.audio, t);
        this.layers.helix.update(this.audio, t);
        this.layers.sparks.update(this.audio, dt);

        // Bloom supports the beam and avoids washing the full frame.
        const loud = this.audio.smoothed.loudNorm;
        const onset = this.audio.smoothed.onset;
        this.bloom.strength = MathUtils.lerp(this.bloom.strength, 0.18 + loud * 0.16 + onset * 0.08, 0.08);
        this.bloom.radius = MathUtils.lerp(this.bloom.radius, 0.2 + loud * 0.06, 0.08);
        this.bloom.threshold = MathUtils.lerp(this.bloom.threshold, 0.86 - onset * 0.04, 0.08);
    }
}

window.VisualizerEngine = VisualizerEngine;
