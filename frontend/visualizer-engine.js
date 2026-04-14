/**
 * ARTISTIC VOICE VISUALIZER ENGINE
 * Fixed: Removed "flower" distortion and vertical line.
 * Behavior: Clean circular rings and orbiting particles that follow Pitch (Y).
 */

const VISUAL_SCENE_CONFIG = {
    backgroundTop: 0x050a14,
    backgroundBottom: 0x010307,
    backgroundHaze: 0x14273e,
    cameraDistance: 11.5,
    cameraFOV: 44,
    particles: { count: 800, size: 0.035, orbitSpeed: 1.5 }
};

class BackgroundSystem {
    constructor(scene) {
        const geo = new THREE.SphereGeometry(48, 32, 32);
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            uniforms: {
                uTop: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundTop) },
                uBottom: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundBottom) },
                uHaze: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundHaze) }
            },
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
                angle: Math.random() * Math.PI * 2,
                speed: 0.6 + Math.random() * 0.8,
                radiusOffset: (Math.random() - 0.5) * 0.4, // Tight dispersion
                pos: new THREE.Vector3(),
                color: new THREE.Color()
            });
        }
    }

    update(dt, time, ringY, ringCol, flash = 0) {
        const pAttr = this.points.geometry.attributes.position.array;
        const cAttr = this.points.geometry.attributes.color.array;
        const rBase = this.getRadius();

        this.particles.forEach((p, i) => {
            p.angle += dt * p.speed * VISUAL_SCENE_CONFIG.particles.orbitSpeed;

            // Fixed: Radial logic is now a clean circle (no flower distortion)
            let r = rBase + p.radiusOffset;

            // Subtle vertical oscillation for depth
            const yDrift = Math.sin(p.angle * 2.0 + time) * 0.1;

            p.pos.set(
                Math.cos(p.angle) * r,
                ringY + yDrift,
                Math.sin(p.angle) * r
            );

            const intensity = 0.5 + flash * 2.0;
            p.color.lerp(ringCol, 0.1);

            const idx = i * 3;
            cAttr[idx]     = p.color.r * intensity;
            cAttr[idx + 1] = p.color.g * intensity;
            cAttr[idx + 2] = p.color.b * intensity;
            pAttr[idx]     = p.pos.x;
            pAttr[idx + 1] = p.pos.y;
            pAttr[idx + 2] = p.pos.z;
        });

        this.points.geometry.attributes.position.needsUpdate = true;
        this.points.geometry.attributes.color.needsUpdate = true;
    }
}

class DualRingSystem {
    constructor(scene) {
        const ringShaderMat = (thickness) => new THREE.ShaderMaterial({
            transparent: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: {
                uColor:     { value: new THREE.Color() },
                uRadius:    { value: 1.0 },
                uThickness: { value: thickness },
                uOpacity:   { value: 0.5 },
                uTime:      { value: 0 },
                uFlash:     { value: 0 }
            },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uColor;
                uniform float uRadius;
                uniform float uThickness;
                uniform float uOpacity;
                uniform float uTime;
                uniform float uFlash;

                void main() {
                    vec2 uv = vUv * 2.0 - 1.0;
                    float dist = length(uv) * 4.0;
                    float ringDist = abs(dist - uRadius);

                    // Fixed: Clean circular profile
                    float glow = exp(-pow(ringDist / (uThickness + uFlash * 0.3), 2.0));
                    float core = exp(-pow(ringDist / (uThickness * 0.3), 2.0));

                    float finalAlpha = (glow * 0.8 + core * 0.2);
                    gl_FragColor = vec4(mix(uColor, vec3(1.0), uFlash * 0.4), finalAlpha * uOpacity);
                }`
        });

        this.innerMat = ringShaderMat(0.04);
        this.innerRing = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), this.innerMat);
        this.innerRing.rotation.x = -Math.PI / 2;
        scene.add(this.innerRing);

        this.displayY = 0.0;
        this.ringState = { innerRadius: 1.0, innerColor: new THREE.Color() };
        this.particles = new ParticleSystem(scene, () => this.ringState.innerRadius);
    }

    update(time, liveState, dt) {
        const voiced = liveState?.active || false;
        const flash = liveState?.transient || 0;

        if (voiced) {
            this.displayY = MathUtils.lerp(this.displayY, liveState.y, 0.15);
        } else {
            this.displayY = MathUtils.lerp(this.displayY, Math.sin(time * 1.2) * 0.3, 0.08);
        }

        const hue = (liveState?.pitchNorm ?? 0.5) * 0.7;
        this.ringState.innerColor.lerp(new THREE.Color().setHSL(hue, 0.9, 0.5), 0.1);

        const targetRadius = voiced ? 0.9 + liveState.loudNorm * 1.8 : 0.85;
        this.ringState.innerRadius = MathUtils.lerp(this.ringState.innerRadius, targetRadius, 0.1);

        this.innerMat.uniforms.uColor.value = this.ringState.innerColor;
        this.innerMat.uniforms.uRadius.value = this.ringState.innerRadius;
        this.innerMat.uniforms.uTime.value = time;
        this.innerMat.uniforms.uFlash.value = flash;
        this.innerMat.uniforms.uOpacity.value = voiced ? 0.85 : 0.3;
        this.innerRing.position.y = this.displayY;

        this.particles.update(dt, time, this.displayY, this.ringState.innerColor, flash);
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
        this.camera.position.set(0, 1.5, VISUAL_SCENE_CONFIG.cameraDistance);
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.clock = new THREE.Clock();
        this.systems = { bg: new BackgroundSystem(this.scene), rings: new DualRingSystem(this.scene) };
        this.animate();
    }
    renderFrame() {
        const dt = Math.min(this.clock.getDelta(), 0.033);
        if (this.controls) this.controls.update();
        this.audio.updateTime(dt);
        const sm = this.audio.smoothed;
        const liveState = {
            active: sm.pitch > 40,
            y: -4.0 + sm.pitchNorm * 8.0,
            pitchNorm: sm.pitchNorm,
            loudNorm: sm.loudNorm,
            transient: this.audio.transientFlash
        };
        this.systems.rings.update(this.clock.elapsedTime, liveState, dt);
        this.renderer.render(this.scene, this.camera);
    }
    animate() { this.renderFrame(); requestAnimationFrame(() => this.animate()); }
}