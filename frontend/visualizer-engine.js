// Static ring-based baseline scene for Stage 1.
// Relies on globals: THREE.

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
    backgroundTop: 0x0b1423,
    backgroundBottom: 0x030711,
    backgroundHaze: 0x112033,
    bandOpacity: 0.2,
    bandSoftness: 1.34,
    axisOpacity: 0.07,
    axisHeight: 2.35,
    cameraDistance: 6.7,
    depthAttenuation: 0.14,
    pitchBandCount: 7,
    ringMotionSpeed: 0.52,
    ringThicknessMotion: 0.068,
    ringLuminanceMotion: 0.055,
    ringRadiusMotion: 0.012,
    debugMotionMultiplier: {
        thickness: 3.4,
        luminance: 3.8,
        radius: 4.6
    },
    ringThickness: 1.0,
    ringGlow: 1.0,
    ringOpacity: 1.0,
    ringEchoCount: 0,
    ringActivationPitchConfFloor: 0.08,
    liveRingMinRadius: 0.72,
    liveRingMaxRadius: 2.2,
    liveRingMinSigma: 0.018,
    liveRingMaxSigma: 0.09,
    liveRingCarrierSafetyMargin: 0.16,
    // Layer 3 render: slower and velocity-capped so big pitch jumps animate,
    // not snap. ringYSmoothingSpeed was 16.0 — halved so the render layer
    // adds genuine weight. ringYMaxSpeed is a hard cap in Y-units/second
    // (~16 semitones/sec), preventing single-frame pops on large jumps.
    ringYSmoothingSpeed: 7.0,
    ringYMaxSpeed: 3.8,
    ringRadiusSmoothingSpeed: 10.0,
    ringVisibilityAttackSpeed: 20.0,
    ringVisibilityReleaseSpeed: 4.2,
    ringStateSmoothingSpeed: 8.0,
    // Attack is kept snappy; release stays calm.
    ringEntryDurationSeconds: 0.12,
    ringExitDurationSeconds: 0.4,

    // --- Pitch filter — 3-layer pipeline ---
    //
    //   rawY  →  [Layer 1: _filterPitchY]  →  filteredY
    //         →  [Layer 2: targetY EMA]    →  targetY
    //         →  [Layer 3: displayY, vel-capped EMA]  →  displayY
    //
    // Layer 1 (pitch domain): outlier rejection + hysteresis + EMA
    //   pitchFilterEmaSpeed reduced 18→10: slower note-level EMA so
    //   filteredY represents "the note being sung" not "instantaneous pitch".
    //   pitchHysteresisSemitones raised 0.4→1.0: 1 semitone deadband
    //   silences most vibrato and intonation wobble before it ever moves.
    //   pitchOutlierSemitones tightened 4.0→3.0: rejects detector spikes.
    //   pitchOutlierConfirmFrames raised 2→3: fewer false acceptances.
    //
    // 1 semitone ≈ 0.06 in Y-space ( = ln(2^(1/12)) / ln(1500/80) * 3.05 )
    pitchSemitoneY: 0.06,
    pitchFilterEmaSpeed: 10.0,
    pitchOutlierSemitones: 3.0,
    pitchOutlierConfirmFrames: 3,
    pitchHysteresisSemitones: 1.0,

    // Layer 2 (target domain): slow EMA on filteredY → targetY.
    // This is the "held note" concept — targetY is stable, weighted,
    // and changes only when the filtered pitch genuinely moves.
    // Lower = more glide; 5.0 gives ~120ms half-life feel.
    pitchTargetEmaSpeed: 5.0,
    ringEntrySpawnY: -1.88,
    ringReactivationOnThreshold: 0.26,
    ringReactivationOffThreshold: 0.13,
    ringReactivationMinPitchConf: 0.14,
    ringReactivationMinLoudness: 0.03,

    // --- HOVER state: ring lingers at last pitch position after voice stops ---
    // After voice loss the ring holds at the last tracked Y for hoverDuration
    // seconds, fading to hoverVisibility, before transitioning to RELEASE_FLOAT.
    ringHoverDuration: 2.2,
    ringHoverVisibility: 0.28,
    ringHoverRadius: 0.88,

    // --- Ghost echo ring: faint marker at held position during hover ---
    ghostRingEnabled: true,
    ghostRingFadeSpeed: 1.1,

    // --- RELEASE_FLOAT: ring stays near last-note Y, drifting gently upward,
    // then slowly sinking back to idle over releaseTotalDuration seconds.
    // No hard bottom-drop — the note "evaporates" from where it was sung.
    releaseFloatRise: 0.18,        // how far up the ring drifts during fade-out
    releaseFloatDuration: 1.6,     // seconds to float and fade before returning to idle
    releaseReturnDuration: 2.4,    // seconds to drift back from last-note Y to idle Y

    // --- Echo burst on voice loss: up to N expanding ghost rings ---
    echoEnabled: true,
    echoCount: 3,
    echoSpawnRadius: [0.9, 1.15, 1.45],  // relative to hover radius
    echoFadeSpeeds: [1.8, 2.4, 3.2],
    echoExpandSpeeds: [0.22, 0.16, 0.10],

    // --- Idle (BottomIdle) persistent visual state ---
    // The ring is ALWAYS visible at the bottom. These values describe
    // its appearance when no voice is present. Release animates TOWARD
    // these values, not toward zero.
    ringIdleVisibility: 0.32,
    ringIdleRadius: 0.82,
    ringIdleCoreIntensity: 0.0,
    ringIdleHaloIntensity: 0.10,
    // Idle breathing: subtle radius oscillation while waiting
    ringIdleBreathAmp: 0.055,
    ringIdleBreathSpeed: 0.48
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

        const yMin = -1.95;
        const yMax = 2.1;
        const gap = (yMax - yMin) / (VISUAL_SCENE_CONFIG.pitchBandCount - 1);
        const centers = [];
        const colors = [];

        for (let i = 0; i < VISUAL_SCENE_CONFIG.pitchBandCount; i++) {
            const t = i / (VISUAL_SCENE_CONFIG.pitchBandCount - 1);
            const col = this.colorForBand(t);
            centers.push(yMin + i * gap);
            colors.push(new THREE.Vector3(col.r, col.g, col.b));
        }

        const material = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.NormalBlending,
            uniforms: {
                uOpacity: { value: VISUAL_SCENE_CONFIG.bandOpacity },
                uCenters: { value: centers },
                uColors: { value: colors },
                uCount: { value: VISUAL_SCENE_CONFIG.pitchBandCount },
                uSoftness: { value: VISUAL_SCENE_CONFIG.bandSoftness },
                uDepthK: { value: VISUAL_SCENE_CONFIG.depthAttenuation }
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
                uniform float uCenters[7];
                uniform vec3 uColors[7];
                uniform int uCount;
                uniform float uSoftness;
                uniform float uDepthK;

                vec3 applySaturation(vec3 color, float sat) {
                    float l = dot(color, vec3(0.299, 0.587, 0.114));
                    return mix(vec3(l), color, sat);
                }

                void main() {
                    vec3 colorAccum = vec3(0.0);
                    float weightAccum = 0.0;

                    for (int i = 0; i < 7; i++) {
                        if (i >= uCount) { break; }
                        float dy = vWorldPos.y - uCenters[i];
                        float layer = exp(-(dy * dy) / max(uSoftness, 0.001));
                        colorAccum += uColors[i] * layer;
                        weightAccum += layer;
                    }

                    if (weightAccum < 0.0005) {
                        discard;
                    }

                    float distanceFactor = clamp(1.0 - vViewDepth * uDepthK, 0.2, 1.0);
                    float sideFalloff = exp(-pow(vWorldPos.x * 0.13, 2.0));
                    float verticalWindow = exp(-pow(vWorldPos.y * 0.22, 2.0));
                    float alpha = (weightAccum / float(max(uCount, 1))) * uOpacity * sideFalloff;
                    alpha *= mix(0.45, 1.0, verticalWindow);
                    alpha *= distanceFactor;

                    if (alpha < 0.003) {
                        discard;
                    }

                    vec3 color = colorAccum / weightAccum;
                    color = applySaturation(color, mix(0.45, 0.9, distanceFactor));
                    color *= mix(0.56, 0.95, distanceFactor);
                    gl_FragColor = vec4(color, min(alpha, 0.22));
                }
            `
        });

        const fogPlane = new THREE.Mesh(new THREE.PlaneGeometry(17.0, 10.5, 1, 1), material);
        fogPlane.position.set(0.0, 0.0, -3.6);
        this.group.add(fogPlane);

        const echoPlane = fogPlane.clone();
        echoPlane.material = material.clone();
        echoPlane.material.blending = THREE.AdditiveBlending;
        echoPlane.material.uniforms.uOpacity.value = VISUAL_SCENE_CONFIG.bandOpacity * 0.55;
        echoPlane.position.z = -4.2;
        this.group.add(echoPlane);
    }

    colorForBand(t) {
        const stops = [
            { t: 0.0, color: new THREE.Color(0x472733) },
            { t: 0.36, color: new THREE.Color(0x7d5331) },
            { t: 0.6, color: new THREE.Color(0x9d8449) },
            { t: 0.82, color: new THREE.Color(0x4a766f) },
            { t: 1.0, color: new THREE.Color(0x5e7f94) }
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

class StageBaseSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);

        const baseMaterial = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            uniforms: {
                uBaseColor: { value: new THREE.Color(0x121a25) },
                uRimColor: { value: new THREE.Color(0x263648) },
                uInnerFade: { value: 0.42 },
                uOuterFade: { value: 1.0 },
                uOpacity: { value: 0.42 }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv * 2.0 - 1.0;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uBaseColor;
                uniform vec3 uRimColor;
                uniform float uInnerFade;
                uniform float uOuterFade;
                uniform float uOpacity;
                void main() {
                    float r = length(vUv);
                    float body = 1.0 - smoothstep(uInnerFade, uOuterFade, r);
                    float rim = smoothstep(0.62, 0.95, r) * (1.0 - smoothstep(0.95, 1.05, r));
                    float alpha = body * uOpacity + rim * 0.14;
                    if (alpha < 0.01) discard;
                    vec3 color = mix(uBaseColor, uRimColor, rim * 0.75);
                    gl_FragColor = vec4(color, alpha);
                }
            `
        });

        const baseMesh = new THREE.Mesh(new THREE.CircleGeometry(4.3, 84), baseMaterial);
        baseMesh.rotation.x = -Math.PI / 2;
        baseMesh.scale.set(1.36, 1.0, 0.93);
        baseMesh.position.set(0, -1.88, -0.88);
        this.group.add(baseMesh);
    }

    update() {}
}

