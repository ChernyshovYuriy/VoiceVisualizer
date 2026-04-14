const VISUAL_SCENE_CONFIG = {
    backgroundTop: 0x050a14,
    backgroundBottom: 0x010307,
    backgroundHaze: 0x14273e,
    cameraDistance: 10.5,
    cameraFOV: 44,
    particles: { count: 450, size: 0.045, orbitSpeed: 1.2 }   // increased for richer feel
};

class BackgroundSystem {
    constructor(scene) {
        const geo = new THREE.SphereGeometry(48, 32, 32);
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            uniforms: { uTop: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundTop) }, uBottom: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundBottom) }, uHaze: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundHaze) } },
            vertexShader: `varying vec3 vWorldPos; void main() { vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `varying vec3 vWorldPos; uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uHaze;
                void main() {
                    float h = clamp((vWorldPos.y + 8.0) / 18.0, 0.0, 1.0);
                    vec3 col = mix(uBottom, uTop, smoothstep(0.05, 0.95, h));
                    float centerGlow = exp(-pow(vWorldPos.y * 0.12, 2.0)) * exp(-pow(vWorldPos.x * 0.06, 2.0));
                    gl_FragColor = vec4(mix(col, uHaze, centerGlow * 0.45), 1.0);
                }`
        });
        scene.add(new THREE.Mesh(geo, mat));
    }
}

class ParticleSystem {
    constructor(scene, getRadius) {
        this.getRadius = getRadius;
        this.particles = [];
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(VISUAL_SCENE_CONFIG.particles.count * 3);
        const col = new Float32Array(VISUAL_SCENE_CONFIG.particles.count * 3);
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        this.points = new THREE.Points(geo, new THREE.PointsMaterial({
            size: VISUAL_SCENE_CONFIG.particles.size,
            vertexColors: true,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthTest: false
        }));
        scene.add(this.points);
        for (let i = 0; i < VISUAL_SCENE_CONFIG.particles.count; i++) {
            this.particles.push({
                angle: Math.random() * 6.28,
                speed: 0.5 + Math.random() * 1.2,
                pos: new THREE.Vector3(),
                color: new THREE.Color()
            });
        }
    }

    update(dt, ringY, ringCol, flash = 0) {
        const pAttr = this.points.geometry.attributes.position.array;
        const cAttr = this.points.geometry.attributes.color.array;
        const rBase = this.getRadius();

        this.particles.forEach((p, i) => {
            p.angle += dt * p.speed * VISUAL_SCENE_CONFIG.particles.orbitSpeed;

            let r = rBase * (1.1 + Math.sin(p.angle * 0.5) * 0.2);

            // Flash = outward radial burst
            if (flash > 0.1) {
                r += flash * 1.8 * (1 + Math.sin(p.angle * 12));
            }

            p.pos.set(
                Math.cos(p.angle) * r,
                ringY + Math.cos(p.angle * 2) * 0.1,
                Math.sin(p.angle) * r
            );

            const intensity = 0.4 + flash * 1.6;
            p.color.lerp(ringCol, 0.15);

            cAttr[i * 3]     = p.color.r * intensity;
            cAttr[i * 3 + 1] = p.color.g * intensity;
            cAttr[i * 3 + 2] = p.color.b * intensity;
        });

        this.points.geometry.attributes.position.needsUpdate = true;
        this.points.geometry.attributes.color.needsUpdate = true;
    }
}

class DualRingSystem {
    constructor(scene) {
        const ringMat = (thick) => new THREE.ShaderMaterial({
            transparent: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: {
                uColor:     { value: new THREE.Color() },
                uRadius:    { value: 1.0 },
                uThickness: { value: thick },
                uOpacity:   { value: 0.5 },
                uTime:      { value: 0 },
                uFlash:     { value: 0 }
            },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `varying vec2 vUv;
                uniform vec3 uColor;
                uniform float uRadius;
                uniform float uThickness;
                uniform float uOpacity;
                uniform float uTime;
                uniform float uFlash;
                void main() {
                    float r = length(vUv * 2.0 - 1.0) * 4.0;
                    float dist = abs(r - uRadius);

                    // breathing + flash pulse
                    float pulse = sin(uTime * 8.0) * 0.03 + uFlash * 1.5;
                    float profile = exp(-pow(dist / (uThickness + pulse), 2.0));

                    // living edge wave
                    float angle = atan(vUv.y - 0.5, vUv.x - 0.5);
                    profile *= 0.9 + 0.1 * sin(angle * 24.0 + uTime * 12.0);

                    gl_FragColor = vec4(uColor, profile * uOpacity);
                }`
        });

        // INNER RING (pitch / note)
        this.innerMat = ringMat(0.035);
        this.innerRing = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), this.innerMat);
        this.innerRing.rotation.x = -Math.PI / 2;
        scene.add(this.innerRing);

        // OUTER RING (energy / loudness)
        this.outerMat = ringMat(0.055);
        this.outerRing = new THREE.Mesh(new THREE.PlaneGeometry(9.5, 9.5), this.outerMat);
        this.outerRing.rotation.x = -Math.PI / 2;
        scene.add(this.outerRing);

        // CENTRAL GLOW (premium anchor)
        const glowGeo = new THREE.SphereGeometry(0.35, 24, 24);
        const glowMat = new THREE.MeshBasicMaterial({
            color: 0x88ccff,
            transparent: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        this.centralGlow = new THREE.Mesh(glowGeo, glowMat);
        scene.add(this.centralGlow);

        this.displayY = 0.0;
        this.smState = 'IDLE';

        this.ringState = { innerRadius: 1.0, innerColor: new THREE.Color() };
        this.outerState = { radius: 1.8, color: new THREE.Color(0x4488ff) };

        this.particles = new ParticleSystem(scene, () => this.ringState.innerRadius);
    }

    update(time, liveState, dt) {
        const voiced = liveState?.active || false;
        const flash = liveState?.transient || 0;

        // Position + state
        if (voiced) {
            this.displayY = MathUtils.lerp(this.displayY, liveState.y, 0.15);
            this.smState = 'TRACKING';
        } else {
            this.smState = 'IDLE';
            // gentle idle breathing
            this.displayY = MathUtils.lerp(this.displayY, Math.sin(time * 1.2) * 0.3, 0.08);
        }

        // INNER RING (pitch-driven)
        const hue = (liveState?.pitchNorm ?? 0.5) * 0.65;
        this.ringState.innerColor.lerp(new THREE.Color().setHSL(hue, 0.9, 0.5), 0.1);
        this.ringState.innerRadius = MathUtils.lerp(
            this.ringState.innerRadius,
            voiced ? 1.0 + liveState.loudNorm * 0.6 : 0.85,
            0.1
        );

        this.innerMat.uniforms.uColor.value = this.ringState.innerColor;
        this.innerMat.uniforms.uRadius.value = this.ringState.innerRadius;
        this.innerMat.uniforms.uOpacity.value = voiced ? 0.9 : 0.25;
        this.innerMat.uniforms.uTime.value = time;
        this.innerMat.uniforms.uFlash.value = flash;

        if (voiced) this.innerRing.rotation.z += dt * 0.15;   // subtle spin
        this.innerRing.position.y = this.displayY;

        // OUTER RING (energy + flash)
        this.outerState.radius = MathUtils.lerp(
            this.outerState.radius,
            voiced ? 1.6 + liveState.loudNorm * 1.1 : 1.4,
            0.12
        );
        const flashBoost = 1 + flash * 3.5;
        this.outerMat.uniforms.uRadius.value = this.outerState.radius * flashBoost;
        this.outerMat.uniforms.uOpacity.value = voiced ? 0.35 + flash * 0.8 : 0.12;
        this.outerState.color.lerp(new THREE.Color().setHSL(0.55, 0.85, 0.55), 0.1);
        this.outerMat.uniforms.uColor.value = this.outerState.color;
        this.outerMat.uniforms.uTime.value = time;
        this.outerMat.uniforms.uFlash.value = flash;

        if (voiced) this.outerRing.rotation.z -= dt * 0.08;   // opposite spin
        this.outerRing.position.y = this.displayY;

        // Particles
        this.particles.update(dt, this.displayY, this.ringState.innerColor, flash);

        // Central glow
        const glowScale = 0.8 + (voiced ? liveState.loudNorm * 1.1 : 0.2) + flash * 1.4;
        this.centralGlow.scale.setScalar(glowScale);
        this.centralGlow.position.set(0, this.displayY, 0);
        this.centralGlow.material.color.copy(this.ringState.innerColor).multiplyScalar(1.6);
        this.centralGlow.material.opacity = voiced ? Math.max(0.4, 0.6 + liveState.loudNorm * 0.6) : 0.25;
    }
}

class VisualizerEngine {
    constructor(canvasId, audioManager) {
        this.audio = audioManager;
        this.canvas = document.getElementById(canvasId);
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(VISUAL_SCENE_CONFIG.cameraFOV, window.innerWidth / window.innerHeight, 0.1, 100);
        this.camera.position.set(0, 1.2, VISUAL_SCENE_CONFIG.cameraDistance);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;

        this.clock = new THREE.Clock();

        this.systems = {
            bg: new BackgroundSystem(this.scene),
            rings: new DualRingSystem(this.scene)
        };

        this.animate();
    }

    renderFrame() {
        const dt = Math.min(this.clock.getDelta(), 0.033);
        if (this.controls) this.controls.update();

        // IMPORTANT: decay transients every frame
        this.audio.updateTime(dt);

        const sm = this.audio.smoothed;
        const flash = this.audio.transientFlash;

        const liveState = {
            active: sm.pitch > 40,
            y: -4.0 + sm.pitchNorm * 8.0,
            pitchNorm: sm.pitchNorm,
            loudNorm: sm.loudNorm,
            transient: flash,
            pitchConf: sm.pitchConf
        };

        this.systems.rings.update(this.clock.elapsedTime, liveState, dt);
        this.renderer.render(this.scene, this.camera);
    }

    animate() {
        this.renderFrame();
        requestAnimationFrame(() => this.animate());
    }
}