// Enhanced visualizer engine — fast, responsive dual‑ring + particles, no cropping.
// Relies on globals: THREE, MathUtils (provided by HTML).

const DEBUG_VIEW = (() => {
    try {
        const params = new URLSearchParams(window.location.search);
        const debugFlag = params.get('debug3d') ?? params.get('debug');
        return debugFlag === '1' || debugFlag === 'true' || debugFlag === 'on';
    } catch (_err) {
        return false;
    }
})();

const VISUAL_SCENE_CONFIG = {
    DEBUG_VIEW,
    backgroundTop: 0x050a14,
    backgroundBottom: 0x010307,
    backgroundHaze: 0x14273e,
    bandOpacity: 0.24,
    bandSoftness: 1.6,
    axisOpacity: 0.12,
    axisHeight: 12.0, // Expanded to match new vertical range
    // Camera settings — pulled back to show massive vertical movement
    cameraDistance: 16.5,
    cameraFOV: 46,
    cameraTargetY: 0.0,
    depthAttenuation: 0.12,
    pitchBandCount: 9,

    // Fast, responsive rings
    innerRing: {
        minRadius: 0.55,
        maxRadius: 1.3,
        minOpacity: 0.5,
        maxOpacity: 0.98,
        thickness: 0.028,
        glowIntensity: 1.3,
        colorHueMin: 0.05,
        colorHueMax: 0.55,
        yRange: [-4.0, 4.0],    // MASSIVE vertical range
        ySmoothing: 20.0,
        radiusSmoothing: 12.0,
        opacitySmoothing: 12.0,
        zOffset: 0.0,
    },
    outerRing: {
        minRadius: 1.0,
        maxRadius: 1.9,
        minOpacity: 0.25,
        maxOpacity: 0.75,
        thickness: 0.02,
        glowIntensity: 1.0,
        colorHueMin: 0.55,
        colorHueMax: 0.15,
        yRange: [-4.0, 4.0],    // MASSIVE vertical range
        ySmoothing: 18.0,
        radiusSmoothing: 10.0,
        opacitySmoothing: 10.0,
        zOffset: 0.0,
    },

    particles: {
        count: 220,
        size: 0.045,
        lifetime: 1.8,
        burstCount: 24,
        burstLifetime: 0.8,
    },

    // Fast transitions
    ringEntryDurationSeconds: 0.10,
    ringExitDurationSeconds: 0.30,
    ringHoverDuration: 0.5,
    ringHoverVisibility: 0.3,
    ringHoverRadius: 0.9,

    // Smooth pitch tracking — boosted for extreme vertical responsiveness
    pitchFilterEmaSpeed: 15.0,
    pitchOutlierSemitones: 2.0,
    pitchOutlierConfirmFrames: 2,
    pitchTargetEmaSpeed: 15.0,

    // Activation – low threshold for immediate response
    ringActivationPitchConfFloor: 0.02,
    ringReactivationOnThreshold: 0.12,
    ringReactivationOffThreshold: 0.08,
    ringReactivationMinPitchConf: 0.05,
    ringReactivationMinLoudness: 0.02,

    // Idle
    ringIdleVisibility: 0.25,
    ringIdleRadius: 0.8,
    ringIdleBreathAmp: 0.04,
    ringIdleBreathSpeed: 0.5,

    // Release effect
    releaseFloatRise: 0.12,
    releaseFloatDuration: 0.6,
    releaseReturnDuration: 1.0,

    ghostRingEnabled: true,
    ghostRingFadeSpeed: 1.5,
    echoEnabled: true,
    echoCount: 3,
    echoSpawnRadius: [0.98, 1.15, 1.4],
    echoFadeSpeeds: [2.0, 2.5, 3.0],
    echoExpandSpeeds: [0.25, 0.2, 0.15],
};

// --- Background, PitchBand, StageBase ---
class BackgroundSystem {
    constructor(scene) {
        const domeGeometry = new THREE.SphereGeometry(48, 64, 64);
        const domeMaterial = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            uniforms: {
                uTop: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundTop) },
                uBottom: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundBottom) },
                uHaze: { value: new THREE.Color(VISUAL_SCENE_CONFIG.backgroundHaze) },
                uTime: { value: 0 }
            },
            vertexShader: `
                varying vec3 vWorldPos;
                varying vec3 vNormal;
                void main() {
                    vec4 world = modelMatrix * vec4(position, 1.0);
                    vWorldPos = world.xyz;
                    vNormal = normalize(mat3(modelMatrix) * normal);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                varying vec3 vWorldPos;
                uniform vec3 uTop;
                uniform vec3 uBottom;
                uniform vec3 uHaze;
                uniform float uTime;
                float hash(vec3 p) {
                    p  = fract(p * 0.3183099 + 0.1);
                    p *= 17.0;
                    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
                }
                void main() {
                    float h = clamp((vWorldPos.y + 8.0) / 18.0, 0.0, 1.0);
                    float t = smoothstep(0.08, 0.92, h);
                    float noiseVal = hash(vWorldPos * 0.5 + uTime * 0.02);
                    t += (noiseVal - 0.5) * 0.04;
                    float centerGlow = exp(-pow(vWorldPos.y * 0.14, 2.0)) * exp(-pow(vWorldPos.x * 0.07, 2.0));
                    vec3 col = mix(uBottom, uTop, t);
                    col = mix(col, uHaze, centerGlow * 0.35);
                    if (vWorldPos.y > 1.5) {
                        float star = hash(floor(vWorldPos * 40.0));
                        if (star > 0.998) {
                            col += vec3(0.5, 0.6, 0.8) * (star - 0.998) * 200.0 * (vWorldPos.y * 0.1);
                        }
                    }
                    gl_FragColor = vec4(col, 1.0);
                }
            `
        });
        this.mesh = new THREE.Mesh(domeGeometry, domeMaterial);
        scene.add(this.mesh);
        this.material = domeMaterial;
    }
    update(time) { if (this.material) this.material.uniforms.uTime.value = time; }
}

class PitchBandSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);
        const yMin = -4.5, yMax = 4.5; // Expanded to cover new massive vertical range
        const count = VISUAL_SCENE_CONFIG.pitchBandCount;
        const gap = (yMax - yMin) / (count - 1);
        const centers = [], colors = [];
        for (let i = 0; i < count; i++) {
            const t = i / (count - 1);
            const col = this.colorForBand(t);
            centers.push(yMin + i * gap);
            colors.push(new THREE.Vector3(col.r, col.g, col.b));
        }
        const material = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
            uniforms: {
                uOpacity: { value: VISUAL_SCENE_CONFIG.bandOpacity },
                uCenters: { value: centers },
                uColors: { value: colors },
                uCount: { value: count },
                uSoftness: { value: VISUAL_SCENE_CONFIG.bandSoftness },
                uDepthK: { value: VISUAL_SCENE_CONFIG.depthAttenuation },
                uTime: { value: 0 }
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
                uniform float uCenters[9];
                uniform vec3 uColors[9];
                uniform int uCount;
                uniform float uSoftness;
                uniform float uDepthK;
                uniform float uTime;
                void main() {
                    vec3 colorAccum = vec3(0.0);
                    float weightAccum = 0.0;
                    for (int i = 0; i < 9; i++) {
                        if (i >= uCount) break;
                        float dy = vWorldPos.y - uCenters[i];
                        float layer = exp(-(dy * dy) / max(uSoftness, 0.001));
                        colorAccum += uColors[i] * layer;
                        weightAccum += layer;
                    }
                    if (weightAccum < 0.0005) discard;
                    float distanceFactor = clamp(1.0 - vViewDepth * uDepthK, 0.3, 1.0);
                    float sideFalloff = exp(-pow(vWorldPos.x * 0.11, 2.0));
                    float verticalWindow = exp(-pow(vWorldPos.y * 0.05, 2.0)); // Widened to allow taller visibility
                    float alpha = (weightAccum / float(max(uCount, 1))) * uOpacity * sideFalloff;
                    alpha *= mix(0.5, 1.0, verticalWindow) * distanceFactor;
                    alpha *= 0.9 + 0.1 * sin(vWorldPos.y * 2.0 + uTime * 0.5);
                    if (alpha < 0.005) discard;
                    vec3 color = colorAccum / weightAccum;
                    gl_FragColor = vec4(color, min(alpha, 0.28));
                }
            `
        });
        const fogPlane = new THREE.Mesh(new THREE.PlaneGeometry(30.0, 24.0, 1, 1), material); // Expanded geometry
        fogPlane.position.set(0, 0, -4.2);
        this.group.add(fogPlane);
        const echoPlane = fogPlane.clone();
        echoPlane.material = material.clone();
        echoPlane.material.blending = THREE.AdditiveBlending;
        echoPlane.material.uniforms.uOpacity.value = VISUAL_SCENE_CONFIG.bandOpacity * 0.7;
        echoPlane.position.z = -5.2;
        this.group.add(echoPlane);
        this.materials = [material, echoPlane.material];
    }
    colorForBand(t) {
        const stops = [
            { t: 0.0, color: new THREE.Color(0x5e2a3a) },
            { t: 0.25, color: new THREE.Color(0x9e5a3a) },
            { t: 0.5, color: new THREE.Color(0xc99e4a) },
            { t: 0.75, color: new THREE.Color(0x4a9e8a) },
            { t: 1.0, color: new THREE.Color(0x5a9ec9) }
        ];
        for (let i = 0; i < stops.length - 1; i++) {
            const a = stops[i], b = stops[i+1];
            if (t >= a.t && t <= b.t) return a.color.clone().lerp(b.color, (t - a.t) / (b.t - a.t));
        }
        return stops[stops.length-1].color.clone();
    }
    update(time) { this.materials.forEach(mat => { if (mat) mat.uniforms.uTime.value = time; }); }
}

class StageBaseSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);
        const baseMaterial = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, side: THREE.DoubleSide,
            uniforms: {
                uBaseColor: { value: new THREE.Color(0x101a28) },
                uRimColor: { value: new THREE.Color(0x2a4a6a) },
                uInnerFade: { value: 0.38 },
                uOuterFade: { value: 1.0 },
                uOpacity: { value: 0.48 },
                uTime: { value: 0 }
            },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uBaseColor;
                uniform vec3 uRimColor;
                uniform float uInnerFade;
                uniform float uOuterFade;
                uniform float uOpacity;
                uniform float uTime;
                void main() {
                    float r = length(vUv);
                    float body = 1.0 - smoothstep(uInnerFade, uOuterFade, r);
                    float rim = smoothstep(0.58, 0.98, r) * (1.0 - smoothstep(0.98, 1.05, r));
                    float alpha = body * uOpacity + rim * 0.2;
                    if (alpha < 0.01) discard;
                    vec3 color = mix(uBaseColor, uRimColor, rim * 0.9);
                    color *= 0.9 + 0.1 * sin(r * 8.0 - uTime * 2.0);
                    gl_FragColor = vec4(color, alpha);
                }
            `
        });
        const baseMesh = new THREE.Mesh(new THREE.CircleGeometry(6.0, 96), baseMaterial);
        baseMesh.rotation.x = -Math.PI / 2;
        baseMesh.scale.set(1.6, 1.0, 1.1);
        baseMesh.position.set(0, -5.0, -1.2); // Dropped down to fit massive vertical space
        this.group.add(baseMesh);
        this.material = baseMaterial;
    }
    update(time) { if (this.material) this.material.uniforms.uTime.value = time; }
}

