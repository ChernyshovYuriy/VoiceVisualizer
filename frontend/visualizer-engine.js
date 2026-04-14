// FULL RESTORED ENGINE: Sticky Logic + Spectral Colors + Orbiting Particles + Dual Rings
// Optimized for visualizer.html hooks

const VISUAL_SCENE_CONFIG = {
    backgroundTop: 0x050a14,
    backgroundBottom: 0x010307,
    backgroundHaze: 0x14273e,
    bandOpacity: 0.24,
    cameraDistance: 10.5, // Zoomed in closer
    cameraFOV: 44,

    innerRing: {
        minRadius: 0.55, maxRadius: 1.3,
        minOpacity: 0.6, maxOpacity: 0.98,
        thickness: 0.03, glowIntensity: 1.5,
        colorHueMin: 0.0, colorHueMax: 0.65 // Red to Blue
    },
    outerRing: {
        minRadius: 0.9, maxRadius: 1.8,
        minOpacity: 0.2, maxOpacity: 0.45,
        thickness: 0.015, glowIntensity: 1.0
    },
    particles: {
        count: 300,
        size: 0.045,
        orbitSpeed: 1.2
    },
    pitchFilterEmaSpeed: 18.0,
    pitchTargetEmaSpeed: 15.0
};

class BackgroundSystem {
    constructor(scene) {
        const geo = new THREE.SphereGeometry(48, 32, 32);
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            uniforms: {
                uTop: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundTop) },
                uBottom: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundBottom) },
                uHaze: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundHaze) },
                uTime: { value: 0 }
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
        this.material = mat;
    }
    update(t) { this.material.uniforms.uTime.value = t; }
}

