const VISUAL_SCENE_CONFIG = {
    backgroundTop: 0x050a14,
    backgroundBottom: 0x010307,
    backgroundHaze: 0x14273e,
    cameraDistance: 10.5,
    cameraFOV: 44,
    particles: { count: 300, size: 0.045, orbitSpeed: 1.2 }
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
        this.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.04, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending }));
        scene.add(this.points);
        for (let i = 0; i < VISUAL_SCENE_CONFIG.particles.count; i++) {
            this.particles.push({ active: true, angle: Math.random() * 6.28, speed: 0.5 + Math.random(), pos: new THREE.Vector3(), color: new THREE.Color() });
        }
    }
    update(dt, ringY, ringCol) {
        const pAttr = this.points.geometry.attributes.position.array;
        const cAttr = this.points.geometry.attributes.color.array;
        const rBase = this.getRadius();
        this.particles.forEach((p, i) => {
            p.angle += dt * p.speed * VISUAL_SCENE_CONFIG.particles.orbitSpeed;
            const r = rBase * (1.1 + Math.sin(p.angle * 0.5) * 0.2);
            p.pos.set(Math.cos(p.angle)*r, ringY + Math.cos(p.angle*2)*0.1, Math.sin(p.angle)*r);
            p.color.lerp(ringCol, 0.1);
            pAttr[i*3] = p.pos.x; pAttr[i*3+1] = p.pos.y; pAttr[i*3+2] = p.pos.z;
            cAttr[i*3] = p.color.r * 0.4; cAttr[i*3+1] = p.color.g * 0.4; cAttr[i*3+2] = p.color.b * 0.4;
        });
        this.points.geometry.attributes.position.needsUpdate = true;
        this.points.geometry.attributes.color.needsUpdate = true;
    }
}

class DualRingSystem {
    constructor(scene) {
        const ringMat = (thick) => new THREE.ShaderMaterial({
            transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
            uniforms: { uColor: { value: new THREE.Color() }, uRadius: { value: 1.0 }, uThickness: { value: thick }, uOpacity: { value: 0.5 } },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `varying vec2 vUv; uniform vec3 uColor; uniform float uRadius; uniform float uThickness; uniform float uOpacity;
                void main() {
                    float r = length(vUv * 2.0 - 1.0) * 4.0;
                    float dist = abs(r - uRadius);
                    float profile = exp(-pow(dist / uThickness, 2.0));
                    gl_FragColor = vec4(uColor, profile * uOpacity);
                }`
        });
        this.innerMat = ringMat(0.035);
        this.innerRing = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), this.innerMat);
        this.innerRing.rotation.x = -Math.PI/2;
        scene.add(this.innerRing);
        this.displayY = 0.0;
        this.smState = 'IDLE';
        this.ringState = { innerRadius: 1.0, innerColor: new THREE.Color() };
        this.particles = new ParticleSystem(scene, () => this.ringState.innerRadius);
    }
    update(time, liveState, dt) {
        const voiced = liveState?.active || false;
        if (voiced) { this.displayY = MathUtils.lerp(this.displayY, liveState.y, 0.15); this.smState = 'TRACKING'; }
        else { this.smState = 'IDLE'; }
        const hue = (liveState?.pitchNorm ?? 0.5) * 0.65;
        this.ringState.innerColor.lerp(new THREE.Color().setHSL(hue, 0.9, 0.5), 0.1);
        this.ringState.innerRadius = MathUtils.lerp(this.ringState.innerRadius, voiced ? 1.0 + liveState.loudNorm * 0.6 : 0.85, 0.1);
        this.innerMat.uniforms.uColor.value = this.ringState.innerColor;
        this.innerMat.uniforms.uRadius.value = this.ringState.innerRadius;
        this.innerMat.uniforms.uOpacity.value = voiced ? 0.9 : 0.25;
        this.innerRing.position.y = this.displayY;
        this.particles.update(dt, this.displayY, this.ringState.innerColor);
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
        
        // --- Navigation Restore ---
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
        const raw = this.audio?.state || null;
        const rawLoudNorm = MathUtils.clamp(((raw?.loudness ?? -80) + 60) / 40, 0, 1);
        const rawPitchNorm = (raw?.pitch > 40) ? MathUtils.clamp((Math.log(raw.pitch) - Math.log(80)) / (Math.log(1200) - Math.log(80)), 0, 1) : -1;
        const liveState = { active: rawPitchNorm >= 0, y: -4.0 + rawPitchNorm * 8.0, pitchNorm: rawPitchNorm, loudNorm: rawLoudNorm };
        this.systems.rings.update(this.clock.elapsedTime, liveState, dt);
        this.renderer.render(this.scene, this.camera);
    }
    animate() { this.renderFrame(); requestAnimationFrame(() => this.animate()); }
}