// --- Particle System ---
class ParticleSystem {
    constructor(scene, ringRadiusRef = () => 1.2) {
        this.scene = scene;
        this.getRingRadius = ringRadiusRef;
        this.particles = [];
        this.group = new THREE.Group();
        scene.add(this.group);
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(VISUAL_SCENE_CONFIG.particles.count * 3);
        const colors = new Float32Array(VISUAL_SCENE_CONFIG.particles.count * 3);
        for (let i = 0; i < VISUAL_SCENE_CONFIG.particles.count; i++) {
            positions[i*3] = positions[i*3+1] = positions[i*3+2] = 0;
            colors[i*3] = 1; colors[i*3+1] = 0.5; colors[i*3+2] = 0.2;
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const particleMaterial = new THREE.PointsMaterial({ size: VISUAL_SCENE_CONFIG.particles.size, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending });
        this.pointCloud = new THREE.Points(geometry, particleMaterial);
        this.group.add(this.pointCloud);
        for (let i = 0; i < VISUAL_SCENE_CONFIG.particles.count; i++) {
            this.particles.push({ active: false, life: 0, maxLife: 1, pos: new THREE.Vector3(), vel: new THREE.Vector3(), color: new THREE.Color(), angle: 0, radius: 1 });
        }
        this.burstParticles = [];
        this.lastBurstTime = 0;
    }
    burst(position, color, count = null) {
        const burstCount = count || VISUAL_SCENE_CONFIG.particles.burstCount;
        const now = performance.now() / 1000;
        if (now - this.lastBurstTime < 0.05) return;
        this.lastBurstTime = now;
        for (let i = 0; i < burstCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 0.8 + Math.random() * 1.5;
            const vx = Math.cos(angle) * speed, vz = Math.sin(angle) * speed, vy = (Math.random() - 0.5) * 1.2;
            this.burstParticles.push({ active: true, life: 1.0, maxLife: VISUAL_SCENE_CONFIG.particles.burstLifetime, pos: position.clone(), vel: new THREE.Vector3(vx, vy, vz), color: color.clone() });
        }
    }
    update(dt, ringY, ringRadius, ringColor, onsetStrength) {
        const cfg = VISUAL_SCENE_CONFIG.particles;
        const ringRad = this.getRingRadius() || ringRadius;
        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];
            if (!p.active) {
                if (Math.random() < 0.02) {
                    p.active = true; p.life = 1.0; p.maxLife = cfg.lifetime * (0.6 + Math.random() * 0.8);
                    p.angle = Math.random() * Math.PI * 2; p.radius = ringRad * (0.85 + Math.random() * 0.3);
                    const hue = (ringColor.getHSL({}).h + (Math.random() - 0.5) * 0.15) % 1;
                    p.color.setHSL(hue, 0.9, 0.6);
                    p.pos.set(Math.cos(p.angle) * p.radius, ringY + (Math.random() - 0.5) * 0.4, Math.sin(p.angle) * p.radius);
                }
                continue;
            }
            p.life -= dt / p.maxLife;
            if (p.life <= 0) { p.active = false; continue; }
            p.angle += dt * 2.5;
            const targetRadius = ringRad * (0.9 + Math.sin(p.life * Math.PI) * 0.15);
            p.radius = MathUtils.lerp(p.radius, targetRadius, 0.1);
            p.pos.x = Math.cos(p.angle) * p.radius;
            p.pos.z = Math.sin(p.angle) * p.radius;
            p.pos.y = ringY + Math.sin(p.angle * 2 + p.life * 5) * 0.08;
        }
        for (let i = this.burstParticles.length - 1; i >= 0; i--) {
            const p = this.burstParticles[i];
            p.life -= dt / p.maxLife;
            if (p.life <= 0) { this.burstParticles.splice(i,1); continue; }
            p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt; p.pos.z += p.vel.z * dt;
            p.vel.y -= dt * 2.5;
        }
        const positions = this.pointCloud.geometry.attributes.position.array;
        const colorsAttr = this.pointCloud.geometry.attributes.color.array;
        let idx = 0;
        for (const p of this.particles) {
            if (!p.active) {
                positions[idx*3]=positions[idx*3+1]=positions[idx*3+2]=0;
                colorsAttr[idx*3]=colorsAttr[idx*3+1]=colorsAttr[idx*3+2]=0;
            } else {
                const lf = p.life;
                positions[idx*3]=p.pos.x; positions[idx*3+1]=p.pos.y; positions[idx*3+2]=p.pos.z;
                colorsAttr[idx*3]=p.color.r*lf; colorsAttr[idx*3+1]=p.color.g*lf; colorsAttr[idx*3+2]=p.color.b*lf;
            }
            idx++;
        }
        this.pointCloud.geometry.attributes.position.needsUpdate = true;
        this.pointCloud.geometry.attributes.color.needsUpdate = true;
    }
}

