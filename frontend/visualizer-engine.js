/**
 * ARTISTIC VOICE VISUALIZER ENGINE
 * Structured architecture:
 * - BackgroundSystem
 * - RingSystem (main + 4 sister rings + central beam)
 */

const VISUAL_SCENE_CONFIG = {
    backgroundTop: 0x050a14,
    backgroundBottom: 0x010307,
    backgroundHaze: 0x14273e,
    cameraDistance: 11.5,
    cameraFOV: 44,
    ringThickness: 0.055,
    ringGlow: 0.7,
    ringOpacity: 0.8,
    ringEchoCount: 4,
    axisOpacity: 0.22,
    ringStackNearOffset: 0.42,
    ringStackFarOffset: 0.84,
    ringMainOpacityLead: 1.0,
    ringNearOpacity: 0.72,
    ringFarOpacity: 0.56,
    ringAttack: 0.2,
    ringRelease: 0.075,
    ringYOffsetAttack: 0.17,
    ringYOffsetRelease: 0.07
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

class RingSystem {
    constructor(scene) {
        this.smState = 'IDLE';
        this.displayY = 0;
        this.displayRadius = 1.0;
        this.displayFlash = 0;
        this.displayColor = new THREE.Color(0.8, 0.55, 0.25);
        this.rings = [];

        this._createCentralBeam(scene);
        this._createRings(scene);
    }

    _createRingMaterial() {
        return new THREE.ShaderMaterial({
            transparent: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: {
                uColor: { value: new THREE.Color() },
                uRadius: { value: 1.0 },
                uThickness: { value: VISUAL_SCENE_CONFIG.ringThickness },
                uOpacity: { value: VISUAL_SCENE_CONFIG.ringOpacity },
                uGlow: { value: VISUAL_SCENE_CONFIG.ringGlow },
                uFlash: { value: 0 }
            },
            vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uColor;
                uniform float uRadius;
                uniform float uThickness;
                uniform float uOpacity;
                uniform float uGlow;
                uniform float uFlash;

                void main() {
                    vec2 uv = vUv * 2.0 - 1.0;
                    uv.x *= 1.08;
                    float dist = length(uv) * 4.0;
                    float ringDist = abs(dist - uRadius);

                    float inner = smoothstep(uThickness * 1.2, uThickness * 0.35, ringDist);
                    float mid = exp(-pow(ringDist / (uThickness * 0.85), 2.0));
                    float outer = exp(-pow(ringDist / (uThickness * 1.8), 2.0));

                    float alpha = (inner * 0.48 + mid * 0.40 + outer * 0.22) * uOpacity;
                    vec3 flashMix = mix(uColor, vec3(1.0, 0.94, 0.82), clamp(uFlash * 0.35, 0.0, 0.35));
                    vec3 color = flashMix * (0.70 + uGlow * 0.30 + mid * 0.18);
                    gl_FragColor = vec4(color, alpha);
                }`
        });
    }

    _createCentralBeam(scene) {
        const beamGeo = new THREE.CylinderGeometry(0.018, 0.018, 10.5, 10, 1, true);
        const beamMat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(0x8fa5c2),
            transparent: true,
            opacity: VISUAL_SCENE_CONFIG.axisOpacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        this.beam = new THREE.Mesh(beamGeo, beamMat);
        this.beam.position.y = 0;
        scene.add(this.beam);
    }

    _createRings(scene) {
        const nearOffset = VISUAL_SCENE_CONFIG.ringStackNearOffset;
        const farOffset = VISUAL_SCENE_CONFIG.ringStackFarOffset;
        const offsets = [0, nearOffset, farOffset, -nearOffset, -farOffset];
        const opacityScale = [
            VISUAL_SCENE_CONFIG.ringMainOpacityLead,
            VISUAL_SCENE_CONFIG.ringNearOpacity,
            VISUAL_SCENE_CONFIG.ringFarOpacity,
            VISUAL_SCENE_CONFIG.ringNearOpacity,
            VISUAL_SCENE_CONFIG.ringFarOpacity
        ];
        const radiusScale = [1.0, 0.94, 0.88, 0.94, 0.88];

        for (let i = 0; i < offsets.length; i++) {
            const mat = this._createRingMaterial();
            mat.uniforms.uOpacity.value = VISUAL_SCENE_CONFIG.ringOpacity * opacityScale[i];

            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), mat);
            mesh.rotation.x = -Math.PI / 2;
            scene.add(mesh);

            this.rings.push({
                mesh,
                mat,
                yOffset: offsets[i],
                radiusScale: radiusScale[i],
                opacityScale: opacityScale[i],
                hueShift: i === 0 ? 0 : (offsets[i] > 0 ? 0.02 : -0.02)
            });
        }
    }

    update(liveState) {
        const voiced = liveState?.active || false;
        this.smState = voiced ? 'TRACKING' : 'IDLE';

        const targetY = voiced ? liveState.y : 0.0;
        const targetRadius = voiced ? liveState.radius : 0.85;
        const targetFlash = voiced ? liveState.transient : 0;
        const thicknessBase = MathUtils.lerp(0.035, 0.078, liveState?.stability ?? 0);
        const opacityBase = VISUAL_SCENE_CONFIG.ringOpacity * MathUtils.lerp(0.5, 1.0, liveState?.stability ?? 0);

        const yFollow = voiced
            ? (targetY > this.displayY ? VISUAL_SCENE_CONFIG.ringYOffsetAttack : VISUAL_SCENE_CONFIG.ringYOffsetRelease)
            : VISUAL_SCENE_CONFIG.ringYOffsetRelease;
        const radiusFollow = targetRadius > this.displayRadius
            ? VISUAL_SCENE_CONFIG.ringAttack
            : VISUAL_SCENE_CONFIG.ringRelease;

        this.displayY = MathUtils.lerp(this.displayY, targetY, Math.max(liveState.followY ?? 0.16, yFollow));
        this.displayRadius = MathUtils.lerp(this.displayRadius, targetRadius, radiusFollow);
        this.displayFlash = MathUtils.lerp(this.displayFlash, targetFlash, 0.22);

        const baseHue = (liveState?.pitchNorm ?? 0.5) * 0.38 + 0.02;
        const baseSat = MathUtils.lerp(0.58, 0.76, liveState?.sisterRichness ?? 0);
        const baseLight = MathUtils.lerp(0.40, 0.52, liveState?.centroidNorm ?? 0.2);
        this.displayColor.lerp(new THREE.Color().setHSL(baseHue, baseSat, baseLight), 0.12);

        const sisterCoupling = MathUtils.lerp(0.96, 1.0, liveState?.sisterRichness ?? 0);
        this.beam.position.y = this.displayY;

        this.rings.forEach((ring, idx) => {
            ring.mesh.position.y = this.displayY + ring.yOffset;
            const coupledScale = idx === 0 ? 1.0 : sisterCoupling;
            ring.mat.uniforms.uRadius.value = this.displayRadius * ring.radiusScale * coupledScale;
            ring.mat.uniforms.uFlash.value = this.displayFlash;
            ring.mat.uniforms.uThickness.value = thicknessBase * (idx === 0 ? 1.0 : 0.9);
            ring.mat.uniforms.uOpacity.value = opacityBase * ring.opacityScale;
            ring.mat.uniforms.uColor.value = new THREE.Color().setHSL(
                MathUtils.clamp(baseHue + ring.hueShift, 0, 1),
                baseSat * 0.9,
                baseLight
            );
        });
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
        this.systems = {
            bg: new BackgroundSystem(this.scene),
            rings: new RingSystem(this.scene)
        };
        this.animate();
    }

    buildLiveState() {
        const sm = this.audio.smoothed;
        const conf = MathUtils.clamp(sm.pitchConf, 0, 1);
        const pitchMix = MathUtils.lerp(sm.histPitchNorm, sm.pitchNorm, conf);
        const loudMix = MathUtils.clamp(0.56 * sm.loudNorm + 0.34 * sm.energyNorm + 0.10 * sm.histLoudNorm, 0, 1);
        const yFromPitch = -3.8 + pitchMix * 7.6;
        const memoryOffset = (sm.histPitchNorm - sm.pitchNorm) * 0.7;
        const transient = MathUtils.clamp(this.audio.transientFlash * 0.75 + sm.histOnset * 0.35, 0, 1);
        const sisterRichness = MathUtils.clamp(0.6 * sm.peakSpread + 0.4 * sm.centroidNorm, 0, 1);

        return {
            active: sm.pitch > 40 && conf > 0.08,
            y: yFromPitch + memoryOffset * 0.35,
            followY: MathUtils.lerp(0.05, 0.2, conf),
            pitchNorm: pitchMix,
            radius: 0.82 + loudMix * 1.75 + transient * 0.2,
            transient,
            stability: conf,
            sisterRichness,
            centroidNorm: sm.centroidNorm
        };
    }

    renderFrame() {
        const dt = Math.min(this.clock.getDelta(), 0.033);
        if (this.controls) this.controls.update();
        this.audio.update(dt);

        const liveState = this.buildLiveState();
        this.systems.rings.update(liveState);

        this.renderer.render(this.scene, this.camera);
    }

    animate() {
        this.renderFrame();
        requestAnimationFrame(() => this.animate());
    }
}