class LiveRingSystem {
    constructor(scene) {
        this.group = new THREE.Group();
        scene.add(this.group);
        this.isDebugView = Boolean(VISUAL_SCENE_CONFIG.DEBUG_VIEW);
        this.ringMaterials = [];
        this.liveRingMinRadius = VISUAL_SCENE_CONFIG.liveRingMinRadius;
        this.liveRingMaxRadius = VISUAL_SCENE_CONFIG.liveRingMaxRadius;
        this.liveRingMinSigma = VISUAL_SCENE_CONFIG.liveRingMinSigma;
        this.liveRingMaxSigma = VISUAL_SCENE_CONFIG.liveRingMaxSigma;
        this.liveRingCarrierSafetyMargin = VISUAL_SCENE_CONFIG.liveRingCarrierSafetyMargin;
        this.liveRingCarrierExtent = 0;
        // Idle (BottomIdle) is the DEFAULT state: ring is always visible at bottom.
        // Initialise both current and target to idle values so the ring is
        // visible from the very first frame — before any voice is ever detected.
        this.ringState = {
            y: VISUAL_SCENE_CONFIG.ringEntrySpawnY,
            radius: VISUAL_SCENE_CONFIG.ringIdleRadius,
            visibility: VISUAL_SCENE_CONFIG.ringIdleVisibility,
            coreIntensity: VISUAL_SCENE_CONFIG.ringIdleCoreIntensity,
            haloIntensity: VISUAL_SCENE_CONFIG.ringIdleHaloIntensity,
            thicknessEmphasis: 0,
            radiusEmphasis: 0,
            color: new THREE.Color(0xffa338)
        };
        this.targetState = {
            y: VISUAL_SCENE_CONFIG.ringEntrySpawnY,
            radius: VISUAL_SCENE_CONFIG.ringIdleRadius,
            visibility: VISUAL_SCENE_CONFIG.ringIdleVisibility,
            coreIntensity: VISUAL_SCENE_CONFIG.ringIdleCoreIntensity,
            haloIntensity: VISUAL_SCENE_CONFIG.ringIdleHaloIntensity,
            thicknessEmphasis: 0,
            radiusEmphasis: 0,
            color: new THREE.Color(0xffa338)
        };
        // 5-state machine: IDLE | ATTACK_FROM_BOTTOM | TRACKING | HOVER | RELEASE_FALL
        this.smState = 'IDLE';
        this.attackProgress = 0;
        this.attackStartY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
        this.attackTargetY = 0;
        this.releaseProgress = 0;
        this.releaseStartY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
        this.releaseStartRadius = 1.0;
        this.releaseStartVisibility = 0;
        this.releaseStartCoreIntensity = 0;
        this.releaseStartHaloIntensity = 0;
        this.releaseStartThicknessEmphasis = 0;
        this.releaseStartRadiusEmphasis = 0;
        // HOVER state
        this.hoverProgress = 0;
        this.hoverY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
        this.hoverStartVisibility = 0;
        this.hoverStartRadius = 1.0;
        // Ghost echo ring
        this.ghostY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
        this.ghostOpacity = 0;
        this.ghostRadius = 1.0;
        this.ghostColor = new THREE.Color(0xffa338);
        // Echo burst rings spawned on voice loss
        this.echoRings = [];  // [{y, radius, opacity, expandSpeed, fadeSpeed, color}]
        // Memory Y: where the ring last was — used for float release
        this.memoryY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
        this.memoryStartY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
        this.releaseFloatProgress = 0;
        this.releaseReturnProgress = 0;
        this.releaseFloatStartY = 0;
        this.releaseFloatStartVisibility = 0;
        this.displayY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
        // Pitch filter: 3-layer pipeline between raw detector and rendered position.
        // Layer 1 (_filterPitchY): outlier rejection, hysteresis, fast EMA → filteredY
        // Layer 2 (in setLiveState): slow EMA → targetY  (the "held note" concept)
        // Layer 3 (in setLiveState): velocity-capped EMA → displayY  (rendered position)
        this.pitchFilter = {
            filteredY: 0,
            targetY: VISUAL_SCENE_CONFIG.ringEntrySpawnY,
            seeded: false,
            outlierFrames: 0,
            pendingOutlierY: 0,
        };
        const baseDefinition = { y: -0.5, z: -0.72, r: 1.05, sigma: 0.032, coreOpacity: 0.92, haloOpacity: 0.46, color: 0xffa338 };
        const motion = {
            phase: 0.95,
            speed: VISUAL_SCENE_CONFIG.ringMotionSpeed,
            thicknessAmp: VISUAL_SCENE_CONFIG.ringThicknessMotion,
            luminanceAmp: VISUAL_SCENE_CONFIG.ringLuminanceMotion,
            radiusAmp: VISUAL_SCENE_CONFIG.ringRadiusMotion
        };
        this.applyDebugMotionScale(motion);
        this.group.add(this.createRing(baseDefinition, motion));
        this._createGhostRing(baseDefinition);
        this._createEchoRingPool(baseDefinition);
    }