// --- Fast, responsive DualRingSystem ---
class DualRingSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);
        const extent = 8.0;
        const halfExtent = extent / 2;
        const innerMat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
            uniforms: {
                uColor: { value: new THREE.Color(0xff8844) },
                uRadius: { value: 1.0 },
                uExtentHalf: { value: halfExtent },
                uThickness: { value: VISUAL_SCENE_CONFIG.innerRing.thickness },
                uOpacity: { value: 0.5 },
                uGlowIntensity: { value: VISUAL_SCENE_CONFIG.innerRing.glowIntensity },
                uTime: { value: 0 },
                uPulse: { value: 0 },
            },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uColor; uniform float uRadius; uniform float uExtentHalf;
                uniform float uThickness; uniform float uOpacity;
                uniform float uGlowIntensity; uniform float uTime; uniform float uPulse;
                void main() {
                    vec2 c = (vUv * 2.0 - 1.0) * uExtentHalf;
                    float r = length(c);
                    float dist = abs(r - uRadius);
                    float width = uRadius * uThickness * (1.0 + uPulse * 0.3);
                    float profile = pow(1.0 - smoothstep(0.0, width, dist), 0.8);
                    float glowWidth = max(uRadius * 0.18, 0.01);
                    float glow = exp(-pow(dist / glowWidth, 2.0)) * uGlowIntensity;
                    float alpha = (profile * uOpacity + glow * 0.4) * (0.85 + 0.15 * sin(uTime * 8.0));
                    if (alpha < 0.01) discard;
                    vec3 col = uColor + vec3(0.3,0.15,0.05) * glow;
                    col *= 0.85 + 0.15 * sin(r * 5.0 - uTime * 12.0);
                    gl_FragColor = vec4(col, min(alpha, 0.95));
                }
            `
        });
        const innerMesh = new THREE.Mesh(new THREE.PlaneGeometry(extent, extent), innerMat);
        innerMesh.rotation.x = -Math.PI / 2;
        innerMesh.position.z = VISUAL_SCENE_CONFIG.innerRing.zOffset;
        this.group.add(innerMesh);
        this.innerRing = innerMesh;
        this.innerMat = innerMat;

        const outerMat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
            uniforms: {
                uColor: { value: new THREE.Color(0x44aaff) },
                uRadius: { value: 1.5 },
                uExtentHalf: { value: halfExtent },
                uThickness: { value: VISUAL_SCENE_CONFIG.outerRing.thickness },
                uOpacity: { value: 0.4 },
                uGlowIntensity: { value: VISUAL_SCENE_CONFIG.outerRing.glowIntensity },
                uTime: { value: 0 },
                uPulse: { value: 0 },
            },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uColor; uniform float uRadius; uniform float uExtentHalf;
                uniform float uThickness; uniform float uOpacity;
                uniform float uGlowIntensity; uniform float uTime; uniform float uPulse;
                void main() {
                    vec2 c = (vUv * 2.0 - 1.0) * uExtentHalf;
                    float r = length(c);
                    float dist = abs(r - uRadius);
                    float width = uRadius * uThickness * (1.0 + uPulse * 0.25);
                    float profile = pow(1.0 - smoothstep(0.0, width, dist), 0.7);
                    float glowWidth = max(uRadius * 0.22, 0.01);
                    float glow = exp(-pow(dist / glowWidth, 2.0)) * uGlowIntensity;
                    float alpha = (profile * uOpacity + glow * 0.3) * (0.75 + 0.25 * sin(uTime * 6.0));
                    if (alpha < 0.01) discard;
                    vec3 col = uColor + vec3(0.2,0.25,0.35) * glow;
                    gl_FragColor = vec4(col, min(alpha, 0.8));
                }
            `
        });
        const outerMesh = new THREE.Mesh(new THREE.PlaneGeometry(extent * 1.1, extent * 1.1), outerMat);
        outerMesh.rotation.x = -Math.PI / 2;
        outerMesh.position.z = VISUAL_SCENE_CONFIG.outerRing.zOffset;
        this.group.add(outerMesh);
        this.outerRing = outerMesh;
        this.outerMat = outerMat;

        // State
        this.ringState = {
            innerY: 0, outerY: 0,
            innerRadius: VISUAL_SCENE_CONFIG.ringIdleRadius,
            outerRadius: VISUAL_SCENE_CONFIG.outerRing.minRadius,
            innerOpacity: VISUAL_SCENE_CONFIG.ringIdleVisibility,
            outerOpacity: VISUAL_SCENE_CONFIG.outerRing.minOpacity,
            innerColor: new THREE.Color(0xff8844),
            outerColor: new THREE.Color(0x44aaff),
            onsetFlash: 0,
        };
        this.displayY = -4.0;  // start at bottom of new massive yRange
        this.smState = 'IDLE';
        this.attackProgress = 0;
        this.attackStartY = -4.0;
        this.attackTargetY = 0;
        this.hoverProgress = 0;
        this.releaseProgress = 0;
        this.lastOnset = 0;

        // Pitch filter - updated to handle large dynamic range
        this.pitchFilter = { filteredY: -4.0, seeded: false, lastRawY: -4.0 };

        this.particleSystem = new ParticleSystem(scene, () => this.ringState.innerRadius);
        this.echoItems = [];
        this._createEchoPool();
        if (VISUAL_SCENE_CONFIG.ghostRingEnabled) this._createGhostRing();
    }

    _createGhostRing() {
        const extent = 8.0;
        const halfExtent = extent / 2;
        const ghostMat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
            uniforms: {
                uColor: { value: new THREE.Color(0xffaa66) },
                uRadius: { value: 1.0 },
                uExtentHalf: { value: halfExtent },
                uThickness: { value: 0.02 },
                uOpacity: { value: 0 },
                uTime: { value: 0 },
            },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uColor; uniform float uRadius; uniform float uExtentHalf; uniform float uThickness; uniform float uOpacity;
                void main() {
                    vec2 c = (vUv * 2.0 - 1.0) * uExtentHalf;
                    float r = length(c);
                    float dist = abs(r - uRadius);
                    float width = uRadius * uThickness;
                    float profile = 1.0 - smoothstep(0.0, width, dist);
                    float alpha = profile * uOpacity * 0.5;
                    if (alpha < 0.01) discard;
                    gl_FragColor = vec4(uColor, alpha);
                }
            `
        });
        const ghostMesh = new THREE.Mesh(new THREE.PlaneGeometry(extent, extent), ghostMat);
        ghostMesh.rotation.x = -Math.PI / 2;
        ghostMesh.position.z = -0.2;
        this.group.add(ghostMesh);
        this.ghostRing = ghostMesh;
        this.ghostMat = ghostMat;
        this.ghostOpacity = 0;
        this.ghostRadius = 1.0;
        this.ghostY = 0;
    }

    _createEchoPool() {
        if (!VISUAL_SCENE_CONFIG.echoEnabled) return;
        const extent = 8.0;
        const halfExtent = extent / 2;
        for (let i = 0; i < VISUAL_SCENE_CONFIG.echoCount; i++) {
            const mat = new THREE.ShaderMaterial({
                transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
                uniforms: {
                    uColor: { value: new THREE.Color(0xffaa66) },
                    uRadius: { value: 1.0 },
                    uExtentHalf: { value: halfExtent },
                    uThickness: { value: 0.015 },
                    uOpacity: { value: 0 },
                    uTime: { value: 0 },
                },
                vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
                fragmentShader: `
                    varying vec2 vUv;
                    uniform vec3 uColor; uniform float uRadius; uniform float uExtentHalf; uniform float uThickness; uniform float uOpacity;
                    void main() {
                        vec2 c = (vUv * 2.0 - 1.0) * uExtentHalf;
                        float r = length(c);
                        float dist = abs(r - uRadius);
                        float width = uRadius * uThickness;
                        float profile = 1.0 - smoothstep(0.0, width, dist);
                        float alpha = profile * uOpacity * 0.6;
                        if (alpha < 0.01) discard;
                        gl_FragColor = vec4(uColor, alpha);
                    }
                `
            });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(extent, extent), mat);
            mesh.rotation.x = -Math.PI / 2;
            mesh.position.z = -0.15;
            this.group.add(mesh);
            this.echoItems.push({ mesh, material: mat, active: false, life: 0, radius: 1.0, y: 0, color: new THREE.Color() });
        }
    }

    smoothToward(current, target, speed, dt) {
        const alpha = 1 - Math.exp(-Math.max(0.001, speed) * Math.max(0.001, dt));
        return MathUtils.lerp(current, target, alpha);
    }

    _filterPitchY(rawY, dt) {
        const f = this.pitchFilter;
        if (!f.seeded) { f.filteredY = rawY; f.seeded = true; f.lastRawY = rawY; return rawY; }

        // Vastly increased maxDelta to prevent clamping the extreme pitch jumps
        // that are required for a visually notable vertical scale
        const maxDelta = 0.8;
        let clamped = rawY;
        if (Math.abs(rawY - f.lastRawY) > maxDelta) clamped = f.lastRawY + Math.sign(rawY - f.lastRawY) * maxDelta;
        f.lastRawY = clamped;
        const alpha = 1 - Math.exp(-VISUAL_SCENE_CONFIG.pitchFilterEmaSpeed * dt);
        f.filteredY += (clamped - f.filteredY) * alpha;
        return f.filteredY;
    }

    colorFromPitchNorm(pitchNorm, isInner) {
        const cfg = isInner ? VISUAL_SCENE_CONFIG.innerRing : VISUAL_SCENE_CONFIG.outerRing;
        const hue = cfg.colorHueMin + pitchNorm * (cfg.colorHueMax - cfg.colorHueMin);
        return new THREE.Color().setHSL(hue, 0.85, 0.55);
    }

    updateState(liveState, dt, elapsed) {
        const voiced = liveState?.active || false;
        const pitchNorm = MathUtils.clamp(liveState?.pitchNorm ?? 0.5, 0, 1);
        const rawLoudNorm = MathUtils.clamp(liveState?.loudNorm ?? 0, 0, 1);

        if (this._smoothLoud === undefined) this._smoothLoud = rawLoudNorm;
        this._smoothLoud = this.smoothToward(this._smoothLoud, rawLoudNorm, 5.0, dt);
        const loudNorm = this._smoothLoud;
        const onset = MathUtils.clamp(liveState?.onset ?? 0, 0, 1);
        const confidence = MathUtils.clamp(liveState?.pitchConf ?? 0, 0, 1);

        const rawY = liveState?.y ?? -4.0; // Default to new bottom
        const filteredY = this._filterPitchY(rawY, dt);

        const targetInnerRadius = VISUAL_SCENE_CONFIG.innerRing.minRadius + loudNorm * (VISUAL_SCENE_CONFIG.innerRing.maxRadius - VISUAL_SCENE_CONFIG.innerRing.minRadius);
        const targetOuterRadius = VISUAL_SCENE_CONFIG.outerRing.minRadius + loudNorm * (VISUAL_SCENE_CONFIG.outerRing.maxRadius - VISUAL_SCENE_CONFIG.outerRing.minRadius);
        const targetInnerOpacity = voiced ? VISUAL_SCENE_CONFIG.innerRing.minOpacity + confidence * (VISUAL_SCENE_CONFIG.innerRing.maxOpacity - VISUAL_SCENE_CONFIG.innerRing.minOpacity) : VISUAL_SCENE_CONFIG.ringIdleVisibility;
        const targetOuterOpacity = voiced ? VISUAL_SCENE_CONFIG.outerRing.minOpacity + confidence * 0.5 * (VISUAL_SCENE_CONFIG.outerRing.maxOpacity - VISUAL_SCENE_CONFIG.outerRing.minOpacity) : 0.15;
        const targetInnerColor = this.colorFromPitchNorm(pitchNorm, true);
        const targetOuterColor = this.colorFromPitchNorm(pitchNorm, false);

        // State machine
        switch (this.smState) {
            case 'IDLE':
                if (voiced) { this.smState = 'ATTACK'; this.attackProgress = 0; this.attackStartY = this.displayY; this.attackTargetY = filteredY; }
                break;
            case 'ATTACK':
                if (!voiced) { this.smState = 'RELEASE'; this.releaseProgress = 0; this.releaseStartY = this.displayY; }
                else {
                    this.attackProgress = Math.min(1, this.attackProgress + dt / VISUAL_SCENE_CONFIG.ringEntryDurationSeconds);
                    this.displayY = MathUtils.lerp(this.attackStartY, this.attackTargetY, this.attackProgress);
                    if (this.attackProgress >= 1) this.smState = 'TRACKING';
                }
                break;
            case 'TRACKING':
                if (!voiced) { this.smState = 'HOVER'; this.hoverProgress = 0; this.hoverStartY = this.displayY; }
                else {
                    const speed = VISUAL_SCENE_CONFIG.pitchTargetEmaSpeed;
                    this.displayY = this.smoothToward(this.displayY, filteredY, speed, dt);
                }
                break;
            case 'HOVER':
                if (voiced) { this.smState = 'ATTACK'; this.attackProgress = 0; this.attackStartY = this.displayY; this.attackTargetY = filteredY; }
                else {
                    this.hoverProgress = Math.min(1, this.hoverProgress + dt / VISUAL_SCENE_CONFIG.ringHoverDuration);
                    this.displayY = this.hoverStartY * (1 - this.hoverProgress * 0.3);
                    if (this.hoverProgress >= 1) { this.smState = 'RELEASE'; this.releaseProgress = 0; this.releaseStartY = this.displayY; }
                }
                break;
            case 'RELEASE':
                if (voiced) { this.smState = 'ATTACK'; this.attackProgress = 0; this.attackStartY = this.displayY; this.attackTargetY = filteredY; }
                else {
                    const totalDur = VISUAL_SCENE_CONFIG.releaseFloatDuration + VISUAL_SCENE_CONFIG.releaseReturnDuration;
                    this.releaseProgress = Math.min(1, this.releaseProgress + dt / totalDur);
                    if (this.releaseProgress <= VISUAL_SCENE_CONFIG.releaseFloatDuration / totalDur) {
                        const p = this.releaseProgress / (VISUAL_SCENE_CONFIG.releaseFloatDuration / totalDur);
                        this.displayY = this.releaseStartY + VISUAL_SCENE_CONFIG.releaseFloatRise * p;
                    } else {
                        const p = (this.releaseProgress - VISUAL_SCENE_CONFIG.releaseFloatDuration / totalDur) / (1 - VISUAL_SCENE_CONFIG.releaseFloatDuration / totalDur);
                        this.displayY = (this.releaseStartY + VISUAL_SCENE_CONFIG.releaseFloatRise) * (1 - p) + (-4.0) * p; // Return to new bottom
                    }
                    if (this.releaseProgress >= 1) { this.smState = 'IDLE'; this.displayY = -4.0; } // Lock to bottom
                }
                break;
        }

        // Apply smoothing to radius, opacity, color
        const rSpeed = VISUAL_SCENE_CONFIG.innerRing.radiusSmoothing;
        const oSpeed = VISUAL_SCENE_CONFIG.innerRing.opacitySmoothing;
        this.ringState.innerRadius = this.smoothToward(this.ringState.innerRadius, targetInnerRadius, rSpeed, dt);
        this.ringState.outerRadius = this.smoothToward(this.ringState.outerRadius, targetOuterRadius, rSpeed * 0.8, dt);
        this.ringState.innerOpacity = this.smoothToward(this.ringState.innerOpacity, targetInnerOpacity, oSpeed, dt);
        this.ringState.outerOpacity = this.smoothToward(this.ringState.outerOpacity, targetOuterOpacity, oSpeed * 0.7, dt);
        this.ringState.innerColor.lerp(targetInnerColor, 0.06);
        this.ringState.outerColor.lerp(targetOuterColor, 0.05);
        this.ringState.onsetFlash = this.smoothToward(this.ringState.onsetFlash, onset * 1.0, 8, dt);
        this.ringState.innerY = this.displayY;
        this.ringState.outerY = this.displayY - 0.05;

        if (onset > 0.3 && (elapsed - this.lastOnset) > 0.2) {
            this.lastOnset = elapsed;
            const burstPos = new THREE.Vector3(0, this.displayY, -0.3);
            this.particleSystem.burst(burstPos, this.ringState.innerColor, Math.floor(12 + onset * 20));
        }
    }

    update(timeSeconds, liveState, dt) {
        this.updateState(liveState, dt, timeSeconds);
        const pulse = 0.5 + 0.5 * Math.sin(timeSeconds * 8) * this.ringState.onsetFlash;
        this.innerMat.uniforms.uColor.value = this.ringState.innerColor;
        this.innerMat.uniforms.uRadius.value = this.ringState.innerRadius;
        this.innerMat.uniforms.uOpacity.value = this.ringState.innerOpacity * (0.7 + this.ringState.onsetFlash * 0.5);
        this.innerMat.uniforms.uPulse.value = pulse * this.ringState.onsetFlash;
        this.innerMat.uniforms.uTime.value = timeSeconds;
        this.outerMat.uniforms.uColor.value = this.ringState.outerColor;
        this.outerMat.uniforms.uRadius.value = this.ringState.outerRadius;
        this.outerMat.uniforms.uOpacity.value = this.ringState.outerOpacity * (0.6 + this.ringState.onsetFlash * 0.4);
        this.outerMat.uniforms.uPulse.value = pulse * 0.7;
        this.outerMat.uniforms.uTime.value = timeSeconds;
        this.innerRing.position.y = this.ringState.innerY;
        this.outerRing.position.y = this.ringState.outerY;

        if (this.ghostRing && VISUAL_SCENE_CONFIG.ghostRingEnabled) {
            this.ghostOpacity = Math.max(0, this.ghostOpacity - dt * VISUAL_SCENE_CONFIG.ghostRingFadeSpeed);
            if (liveState?.active && this.smState === 'RELEASE') {
                this.ghostOpacity = 0.4;
                this.ghostRadius = this.ringState.innerRadius;
                this.ghostY = this.ringState.innerY;
            }
            this.ghostMat.uniforms.uOpacity.value = this.ghostOpacity;
            this.ghostMat.uniforms.uRadius.value = this.ghostRadius;
            this.ghostMat.uniforms.uColor.value = this.ringState.innerColor;
            this.ghostMat.uniforms.uTime.value = timeSeconds;
            this.ghostRing.position.y = this.ghostY;
        }

        if (VISUAL_SCENE_CONFIG.echoEnabled && this.echoItems) {
            if (this.smState === 'RELEASE' && this.releaseProgress < 0.1 && !this._echoSpawned) {
                this._echoSpawned = true;
                for (let i = 0; i < this.echoItems.length; i++) {
                    const e = this.echoItems[i];
                    e.active = true; e.life = 1.0;
                    e.radius = this.ringState.innerRadius * (VISUAL_SCENE_CONFIG.echoSpawnRadius[i] || 1.0);
                    e.y = this.ringState.innerY;
                    e.color.copy(this.ringState.innerColor);
                }
            }
            if (this.smState !== 'RELEASE') this._echoSpawned = false;
            for (let i = 0; i < this.echoItems.length; i++) {
                const e = this.echoItems[i];
                if (!e.active) { e.mesh.visible = false; continue; }
                e.life -= dt / VISUAL_SCENE_CONFIG.echoFadeSpeeds[i];
                if (e.life <= 0) { e.active = false; e.mesh.visible = false; continue; }
                e.radius += VISUAL_SCENE_CONFIG.echoExpandSpeeds[i] * dt;
                e.mesh.visible = true;
                e.mesh.position.y = e.y;
                e.material.uniforms.uOpacity.value = e.life * 0.5;
                e.material.uniforms.uRadius.value = e.radius;
                e.material.uniforms.uColor.value = e.color;
                e.material.uniforms.uTime.value = timeSeconds;
            }
        }
        this.particleSystem.update(dt, this.ringState.innerY, this.ringState.innerRadius, this.ringState.innerColor, this.ringState.onsetFlash);
    }

    mapLiveRingState(audioState) {
        if (!audioState) return { active: false };
        const rawPitchNorm = audioState.rawPitchNorm ?? -1;
        const rawPitchConf = MathUtils.clamp(audioState.rawPitchConf ?? 0, 0, 1);
        const rawLoudNorm = MathUtils.clamp(audioState.rawLoudNorm ?? 0, 0, 1);
        const confFloor = VISUAL_SCENE_CONFIG.ringActivationPitchConfFloor;
        const rawConfGate = Math.max(0, (rawPitchConf - confFloor) / (1 - confFloor));
        const rawActivateScore = rawConfGate * 0.75 + rawLoudNorm * 0.25;
        const hasVoice = rawActivateScore >= VISUAL_SCENE_CONFIG.ringReactivationOnThreshold && rawPitchNorm >= 0;
        if (!hasVoice) return { active: false };
        const pitchNorm = MathUtils.clamp(rawPitchNorm, 0, 1);
        const yRange = VISUAL_SCENE_CONFIG.innerRing.yRange;
        const y = yRange[0] + pitchNorm * (yRange[1] - yRange[0]);
        return {
            active: true,
            y: y,
            pitchNorm: pitchNorm,
            loudNorm: MathUtils.clamp(audioState.loudNorm ?? 0, 0, 1),
            onset: MathUtils.clamp(audioState.onset ?? 0, 0, 1),
            pitchConf: rawPitchConf,
        };
    }
}

class AxisSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);
        const axisMat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
            uniforms: { uCore: { value: new THREE.Color(0xd7c19c) }, uHalo: { value: new THREE.Color(0x6488a0) }, uOpacity: { value: 0.12 } },
            vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec3 vPos;
                uniform vec3 uCore; uniform vec3 uHalo; uniform float uOpacity;
                void main(){
                    float r = length(vPos.xz);
                    float yFade = smoothstep(5.0, 1.0, abs(vPos.y)); // Scaled fade to match massive height
                    float core = exp(-pow(r * 36.0, 2.0));
                    float halo = exp(-pow(r * 12.5, 2.0));
                    float alpha = (core * 0.45 + halo * 0.16) * yFade * uOpacity;
                    vec3 col = mix(uHalo, uCore, core);
                    gl_FragColor = vec4(col, alpha);
                }
            `
        });
        const axisMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.008, 12.0, 20, 1, true), axisMat); // Massive cylinder height
        axisMesh.position.y = 0.05;
        this.group.add(axisMesh);
    }
    update() {}
}