class AxisSystem {
    constructor(scene) {
        const mat = new THREE.ShaderMaterial({
            transparent: true, blending: THREE.AdditiveBlending,
            uniforms: { uColor: { value: new THREE.Color(0x224466) } },
            vertexShader: `varying vec3 vPos; void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `varying vec3 vPos; void main() { float r = length(vPos.xz); float glow = exp(-pow(r * 25.0, 2.0)); gl_FragColor = vec4(vec3(0.4, 0.6, 1.0), glow * 0.15); }`
        });
        scene.add(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 12, 16), mat));
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
            this.particles.push({ active: false, life: 0, angle: Math.random() * 6.28, speed: 0.5 + Math.random(), pos: new THREE.Vector3(), vel: new THREE.Vector3(), color: new THREE.Color(), mode: 'orbit' });
        }
    }
    burst(pos, col) {
        let count = 0;
        for (const p of this.particles) {
            if (!p.active || p.mode === 'orbit') {
                p.active = true; p.life = 1.0; p.mode = 'burst'; p.pos.copy(pos);
                const a = Math.random() * 6.28; const s = 0.8 + Math.random();
                p.vel.set(Math.cos(a)*s, (Math.random()-0.5)*1.2, Math.sin(a)*s);
                p.color.copy(col);
                if (++count > 20) break;
            }
        }
    }
    update(dt, ringY, ringCol) {
        const pAttr = this.points.geometry.attributes.position.array;
        const cAttr = this.points.geometry.attributes.color.array;
        const rBase = this.getRadius();
        this.particles.forEach((p, i) => {
            if (p.mode === 'orbit') {
                p.angle += dt * p.speed * VISUAL_SCENE_CONFIG.particles.orbitSpeed;
                const r = rBase * (1.1 + Math.sin(p.angle * 0.5) * 0.2);
                p.pos.set(Math.cos(p.angle)*r, ringY + Math.cos(p.angle*2)*0.1, Math.sin(p.angle)*r);
                p.color.lerp(ringCol, 0.1);
                p.active = true; p.life = 0.6;
            } else if (p.active) {
                p.life -= dt * 1.2; p.pos.addScaledVector(p.vel, dt); p.vel.y -= dt * 0.4;
                if (p.life <= 0) p.mode = 'orbit';
            }
            pAttr[i*3] = p.pos.x; pAttr[i*3+1] = p.pos.y; pAttr[i*3+2] = p.pos.z;
            const alpha = p.mode === 'orbit' ? 0.4 : p.life;
            cAttr[i*3] = p.color.r * alpha; cAttr[i*3+1] = p.color.g * alpha; cAttr[i*3+2] = p.color.b * alpha;
        });
        this.points.geometry.attributes.position.needsUpdate = true;
        this.points.geometry.attributes.color.needsUpdate = true;
    }
}

class DualRingSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);
        const ringMat = (thick) => new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
            uniforms: { uColor: { value: new THREE.Color() }, uRadius: { value: 1.0 }, uThickness: { value: thick }, uOpacity: { value: 0.5 } },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `varying vec2 vUv; uniform vec3 uColor; uniform float uRadius; uniform float uThickness; uniform float uOpacity;
                void main() {
                    float r = length(vUv * 2.0 - 1.0) * 4.0;
                    float dist = abs(r - uRadius);
                    float profile = exp(-pow(dist / uThickness, 2.0));
                    float glow = exp(-pow(dist / (uThickness * 8.0), 2.0)) * 0.4;
                    gl_FragColor = vec4(uColor, (profile + glow) * uOpacity);
                }`
        });

        this.innerMat = ringMat(0.035);
        this.innerRing = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), this.innerMat);
        this.innerRing.rotation.x = -Math.PI/2;
        this.group.add(this.innerRing);

        this.outerMat = ringMat(0.018);
        this.outerRing = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), this.outerMat);
        this.outerRing.rotation.x = -Math.PI/2;
        this.group.add(this.outerRing);

        this.displayY = 0.0;
        this.lastKnownGoodY = 0.0;
        this.smState = 'IDLE';
        this.ringState = { innerRadius: 1.0, innerColor: new THREE.Color() };
        this.pitchFilterY = 0.0;
        this.particles = new ParticleSystem(scene, () => this.ringState.innerRadius);
    }

    update(time, liveState, dt) {
        const voiced = liveState?.active || false;
        const confidence = liveState?.pitchConf ?? 0;
        const rawY = voiced ? liveState.y : this.displayY;

        this.pitchFilterY += (rawY - this.pitchFilterY) * (1 - Math.exp(-18.0 * dt));

        if (voiced && confidence > 0.15) {
            this.lastKnownGoodY = this.pitchFilterY;
            this.smState = 'TRACKING';
        } else if (!voiced) {
            this.smState = 'IDLE';
        }

        this.displayY = (this.smState === 'TRACKING') ?
            MathUtils.lerp(this.displayY, this.pitchFilterY, 1 - Math.exp(-15.0 * dt)) :
            this.lastKnownGoodY;

        const hue = (liveState?.pitchNorm ?? 0.5) * 0.65;
        this.ringState.innerColor.lerp(new THREE.Color().setHSL(hue, 0.9, 0.5), 0.1);
        this.ringState.innerRadius = MathUtils.lerp(this.ringState.innerRadius, voiced ? 1.0 + liveState.loudNorm * 0.6 : 0.85, 0.1);

        this.innerMat.uniforms.uColor.value = this.ringState.innerColor;
        this.innerMat.uniforms.uRadius.value = this.ringState.innerRadius;
        this.innerMat.uniforms.uOpacity.value = voiced ? 0.9 : 0.25;
        this.innerRing.position.y = this.displayY;

        this.outerMat.uniforms.uColor.value = this.ringState.innerColor;
        this.outerMat.uniforms.uRadius.value = this.ringState.innerRadius * 1.35;
        this.outerMat.uniforms.uOpacity.value = voiced ? 0.35 : 0.1;
        this.outerRing.position.y = this.displayY - 0.06;

        if (voiced && liveState.onset > 0.6) this.particles.burst(new THREE.Vector3(0, this.displayY, 0), this.ringState.innerColor);
        this.particles.update(dt, this.displayY, this.ringState.innerColor);
    }

    mapLiveRingState(audioState) {
        if (!audioState || audioState.rawPitchConf < 0.05 || audioState.rawPitchNorm < 0) return { active: false };
        return { active: true, y: -4.0 + audioState.rawPitchNorm * 8.0, pitchNorm: audioState.rawPitchNorm, loudNorm: audioState.rawLoudNorm, pitchConf: audioState.rawPitchConf, onset: audioState.onset };
    }
}

class PitchBandSystem {
    constructor(scene) {
        const count = 9; const centers = []; const colors = [];
        for (let i = 0; i < count; i++) {
            const t = i / (count - 1);
            const col = new THREE.Color().setHSL(t * 0.65, 0.8, 0.3);
            centers.push(-4.5 + i * 1.125);
            colors.push(new THREE.Vector3(col.r, col.g, col.b));
        }
        const mat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
            uniforms: { uCenters: { value: centers }, uColors: { value: colors } },
            vertexShader: `varying vec3 vWorldPos; void main() { vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`,
            fragmentShader: `varying vec3 vWorldPos; uniform float uCenters[9]; uniform vec3 uColors[9];
                void main() {
                    vec3 colAcc = vec3(0.0); float wAcc = 0.0;
                    for(int i=0; i<9; i++) { float layer = exp(-pow(vWorldPos.y - uCenters[i], 2.0)/1.5); colAcc += uColors[i]*layer; wAcc += layer; }
                    gl_FragColor = vec4(colAcc/max(wAcc,0.1), (wAcc/9.0)*0.18*exp(-pow(vWorldPos.x*0.1,2.0)));
                }`
        });
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(40, 20), mat);
        plane.position.z = -5;
        scene.add(plane);
    }
}

class VisualizerEngine {
    constructor(canvasId, audioManager) {
        this.audio = audioManager;
        this.canvas = document.getElementById(canvasId);
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(VISUAL_SCENE_CONFIG.cameraFOV, window.innerWidth / window.innerHeight, 0.1, 100);
        this.camera.position.set(0, 1.2, VISUAL_SCENE_CONFIG.cameraDistance);
        this.camera.lookAt(0, 0, 0);
        this.clock = new THREE.Clock();

        this.systems = {
            bg: new BackgroundSystem(this.scene),
            bands: new PitchBandSystem(this.scene),
            axis: new AxisSystem(this.scene),
            rings: new DualRingSystem(this.scene)
        };
        this.animate();
    }

    renderFrame() {
        const dt = Math.min(this.clock.getDelta(), 0.033);
        const raw = this.audio?.state || null;
        const rawLoudNorm = MathUtils.clamp(((raw?.loudness ?? -80) + 60) / 40, 0, 1);
        const rawPitchNorm = (raw?.pitch > 40) ? MathUtils.clamp((Math.log(raw.pitch) - Math.log(80)) / (Math.log(1200) - Math.log(80)), 0, 1) : -1;
        const liveState = this.systems.rings.mapLiveRingState({ rawPitchNorm, rawLoudNorm, rawPitchConf: raw?.pitchConf ?? 0, onset: this.audio?.smoothed?.onset ?? 0 });

        this.systems.rings.update(this.clock.elapsedTime, liveState, dt);
        this.systems.bg.update(this.clock.elapsedTime);
        this.renderer.render(this.scene, this.camera);
    }

    animate() {
        this.renderFrame();
        requestAnimationFrame(() => this.animate());
    }
}

window.VisualizerEngine = VisualizerEngine;