    _createGhostRing(def) {
        const ghostGroup = new THREE.Group();
        ghostGroup.position.set(0, def.y, def.z);

        const ghostColor = new THREE.Color(def.color);
        const haloSigma = def.sigma * 7.5;
        const extent = def.r + haloSigma * 4.0 + this.liveRingCarrierSafetyMargin + 0.3;

        this.ghostMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: {
                uBaseColor:   { value: ghostColor.clone() },
                uRadius:      { value: def.r },
                uSigma:       { value: def.sigma * 2.2 },
                uOpacity:     { value: 0 },
                uTime:        { value: 0 },
            },
            vertexShader: `
                varying vec2 vLocal;
                void main() {
                    vLocal = position.xy;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                varying vec2 vLocal;
                uniform vec3  uBaseColor;
                uniform float uRadius;
                uniform float uSigma;
                uniform float uOpacity;
                uniform float uTime;
                void main() {
                    float d = length(vLocal);
                    float dist = abs(d - uRadius);
                    float profile = exp(-(dist * dist) / (2.0 * uSigma * uSigma));
                    if (profile < 0.003) discard;
                    float pulse = 0.85 + 0.15 * sin(uTime * 1.8);
                    gl_FragColor = vec4(uBaseColor * 0.6 * pulse, profile * uOpacity);
                }
            `
        });

        const ghostMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(extent * 2.0, extent * 2.0, 1, 1),
            this.ghostMat
        );
        ghostMesh.rotation.x = -Math.PI / 2;
        ghostGroup.add(ghostMesh);
        this.ghostGroup = ghostGroup;
        this.group.add(ghostGroup);
    }

    _createEchoRingPool(def) {
        const C = VISUAL_SCENE_CONFIG;
        if (!C.echoEnabled) return;
        this.echoMeshGroups = [];
        this.echoMats = [];
        const haloSigma = def.sigma * 7.5;
        const extent = def.r + haloSigma * 4.0 + this.liveRingCarrierSafetyMargin + 0.5;
        for (let i = 0; i < C.echoCount; i++) {
            const mat = new THREE.ShaderMaterial({
                transparent: true,
                depthWrite: false,
                depthTest: true,
                blending: THREE.AdditiveBlending,
                side: THREE.DoubleSide,
                uniforms: {
                    uBaseColor: { value: new THREE.Color(0xffa338) },
                    uRadius:    { value: def.r * 1.1 },
                    uSigma:     { value: def.sigma * 3.0 },
                    uOpacity:   { value: 0 },
                    uTime:      { value: 0 },
                },
                vertexShader: `
                    varying vec2 vLocal;
                    void main() {
                        vLocal = position.xy;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    varying vec2 vLocal;
                    uniform vec3  uBaseColor;
                    uniform float uRadius;
                    uniform float uSigma;
                    uniform float uOpacity;
                    uniform float uTime;
                    void main() {
                        float d = length(vLocal);
                        float dist = abs(d - uRadius);
                        float profile = exp(-(dist * dist) / (2.0 * uSigma * uSigma));
                        if (profile < 0.003) discard;
                        // Outer glow only — no inner fill
                        float outerOnly = (d >= uRadius) ? 1.0 : 0.55;
                        gl_FragColor = vec4(uBaseColor * 0.75, profile * uOpacity * outerOnly);
                    }
                `
            });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(extent * 2.0, extent * 2.0), mat);
            mesh.rotation.x = -Math.PI / 2;
            const grp = new THREE.Group();
            grp.add(mesh);
            grp.visible = false;
            this.group.add(grp);
            this.echoMeshGroups.push(grp);
            this.echoMats.push(mat);
        }
    }

    applyDebugMotionScale(motion) {
        if (!this.isDebugView) {
            return;
        }

        const boost = VISUAL_SCENE_CONFIG.debugMotionMultiplier;
        motion.thicknessAmp *= boost.thickness;
        motion.luminanceAmp *= boost.luminance;
        motion.radiusAmp *= boost.radius;
    }

    createRing(def, motion) {
        const group = new THREE.Group();
        group.position.set(0, def.y, def.z);

        const baseColor  = new THREE.Color(def.color);

        // Halo sigma is 7.5× the core — this wide ratio is what produces the
        // characteristic spill of colored light seen around each ring in the mockup.
        // Quad extent covers ring radius + 3.2 * sigma_halo so fragments at the
        // very edge of the bloom are still sampled before the discard threshold.
        const haloSigma = def.sigma * 7.5;
        const maxHaloSigma = this.liveRingMaxSigma * 7.5;
        const extent = Math.max(
            def.r + haloSigma * 4.0 + this.liveRingCarrierSafetyMargin,
            this.liveRingMaxRadius + maxHaloSigma * 4.0 + this.liveRingCarrierSafetyMargin
        );

        // -----------------------------------------------------------------
        // PASS 1 — CORE  (NormalBlending)
        //
        // Narrow Gaussian. Near-opaque at centerline.
        //
        // Depth model: exp(-viewZ * 0.042) — very gentle fade.
        //   At the camera distances used (viewZ 6–9), this gives dF 0.69–0.78.
        //   Rings dim slightly with depth but never desaturate. Saturation = 1.0
        //   everywhere — the mockup shows fully saturated cyan at the farthest ring.
        //
        // Luminance: baseColor * (0.70 + 0.30 * profile)
        //   Centerline gets full color, edge gets 70% — a gentle inner falloff
        //   that keeps the tube body bright without a hard boundary.
        // -----------------------------------------------------------------
        const coreMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.NormalBlending,
            side: THREE.DoubleSide,
            uniforms: {
                uBaseColor:  { value: baseColor.clone() },
                uRadius:     { value: def.r },
                uSigma:      { value: def.sigma },
                uMaxOpacity: { value: def.coreOpacity },
                uTime:       { value: 0 },
                uPhase:      { value: motion.phase },
                uSpeed:      { value: motion.speed },
                uThicknessAmp: { value: motion.thicknessAmp },
                uLuminanceAmp: { value: motion.luminanceAmp },
                uRadiusAmp:  { value: motion.radiusAmp },
            },
            vertexShader: `
                varying vec2  vLocal;
                varying float vViewZ;
                void main() {
                    vec4 world = modelMatrix * vec4(position, 1.0);
                    vec4 view  = viewMatrix * world;
                    vLocal = position.xy;
                    vViewZ = abs(view.z);
                    gl_Position = projectionMatrix * view;
                }
            `,
            fragmentShader: `
                varying vec2  vLocal;
                varying float vViewZ;
                uniform vec3  uBaseColor;
                uniform float uRadius;
                uniform float uSigma;
                uniform float uMaxOpacity;
                uniform float uTime;
                uniform float uPhase;
                uniform float uSpeed;
                uniform float uThicknessAmp;
                uniform float uLuminanceAmp;
                uniform float uRadiusAmp;

                void main() {
                    float t = uTime * uSpeed + uPhase;
                    float breath = sin(t);
                    float shimmer = sin(t * 1.31 + 0.7);
                    float drift = sin(t * 0.73 + 1.4);

                    float modSigma = uSigma * (1.0 + uThicknessAmp * breath);
                    float modRadius = uRadius * (1.0 + uRadiusAmp * drift);

                    float d       = length(vLocal);
                    float dist    = abs(d - modRadius);
                    float profile = exp(-(dist * dist) / (2.0 * modSigma * modSigma));

                    if (profile < 0.005) discard;

                    // Gentle depth fade — neon color and saturation never change.
                    float dF    = exp(-vViewZ * 0.042);
                    float alpha = profile * uMaxOpacity * dF;
                    alpha = min(alpha, 0.96);

                    float luminance = 1.0 + uLuminanceAmp * shimmer;
                    vec3 color = uBaseColor * (0.70 + 0.30 * profile) * luminance;

                    gl_FragColor = vec4(color, alpha);
                }
            `
        });

        const coreMesh = new THREE.Mesh(new THREE.PlaneGeometry(extent * 2.0, extent * 2.0, 1, 1), coreMat);
        coreMesh.rotation.x = -Math.PI / 2;
        group.add(coreMesh);
        this.ringMaterials.push(coreMat);

        // -----------------------------------------------------------------
        // PASS 2 — BLOOM HALO  (AdditiveBlending)
        //
        // sigma_halo = sigma_core * 7.5
        // This extreme ratio separates the bloom visually from the core,
        // producing the wide colored spill seen in the mockup — especially
        // visible at the bottom two rings where orange light pools broadly.
        //
        // Asymmetric falloff:
        //   signedDist >= 0 (outside ring) → full sigma_halo
        //   signedDist <  0 (inside ring)  → sigma_halo * 0.55
        // Glow radiates outward into open space more than inward.
        //
        // No alpha cap — additive blending accumulates luminance but
        // cannot exceed the display maximum, so capping is unnecessary.
        // -----------------------------------------------------------------
        const haloMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            uniforms: {
                uBaseColor:   { value: baseColor.clone() },
                uRadius:      { value: def.r },
                uHaloSigma:   { value: haloSigma },
                uHaloOpacity: { value: def.haloOpacity },
                uTime:        { value: 0 },
                uPhase:       { value: motion.phase + 0.18 },
                uSpeed:       { value: motion.speed * 0.95 },
                uThicknessAmp:{ value: motion.thicknessAmp * 0.55 },
                uLuminanceAmp:{ value: motion.luminanceAmp * 0.6 },
                uRadiusAmp:   { value: motion.radiusAmp * 0.8 },
            },
            vertexShader: `
                varying vec2  vLocal;
                varying float vViewZ;
                void main() {
                    vec4 world = modelMatrix * vec4(position, 1.0);
                    vec4 view  = viewMatrix * world;
                    vLocal = position.xy;
                    vViewZ = abs(view.z);
                    gl_Position = projectionMatrix * view;
                }
            `,
            fragmentShader: `
                varying vec2  vLocal;
                varying float vViewZ;
                uniform vec3  uBaseColor;
                uniform float uRadius;
                uniform float uHaloSigma;
                uniform float uHaloOpacity;
                uniform float uTime;
                uniform float uPhase;
                uniform float uSpeed;
                uniform float uThicknessAmp;
                uniform float uLuminanceAmp;
                uniform float uRadiusAmp;

                void main() {
                    float t = uTime * uSpeed + uPhase;
                    float breath = sin(t * 0.92);
                    float shimmer = sin(t * 1.17 + 0.4);
                    float drift = sin(t * 0.68 + 1.1);

                    float modSigmaBase = uHaloSigma * (1.0 + uThicknessAmp * breath);
                    float modRadius = uRadius * (1.0 + uRadiusAmp * drift);

                    float d          = length(vLocal);
                    float signedDist = d - modRadius;

                    // Asymmetric: outward = full sigma, inward = 55%
                    float sigma   = (signedDist >= 0.0) ? modSigmaBase : modSigmaBase * 0.55;
                    float profile = exp(-(signedDist * signedDist) / (2.0 * sigma * sigma));

                    if (profile < 0.003) discard;

                    float dF    = exp(-vViewZ * 0.042);
                    float alpha = profile * uHaloOpacity * dF;

                    // Halo color: same hue, slightly dimmer than core so the
                    // centerline still reads as the brightest point.
                    float luminance = 1.0 + uLuminanceAmp * shimmer;
                    vec3 color = uBaseColor * 0.85 * luminance;

                    gl_FragColor = vec4(color, alpha);
                }
            `
        });

        const haloMesh = new THREE.Mesh(new THREE.PlaneGeometry(extent * 2.0, extent * 2.0, 1, 1), haloMat);
        haloMesh.rotation.x = -Math.PI / 2;
        group.add(haloMesh);
        this.ringMaterials.push(haloMat);
        this.liveRingGroup = group;
        this.liveRingCoreMesh = coreMesh;
        this.liveRingHaloMesh = haloMesh;
        this.liveRingCarrierExtent = extent;
        this.coreMat = coreMat;
        this.haloMat = haloMat;
        this.base = {
            coreOpacity: def.coreOpacity,
            haloOpacity: def.haloOpacity,
            sigma: def.sigma,
            haloSigma,
            radius: def.r
        };

        return group;
    }

    clampLiveParams(radius, sigma, haloSigma, maxRadiusFactor = 1) {
        const factor = Math.max(1, maxRadiusFactor);
        const safeRadius = MathUtils.clamp(radius, this.liveRingMinRadius, this.liveRingMaxRadius / factor);
        const safeSigma = MathUtils.clamp(sigma, this.liveRingMinSigma, this.liveRingMaxSigma);
        const minHaloSigma = this.liveRingMinSigma * 7.5;
        const maxHaloSigma = this.liveRingMaxSigma * 7.5;
        const safeHaloSigma = MathUtils.clamp(haloSigma, minHaloSigma, maxHaloSigma);
        return { safeRadius, safeSigma, safeHaloSigma };
    }

    ensureLiveRingCarrierExtent(radius, haloSigma) {
        const requiredExtent = radius + haloSigma * 4.0 + this.liveRingCarrierSafetyMargin;
        if (requiredExtent <= this.liveRingCarrierExtent) {
            return;
        }

        const nextExtent = requiredExtent + this.liveRingCarrierSafetyMargin;
        const nextGeometry = new THREE.PlaneGeometry(nextExtent * 2.0, nextExtent * 2.0, 1, 1);
        this.liveRingCoreMesh.geometry.dispose();
        this.liveRingHaloMesh.geometry.dispose();
        this.liveRingCoreMesh.geometry = nextGeometry;
        this.liveRingHaloMesh.geometry = nextGeometry.clone();
        this.liveRingCarrierExtent = nextExtent;
    }

    smoothToward(current, target, speed, dt) {
        const alpha = 1 - Math.exp(-Math.max(0.001, speed) * Math.max(0, dt));
        return MathUtils.lerp(current, target, alpha);
    }

    /**
     * Layer 1 of the 3-layer pitch motion model: rawY → filteredY.
     *
     * Operates entirely in pitch space. Does NOT smooth the ring position —
     * that is handled by Layers 2 (targetY) and 3 (displayY) in setLiveState.
     *
     * Three sub-layers, evaluated in order:
     *   1. Outlier rejection  — single-frame spikes > 3 semitones from the
     *      current filtered pitch require `pitchOutlierConfirmFrames` frames
     *      of consistency before being accepted as a genuine jump.
     *   2. Hysteresis deadband — changes smaller than 1.0 semitone are
     *      suppressed. This silences most vibrato, intonation wobble, and
     *      detector noise before it reaches the rendering pipeline.
     *   3. EMA — genuine pitch movement is tracked with a time-constant
     *      set by pitchFilterEmaSpeed (now 10.0, slower than before).
     *
     * On voice onset the filter is unseeded; the first voiced frame seeds
     * it directly so there is zero onset lag.
     */
    _filterPitchY(rawY, dt) {
        const f = this.pitchFilter;
        const C = VISUAL_SCENE_CONFIG;
        const semiY = C.pitchSemitoneY;

        // --- First voiced frame: seed directly, zero lag ---
        if (!f.seeded) {
            f.filteredY = rawY;
            f.seeded = true;
            f.outlierFrames = 0;
            return rawY;
        }

        const jumpSemitones = Math.abs(rawY - f.filteredY) / semiY;

        // --- Layer 1: outlier rejection ---
        if (jumpSemitones > C.pitchOutlierSemitones) {
            // Is this the same outlier direction as last frame?
            const consistentWithPending = f.outlierFrames > 0
                && Math.abs(rawY - f.pendingOutlierY) / semiY < 2.0;

            if (!consistentWithPending) {
                // New or inconsistent spike — start fresh confirmation
                f.pendingOutlierY = rawY;
                f.outlierFrames = 1;
                return f.filteredY;   // reject
            }

            f.outlierFrames++;
            if (f.outlierFrames >= C.pitchOutlierConfirmFrames) {
                // Confirmed real jump — re-seed to avoid slow convergence
                f.filteredY = rawY;
                f.outlierFrames = 0;
                return f.filteredY;
            }
            return f.filteredY;       // still confirming, hold previous
        }

        f.outlierFrames = 0;

        // --- Layer 2: hysteresis deadband ---
        if (jumpSemitones < C.pitchHysteresisSemitones) {
            return f.filteredY;       // suppress micro-oscillation
        }

        // --- Layer 3: fast EMA ---
        const alpha = 1 - Math.exp(-C.pitchFilterEmaSpeed * Math.max(0, dt));
        f.filteredY += (rawY - f.filteredY) * alpha;
        return f.filteredY;
    }

    setLiveState(liveState = null, dt = 1 / 60, elapsed = 0) {
        const state = liveState || {};
        const voiced = Boolean(state.active);
        const spawnY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
        this._elapsed = elapsed; // store for IDLE breathing

        // ================================================================
        // STATE TRANSITIONS — voice presence drives all transitions.
        // No smoothing, no lingering, no stale data.
        // ================================================================

        switch (this.smState) {
            case 'IDLE':
                // -------------------------------------------------------
                // State A: BottomIdle — the ring's PERMANENT resting state.
                // Enforce idle visuals every frame so visibility can never
                // drift to zero here regardless of what entered this state.
                // This is not a "nothing is happening" state — the ring is
                // always visually present at the bottom.
                // -------------------------------------------------------
                {
                    const breathPhase = (this._elapsed || 0) * VISUAL_SCENE_CONFIG.ringIdleBreathSpeed;
                    const breath = Math.sin(breathPhase) * VISUAL_SCENE_CONFIG.ringIdleBreathAmp;
                    this.ringState.visibility       = VISUAL_SCENE_CONFIG.ringIdleVisibility;
                    this.ringState.radius           = VISUAL_SCENE_CONFIG.ringIdleRadius * (1 + breath);
                    this.ringState.coreIntensity    = VISUAL_SCENE_CONFIG.ringIdleCoreIntensity;
                    this.ringState.haloIntensity    = VISUAL_SCENE_CONFIG.ringIdleHaloIntensity + Math.max(0, breath * 0.5);
                    this.ringState.thicknessEmphasis = 0;
                    this.ringState.radiusEmphasis   = 0;
                    this.displayY = spawnY;

                    if (voiced) {
                        // → ATTACK_FROM_BOTTOM: rise from bottom toward the REAL note
                        this.smState = 'ATTACK_FROM_BOTTOM';
                        this.attackProgress = 0;
                        this.attackStartY = spawnY;
                        this.pitchFilter.seeded = false;  // force fresh seed
                        this.pitchFilter.outlierFrames = 0;
                        const seedY = this._filterPitchY(state.y ?? 0, dt);
                        this.attackTargetY = seedY;
                        // Seed targetY so Layer 2 doesn't start from a stale position
                        this.pitchFilter.targetY = seedY;
                        this.displayY = spawnY;
                    }
                }
                break;

            case 'ATTACK_FROM_BOTTOM':
                if (!voiced) {
                    // Voice lost during rise → set hoverY to current position and fall
                    this.hoverY = this.displayY;
                    this._enterRelease();
                } else {
                    // Filter the raw pitch — prevents target chatter during rise
                    this.attackTargetY = this._filterPitchY(state.y ?? this.attackTargetY, dt);
                    // Keep targetY aligned with the attack target so there is no
                    // discontinuity when we hand off to TRACKING's Layer 2.
                    this.pitchFilter.targetY = this.attackTargetY;
                    const duration = Math.max(0.05, VISUAL_SCENE_CONFIG.ringEntryDurationSeconds);
                    this.attackProgress = Math.min(1, this.attackProgress + dt / duration);
                    const eased = 1 - Math.pow(1 - this.attackProgress, 3);
                    this.displayY = MathUtils.lerp(this.attackStartY, this.attackTargetY, eased);
                    if (this.attackProgress >= 1) {
                        this.smState = 'TRACKING';
                    }
                }
                break;

            case 'TRACKING':
                if (!voiced) {
                    // Voice ended → enter HOVER: hold at current position briefly
                    this._enterHover();
                } else {
                    const C = VISUAL_SCENE_CONFIG;
                    // --- Layer 1: pitch filter (outlier rejection + hysteresis + EMA) ---
                    // filteredY represents "the note currently being sung", debounced.
                    const filteredY = this._filterPitchY(state.y ?? this.displayY, dt);

                    // --- Layer 2: targetY — slow "held note" EMA ---
                    // targetY trails filteredY with a longer time-constant so the
                    // rendered target is stable. Vibrato/wobble that slips through
                    // Layer 1 is further damped here. This is the key missing stage
                    // in the old model.
                    this.pitchFilter.targetY = this.smoothToward(
                        this.pitchFilter.targetY, filteredY, C.pitchTargetEmaSpeed, dt);

                    // --- Layer 3: displayY — velocity-capped render position ---
                    // EMA gives the desired position this frame; the velocity cap
                    // prevents any single frame from moving the ring more than
                    // ringYMaxSpeed * dt units, regardless of how far the target
                    // jumped. Large pitch changes animate fluidly; small changes
                    // (within the deadband) produce no visible movement at all.
                    const desired = this.smoothToward(
                        this.displayY, this.pitchFilter.targetY, C.ringYSmoothingSpeed, dt);
                    const maxStep = C.ringYMaxSpeed * dt;
                    const rawStep = desired - this.displayY;
                    this.displayY += MathUtils.clamp(rawStep, -maxStep, maxStep);
                    // Track last valid Y so HOVER can anchor here
                    this.hoverY = this.displayY;
                }
                break;

            case 'HOVER':
                // -------------------------------------------------------
                // State: HOVER — ring lingers at last note Y, fading
                // -------------------------------------------------------
                if (voiced) {
                    // Voice returned during hover → restart tracking from here
                    this.smState = 'ATTACK_FROM_BOTTOM';
                    this.attackProgress = 0;
                    this.attackStartY = this.displayY;
                    this.pitchFilter.seeded = false;
                    this.pitchFilter.outlierFrames = 0;
                    const seedY = this._filterPitchY(state.y ?? 0, dt);
                    this.attackTargetY = seedY;
                    this.pitchFilter.targetY = seedY;
                    this.ghostOpacity = 0;
                    this.echoRings = [];
                } else {
                    const hoverDuration = Math.max(0.2, VISUAL_SCENE_CONFIG.ringHoverDuration);
                    this.hoverProgress = Math.min(1, this.hoverProgress + dt / hoverDuration);
                    const eased = this.hoverProgress;
                    // Hold Y position exactly — no movement
                    this.displayY = this.hoverY;
                    // Fade visibility toward hover target
                    this.ringState.visibility = MathUtils.lerp(
                        this.hoverStartVisibility, VISUAL_SCENE_CONFIG.ringHoverVisibility, eased);
                    this.ringState.radius = MathUtils.lerp(
                        this.hoverStartRadius, VISUAL_SCENE_CONFIG.ringHoverRadius, eased * 0.5);
                    this.ringState.coreIntensity = MathUtils.lerp(this.releaseStartCoreIntensity, 0, eased);
                    this.ringState.haloIntensity = MathUtils.lerp(this.releaseStartHaloIntensity, 0, eased);
                    this.ringState.thicknessEmphasis = MathUtils.lerp(this.releaseStartThicknessEmphasis, 0, eased);
                    this.ringState.radiusEmphasis = MathUtils.lerp(this.releaseStartRadiusEmphasis, 0, eased);

                    if (this.hoverProgress >= 1) {
                        this._enterRelease();
                    }
                }
                break;

            case 'RELEASE_FALL':
                if (voiced) {
                    // New voice during release → fresh attack from current position
                    this.smState = 'ATTACK_FROM_BOTTOM';
                    this.attackProgress = 0;
                    this.attackStartY = this.displayY;
                    this.pitchFilter.seeded = false;  // force fresh seed
                    this.pitchFilter.outlierFrames = 0;
                    const seedY = this._filterPitchY(state.y ?? 0, dt);
                    this.attackTargetY = seedY;
                    // Seed targetY so Layer 2 has a clean starting point
                    this.pitchFilter.targetY = seedY;
                    this.ghostOpacity = 0;
                    this.echoRings = [];
                } else {
                    // -------------------------------------------------------
                    // State D: RELEASE_FLOAT (two phases)
                    //
                    // Phase 1 (releaseFloatDuration): ring stays near last-note Y,
                    //   drifts gently upward by releaseFloatRise, fades to near 0.
                    // Phase 2 (releaseReturnDuration): ring drifts from float
                    //   endpoint back to spawnY while fading in to idle visibility.
                    // This eliminates the jarring bottom-drop.
                    // -------------------------------------------------------
                    const C = VISUAL_SCENE_CONFIG;
                    const floatDur  = Math.max(0.1, C.releaseFloatDuration);
                    const returnDur = Math.max(0.1, C.releaseReturnDuration);
                    const totalDur  = floatDur + returnDur;
                    const totalProg = Math.min(1, this.releaseProgress + dt / totalDur);
                    this.releaseProgress = totalProg;

                    if (totalProg <= floatDur / totalDur) {
                        // --- Phase 1: float at last-note Y, drift up, fade out ---
                        const p = MathUtils.clamp(totalProg / (floatDur / totalDur), 0, 1);
                        const eased = 1 - Math.pow(1 - p, 2);
                        this.displayY = this.releaseStartY + C.releaseFloatRise * eased;
                        this.ringState.visibility = MathUtils.lerp(
                            this.releaseStartVisibility, 0.04, eased);
                        this.ringState.radius = MathUtils.lerp(
                            this.releaseStartRadius, C.ringIdleRadius * 0.92, eased);
                        this.ringState.coreIntensity = MathUtils.lerp(
                            this.releaseStartCoreIntensity, 0, eased);
                        this.ringState.haloIntensity = MathUtils.lerp(
                            this.releaseStartHaloIntensity, 0, eased);
                        this.ringState.thicknessEmphasis = MathUtils.lerp(
                            this.releaseStartThicknessEmphasis, 0, eased);
                        this.ringState.radiusEmphasis = MathUtils.lerp(
                            this.releaseStartRadiusEmphasis, 0, eased);
                    } else {
                        // --- Phase 2: drift back to idle Y, fade to idle visibility ---
                        const p2Start = floatDur / totalDur;
                        const p = MathUtils.clamp((totalProg - p2Start) / (1 - p2Start), 0, 1);
                        const eased = p < 0.5
                            ? 2 * p * p
                            : 1 - Math.pow(-2 * p + 2, 2) / 2; // ease-in-out quad
                        const floatTopY = this.releaseStartY + C.releaseFloatRise;
                        this.displayY = MathUtils.lerp(floatTopY, spawnY, eased);
                        this.ringState.visibility = MathUtils.lerp(0.04, C.ringIdleVisibility, eased);
                        this.ringState.radius = MathUtils.lerp(C.ringIdleRadius * 0.92, C.ringIdleRadius, eased);
                        this.ringState.coreIntensity    = C.ringIdleCoreIntensity;
                        this.ringState.haloIntensity    = C.ringIdleHaloIntensity * (0.5 + 0.5 * eased);
                        this.ringState.thicknessEmphasis = 0;
                        this.ringState.radiusEmphasis    = 0;
                    }

                    if (this.releaseProgress >= 1) {
                        this.smState = 'IDLE';
                        this.displayY = spawnY;
                        this.ringState.visibility       = C.ringIdleVisibility;
                        this.ringState.radius           = C.ringIdleRadius;
                        this.ringState.coreIntensity    = C.ringIdleCoreIntensity;
                        this.ringState.haloIntensity    = C.ringIdleHaloIntensity;
                        this.ringState.thicknessEmphasis = 0;
                        this.ringState.radiusEmphasis   = 0;
                    }
                }
                break;
        }

        // ================================================================
        // SMOOTH VISUAL PROPERTIES (only when NOT in release — release
        // drives its own interpolation above)
        // ================================================================
        if (this.smState !== 'RELEASE_FALL' && this.smState !== 'IDLE' && this.smState !== 'HOVER') {
            this.targetState.radius = state.radius ?? this.targetState.radius;
            this.targetState.visibility = state.visibility ?? this.targetState.visibility;
            this.targetState.coreIntensity = state.coreIntensity ?? this.targetState.coreIntensity;
            this.targetState.haloIntensity = state.haloIntensity ?? this.targetState.haloIntensity;
            this.targetState.thicknessEmphasis = state.thicknessEmphasis ?? this.targetState.thicknessEmphasis;
            this.targetState.radiusEmphasis = state.radiusEmphasis ?? this.targetState.radiusEmphasis;

            this.ringState.radius = this.smoothToward(this.ringState.radius, this.targetState.radius, VISUAL_SCENE_CONFIG.ringRadiusSmoothingSpeed, dt);
            const visibilitySpeed = this.targetState.visibility > this.ringState.visibility
                ? VISUAL_SCENE_CONFIG.ringVisibilityAttackSpeed
                : VISUAL_SCENE_CONFIG.ringVisibilityReleaseSpeed;
            this.ringState.visibility = this.smoothToward(this.ringState.visibility, this.targetState.visibility, visibilitySpeed, dt);
            this.ringState.coreIntensity = this.smoothToward(this.ringState.coreIntensity, this.targetState.coreIntensity, VISUAL_SCENE_CONFIG.ringStateSmoothingSpeed, dt);
            this.ringState.haloIntensity = this.smoothToward(this.ringState.haloIntensity, this.targetState.haloIntensity, VISUAL_SCENE_CONFIG.ringStateSmoothingSpeed, dt);
            this.ringState.thicknessEmphasis = this.smoothToward(this.ringState.thicknessEmphasis, this.targetState.thicknessEmphasis, VISUAL_SCENE_CONFIG.ringStateSmoothingSpeed, dt);
            this.ringState.radiusEmphasis = this.smoothToward(this.ringState.radiusEmphasis, this.targetState.radiusEmphasis, VISUAL_SCENE_CONFIG.ringStateSmoothingSpeed, dt);
        }

        // Commit Y position
        this.ringState.y = this.displayY;

        // Color tracking (always)
        if (state.color) {
            this.ringState.color.lerp(state.color, 0.18);
            this.targetState.color.copy(state.color);
        }
    }

    _enterHover() {
        this.smState = 'HOVER';
        this.hoverProgress = 0;
        // hoverY was updated every TRACKING frame — it holds the last note position
        this.displayY = this.hoverY;
        this.hoverStartVisibility = this.ringState.visibility;
        this.hoverStartRadius = this.ringState.radius;
        // Snapshot release-start values for intensity interpolation
        this.releaseStartCoreIntensity = this.ringState.coreIntensity;
        this.releaseStartHaloIntensity = this.ringState.haloIntensity;
        this.releaseStartThicknessEmphasis = this.ringState.thicknessEmphasis;
        this.releaseStartRadiusEmphasis = this.ringState.radiusEmphasis;
        // Freeze pitch filter — next onset seeds fresh
        this.pitchFilter.seeded = false;
        this.pitchFilter.outlierFrames = 0;
        // Spawn ghost at this position
        this.ghostY = this.hoverY;
        this.ghostOpacity = 0.55;
        this.ghostRadius = this.ringState.radius;
        this.ghostColor.copy(this.ringState.color);
    }

    _enterRelease() {
        this.smState = 'RELEASE_FALL';
        this.releaseProgress = 0;
        // Start float from the hover hold position
        this.releaseStartY = this.hoverY;
        this.displayY = this.hoverY;
        this.releaseStartRadius = this.ringState.radius;
        this.releaseStartVisibility = this.ringState.visibility;
        this.releaseStartCoreIntensity = this.ringState.coreIntensity;
        this.releaseStartHaloIntensity = this.ringState.haloIntensity;
        this.releaseStartThicknessEmphasis = this.ringState.thicknessEmphasis;
        this.releaseStartRadiusEmphasis = this.ringState.radiusEmphasis;
        // Spawn echo burst rings at hover position
        this._spawnEchoBurst();
        // Reset pitch filter completely — next onset must seed fresh.
        this.pitchFilter.seeded = false;
        this.pitchFilter.outlierFrames = 0;
        this.pitchFilter.targetY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
    }

    _spawnEchoBurst() {
        if (!VISUAL_SCENE_CONFIG.echoEnabled) return;
        const C = VISUAL_SCENE_CONFIG;
        this.echoRings = [];
        const baseRadius = this.ringState.radius;
        for (let i = 0; i < C.echoCount; i++) {
            this.echoRings.push({
                y: this.hoverY,
                radius: baseRadius * (C.echoSpawnRadius[i] ?? (0.9 + i * 0.25)),
                opacity: 0.28 - i * 0.07,
                expandSpeed: C.echoExpandSpeeds[i] ?? 0.15,
                fadeSpeed: C.echoFadeSpeeds[i] ?? 2.0,
                color: this.ringState.color.clone()
            });
        }
    }

    update(timeSeconds = 0, liveState = null, dt = 1 / 60) {
        for (const material of this.ringMaterials) {
            material.uniforms.uTime.value = timeSeconds;
        }

        this.setLiveState(liveState, dt, timeSeconds);

        const visible = MathUtils.clamp(this.ringState.visibility, 0, 1);
        // The ring is ALWAYS present — it is never hidden. The idle state
        // keeps visibility at ringIdleVisibility (not zero), so this group
        // is always visible. Opacity/opacity uniforms handle appearance.
        this.liveRingGroup.visible = true;
        this.liveRingGroup.position.y = this.ringState.y;

        const liveRadiusRaw = this.base.radius * this.ringState.radius;
        const coreSigmaRaw = this.base.sigma * VISUAL_SCENE_CONFIG.ringThickness * (1 + this.ringState.thicknessEmphasis);
        const haloSigmaRaw = this.base.haloSigma * VISUAL_SCENE_CONFIG.ringThickness * (1 + this.ringState.thicknessEmphasis * 0.7);
        const radiusCoreFactor = 1 + this.ringState.radiusEmphasis;
        const radiusHaloFactor = 1 + this.ringState.radiusEmphasis * 0.85;
        const maxRadiusFactor = Math.max(radiusCoreFactor, radiusHaloFactor);
        const { safeRadius, safeSigma, safeHaloSigma } = this.clampLiveParams(liveRadiusRaw, coreSigmaRaw, haloSigmaRaw, maxRadiusFactor);
        this.ensureLiveRingCarrierExtent(safeRadius * maxRadiusFactor, safeHaloSigma);

        this.coreMat.uniforms.uBaseColor.value.copy(this.ringState.color);
        this.haloMat.uniforms.uBaseColor.value.copy(this.ringState.color);
        this.coreMat.uniforms.uMaxOpacity.value = this.base.coreOpacity * VISUAL_SCENE_CONFIG.ringOpacity * visible * (1 + this.ringState.coreIntensity * 1.35);
        this.haloMat.uniforms.uHaloOpacity.value = this.base.haloOpacity * VISUAL_SCENE_CONFIG.ringGlow * visible * (1 + this.ringState.haloIntensity * 1.9);
        this.coreMat.uniforms.uSigma.value = safeSigma;
        this.haloMat.uniforms.uHaloSigma.value = safeHaloSigma;
        this.coreMat.uniforms.uRadius.value = safeRadius * radiusCoreFactor;
        this.haloMat.uniforms.uRadius.value = safeRadius * radiusHaloFactor;

        // --- Ghost ring: fade out over time, stays at hoverY ---
        if (VISUAL_SCENE_CONFIG.ghostRingEnabled && this.ghostGroup) {
            const fadeSpeed = VISUAL_SCENE_CONFIG.ghostRingFadeSpeed;
            this.ghostOpacity = Math.max(0, this.ghostOpacity - dt * fadeSpeed *
                (this.smState === 'HOVER' ? 0.15 : 1.0));
            this.ghostGroup.position.y = this.ghostY;
            this.ghostMat.uniforms.uOpacity.value = this.ghostOpacity;
            this.ghostMat.uniforms.uBaseColor.value.copy(this.ghostColor);
            this.ghostMat.uniforms.uRadius.value = this.base.radius * this.ghostRadius;
            this.ghostMat.uniforms.uTime.value = timeSeconds;
            this.ghostGroup.visible = this.ghostOpacity > 0.005;
        }

        // --- Echo burst rings: expand outward and fade ---
        if (VISUAL_SCENE_CONFIG.echoEnabled && this.echoMeshGroups) {
            for (let i = 0; i < this.echoMeshGroups.length; i++) {
                const grp = this.echoMeshGroups[i];
                const mat = this.echoMats[i];
                const echo = this.echoRings[i];
                if (!echo || echo.opacity <= 0.002) {
                    grp.visible = false;
                    continue;
                }
                echo.radius += echo.expandSpeed * dt;
                echo.opacity = Math.max(0, echo.opacity - echo.fadeSpeed * dt);
                grp.position.y = echo.y;
                grp.visible = true;
                mat.uniforms.uRadius.value = this.base.radius * echo.radius;
                mat.uniforms.uOpacity.value = echo.opacity;
                mat.uniforms.uBaseColor.value.copy(echo.color);
                mat.uniforms.uTime.value = timeSeconds;
            }
        }
    }

    colorForPitchNorm(pitchNorm) {
        const t = MathUtils.clamp(pitchNorm, 0, 1);
        const stops = [
            { t: 0.0, color: new THREE.Color(0xff5a33) },
            { t: 0.45, color: new THREE.Color(0xffc84a) },
            { t: 0.68, color: new THREE.Color(0x8fbf5b) },
            { t: 1.0, color: new THREE.Color(0x36b7d9) }
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

    mapLiveRingState(audioState) {
        if (!audioState) {
            // active:false → setLiveState routes to IDLE/RELEASE_FALL.
            // Neither state reads state.visibility — IDLE enforces its own
            // persistent idle visuals. visibility:0 here is a dead value.
            return { active: false, visibility: 0 };
        }

        // --- Voice gate: use RAW (unsmoothed) values for instant on/off ---
        const rawPitchNorm = audioState.rawPitchNorm ?? -1;
        const rawPitchConf = MathUtils.clamp(audioState.rawPitchConf ?? 0, 0, 1);
        const rawLoudNorm  = MathUtils.clamp(audioState.rawLoudNorm ?? 0, 0, 1);

        const confFloor = VISUAL_SCENE_CONFIG.ringActivationPitchConfFloor;
        const rawConfGate = Math.max(0, (rawPitchConf - confFloor) / (1 - confFloor));
        const rawActivateScore = rawConfGate * 0.8 + rawLoudNorm * 0.2;

        const minPitchConf = VISUAL_SCENE_CONFIG.ringReactivationMinPitchConf;
        const minLoudness  = VISUAL_SCENE_CONFIG.ringReactivationMinLoudness;
        const onThreshold  = VISUAL_SCENE_CONFIG.ringReactivationOnThreshold;

        const hasVoice = rawActivateScore >= onThreshold
                      && rawPitchConf >= minPitchConf
                      && rawLoudNorm >= minLoudness
                      && rawPitchNorm >= 0;

        if (!hasVoice) {
            // Same note as above: active:false means setLiveState never reads
            // state.visibility. Idle visuals are owned by the IDLE state case.
            return { active: false, visibility: 0 };
        }

        // --- Position: use RAW pitchNorm so frame-1 target is the real note ---
        const pitchNorm = MathUtils.clamp(rawPitchNorm, 0, 1);

        // --- Visual properties: use smoothed values for cosmetic smoothness ---
        const loudNorm = MathUtils.clamp(audioState.loudNorm ?? 0, 0, 1);
        const onset = MathUtils.clamp(
            Math.max(audioState.transientFlash ?? 0, audioState.onset ?? 0), 0, 1);
        const centroidNorm = MathUtils.clamp(audioState.centroidNorm ?? 0.5, 0, 1);
        const smoothPitchConf = MathUtils.clamp(audioState.pitchConf ?? 0, 0, 1);
        const smoothConfGate = Math.max(0, (smoothPitchConf - confFloor) / (1 - confFloor));

        const timbreTilt = (centroidNorm - 0.5) * 0.08;
        return {
            active: true,
            y: -1.45 + pitchNorm * 3.05,
            radius: MathUtils.clamp(0.72 + loudNorm * 1.18 + onset * 0.09, this.liveRingMinRadius, this.liveRingMaxRadius),
            visibility: MathUtils.clamp(smoothConfGate * 0.92 + loudNorm * 0.08, 0, 1),
            coreIntensity: MathUtils.clamp(loudNorm * 0.82 + onset * 0.65, 0, 1.5),
            haloIntensity: MathUtils.clamp(loudNorm * 0.74 + onset * 0.7, 0, 1.5),
            thicknessEmphasis: MathUtils.clamp(smoothConfGate * 0.12 + onset * 0.16, 0, 0.35),
            radiusEmphasis: MathUtils.clamp(loudNorm * 0.08 + onset * 0.1, 0, 0.25),
            color: this.colorForPitchNorm(MathUtils.clamp(pitchNorm + timbreTilt, 0, 1))
        };
    }
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
                uOpacity: { value: Math.min(0.09, VISUAL_SCENE_CONFIG.axisOpacity) }
            },
            vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `
                varying vec3 vPos;
                uniform vec3 uCore;
                uniform vec3 uHalo;
                uniform float uOpacity;
                void main(){
                    float r = length(vPos.xz);
                    float yFade = smoothstep(1.2, 0.2, abs(vPos.y));
                    float core = exp(-pow(r * 36.0, 2.0));
                    float halo = exp(-pow(r * 12.5, 2.0));
                    float alpha = (core * 0.45 + halo * 0.16) * yFade * uOpacity;
                    vec3 col = mix(uHalo, uCore, core);
                    gl_FragColor = vec4(col, alpha);
                }
            `
        });

        const axisMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.008, VISUAL_SCENE_CONFIG.axisHeight * 0.72, 20, 1, true), axisMat);
        axisMesh.position.y = 0.05;
        this.group.add(axisMesh);
    }

    update() {}
}