class CameraSystem {
    constructor(camera) {
        this.camera = camera;
        this.target = new THREE.Vector3(0, VISUAL_SCENE_CONFIG.cameraTargetY, -0.5);
        this.apply();
    }
    apply() {
        this.camera.position.set(0, 1.4, VISUAL_SCENE_CONFIG.cameraDistance);
        this.camera.fov = VISUAL_SCENE_CONFIG.cameraFOV;
        this.camera.updateProjectionMatrix();
        this.camera.lookAt(this.target);
    }
    update() {}
}

// --- Main Engine ---
class VisualizerEngine {
    constructor(canvasId, audioManager) {
        this.audio = audioManager;
        this.canvas = document.getElementById(canvasId);
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 0.9;
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(VISUAL_SCENE_CONFIG.cameraFOV, window.innerWidth / window.innerHeight, 0.1, 100);
        this.clock = new THREE.Clock();
        this.debugView = DEBUG_VIEW;
        this.orbitControls = null;
        this.debugLabel = document.getElementById('debug-camera-label');
        this.buildStaticScene();
        this.setupDebugLabel();
        this.setupDebugControls();
        this.bindEvents();
        this.animate();
    }
    buildStaticScene() {
        this.systems = {
            background: new BackgroundSystem(this.scene),
            pitchBands: new PitchBandSystem(this.scene),
            stageBase: new StageBaseSystem(this.scene),
            rings: new DualRingSystem(this.scene),
            axis: new AxisSystem(this.scene),
            camera: new CameraSystem(this.camera)
        };
    }
    bindEvents() {
        window.addEventListener('resize', () => {
            const w = window.innerWidth, h = window.innerHeight;
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
            if (this.orbitControls) this.orbitControls.update();
        });
    }
    setupDebugControls() {
        if (!this.debugView || !THREE.OrbitControls) { this.systems.camera.apply(); return; }
        this.orbitControls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.orbitControls.enableRotate = true; this.orbitControls.enableZoom = true;
        this.orbitControls.target.copy(this.systems.camera.target);
        this.orbitControls.minDistance = 3.2; this.orbitControls.maxDistance = 25.0;
        this.orbitControls.update();
    }
    setupDebugLabel() { if (this.debugLabel) this.debugLabel.style.display = this.debugView ? 'block' : 'none'; }
    renderFrame() {
        const dt = Math.min(this.clock.getDelta(), 0.033);
        const elapsed = this.clock.elapsedTime;
        if (this.audio?.updateTime) this.audio.updateTime(dt);
        const sm = this.audio?.smoothed || null;
        const raw = this.audio?.state || null;
        const rawPitch = raw?.pitch ?? 0;
        const rawPitchConf = raw?.pitchConf ?? 0;
        const rawLoudness = raw?.loudness ?? -80;
        const rawLoudNorm = MathUtils.clamp((rawLoudness + 58) / 38, 0, 1);
        const rawPitchNorm = (rawPitch > 40) ? MathUtils.clamp((Math.log(MathUtils.clamp(rawPitch, 80, 1500)) - Math.log(80)) / (Math.log(1500) - Math.log(80)), 0, 1) : -1;
        const liveState = this.systems.rings.mapLiveRingState({
            rawPitchNorm, rawPitchConf, rawLoudNorm,
            pitchNorm: sm?.pitchNorm ?? 0,
            loudNorm: sm?.loudNorm ?? 0,
            pitchConf: sm?.pitchConf ?? 0,
            onset: sm?.onset ?? 0,
            transientFlash: this.audio?.transientFlash ?? 0,
            centroidNorm: sm?.centroidNorm ?? 0.5
        });
        if (this.orbitControls) this.orbitControls.update();
        Object.entries(this.systems).forEach(([key, sys]) => {
            if (key === 'rings') sys.update(elapsed, liveState, dt);
            else if (sys.update) sys.update(elapsed);
        });
        this.renderer.render(this.scene, this.camera);
    }
    animate() { this.renderFrame(); requestAnimationFrame(() => this.animate()); }
}

window.VisualizerEngine = VisualizerEngine;