class CameraSystem {
    constructor(camera) {
        this.camera = camera;
        this.target = new THREE.Vector3(0, -0.06, -0.42);
        this.apply();
    }

    apply() {
        this.camera.position.set(0, 1.84, VISUAL_SCENE_CONFIG.cameraDistance);
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

        this.clock = new THREE.Clock();
        this.debugView = Boolean(VISUAL_SCENE_CONFIG.DEBUG_VIEW);
        this.orbitControls = null;
        this.lastDebugLogTime = -Infinity;
        this.debugLabel = document.getElementById('debug-camera-label');
        this.lastReactiveLogTime = -Infinity;

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
            rings: new LiveRingSystem(this.scene),
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
            if (this.orbitControls) {
                this.orbitControls.update();
            }
            this.renderFrame();
        });
    }

    setupDebugControls() {
        if (!this.debugView || !THREE.OrbitControls) {
            this.systems.camera.apply();
            return;
        }

        this.orbitControls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.orbitControls.enableRotate = true;
        this.orbitControls.enableZoom = true;
        this.orbitControls.enablePan = false;
        this.orbitControls.target.copy(this.systems.camera.target);
        this.orbitControls.minDistance = 3.2;
        this.orbitControls.maxDistance = 14.0;
        this.orbitControls.rotateSpeed = 0.8;
        this.orbitControls.zoomSpeed = 0.9;
        this.orbitControls.update();
    }

    setupDebugLabel() {
        if (!this.debugLabel) {
            return;
        }
        this.debugLabel.style.display = this.debugView ? 'block' : 'none';
    }

    debugAnimationProbe(elapsed) {
        if (!this.debugView || elapsed - this.lastDebugLogTime < 1) {
            return;
        }

        const sampleMaterial = this.systems?.rings?.ringMaterials?.[0];
        if (!sampleMaterial) {
            return;
        }

        const uniforms = sampleMaterial.uniforms;
        const t = elapsed * uniforms.uSpeed.value + uniforms.uPhase.value;
        const radiusAnimated = uniforms.uRadius.value * (1 + uniforms.uRadiusAmp.value * Math.sin(t * 0.73 + 1.4));
        console.debug(`[DEBUG_VIEW] t=${elapsed.toFixed(2)}s ring0Radius=${radiusAnimated.toFixed(4)}`);
        this.lastDebugLogTime = elapsed;
    }

    renderFrame() {
        const dt = this.clock.getDelta();
        const elapsed = this.clock.elapsedTime;
        if (this.audio?.updateTime) {
            this.audio.updateTime(dt);
        }
        const sm = this.audio?.smoothed || null;
        const raw = this.audio?.state || null;

        // Raw pitch/conf for instant voice gating and Y-position;
        // smoothed values only for visual properties (radius, intensity).
        const rawPitch = raw?.pitch ?? 0;
        const rawPitchConf = raw?.pitchConf ?? 0;
        const rawLoudness = raw?.loudness ?? -80;
        const rawLoudNorm = MathUtils.clamp((rawLoudness + 58) / 38, 0, 1);
        const rawPitchNorm = (rawPitch > 40)
            ? MathUtils.clamp(
                (Math.log(MathUtils.clamp(rawPitch, 80, 1500)) - Math.log(80))
                / (Math.log(1500) - Math.log(80)), 0, 1)
            : -1;  // sentinel: no valid pitch

        const liveState = this.systems.rings.mapLiveRingState({
            rawPitchNorm,
            rawPitchConf,
            rawLoudNorm,
            pitchNorm: sm?.pitchNorm ?? 0,
            loudNorm: sm?.loudNorm ?? 0,
            pitchConf: sm?.pitchConf ?? 0,
            onset: sm?.onset ?? 0,
            transientFlash: this.audio?.transientFlash ?? 0,
            centroidNorm: sm?.centroidNorm ?? 0.5
        });
        if (this.orbitControls) {
            this.orbitControls.update();
        }
        Object.entries(this.systems).forEach(([key, system]) => {
            if (key === 'rings') {
                system.update(elapsed, liveState, dt);
                return;
            }
            system.update(elapsed);
        });
        this.debugReactiveProbe(elapsed, sm, liveState);
        this.debugAnimationProbe(elapsed);
        this.renderer.render(this.scene, this.camera);
    }

    debugReactiveProbe(elapsed, smoothedAudio, liveState) {
        if (elapsed - this.lastReactiveLogTime < 1) {
            return;
        }
        const pitchNorm = smoothedAudio?.pitchNorm ?? 0;
        const stateLog = {
            y: Number((liveState?.y ?? 0).toFixed(3)),
            radius: Number((liveState?.radius ?? 0).toFixed(3)),
            visibility: Number((liveState?.visibility ?? 0).toFixed(3))
        };
        console.debug(`[LiveRingMap] pitchNorm=${pitchNorm.toFixed(3)} state=${JSON.stringify(stateLog)}`);
        this.lastReactiveLogTime = elapsed;
    }

    animate() {
        this.renderFrame();
        requestAnimationFrame(() => this.animate());
    }
}

window.VisualizerEngine = VisualizerEngine;
