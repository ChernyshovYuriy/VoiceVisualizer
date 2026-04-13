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
    ringAttackYSpeed: 18.0,
    ringTrackingYSpeed: 15.0,
    ringReleaseFallSpeed: 17.0,
    ringRadiusSmoothingSpeed: 10.0,
    ringVisibilityAttackSpeed: 11.5,
    ringVisibilityReleaseSpeed: 8.0,
    ringStateSmoothingSpeed: 8.0,
    ringEntrySpawnY: -1.88,
    ringReactivationOnThreshold: 0.26,
    ringReactivationOffThreshold: 0.13,
    ringReactivationMinPitchConf: 0.2,
    ringReactivationMinLoudness: 0.04,
    ringVoicedMinPitchHz: 65,
    ringVoicedMaxPitchHz: 1300,
    ringVoicedMinStability: 0.18,
    ringAttackSettleDistance: 0.045
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
        this.ringState = {
            y: -0.5,
            radius: 1.0,
            visibility: 0,
            coreIntensity: 0,
            haloIntensity: 0,
            thicknessEmphasis: 0,
            radiusEmphasis: 0,
            color: new THREE.Color(0xffa338)
        };
        this.targetState = {
            y: -0.5,
            radius: 1.0,
            visibility: 0,
            coreIntensity: 0,
            haloIntensity: 0,
            thicknessEmphasis: 0,
            radiusEmphasis: 0,
            color: new THREE.Color(0xffa338)
        };
        this.lastActiveTime = -Infinity;
        this.ringLifecycleState = 'IDLE/FALLEN';
        this.targetPitchY = -0.5;
        this.displayY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
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

    transitionToAttack(liveInput) {
        this.ringLifecycleState = 'ATTACK_FROM_BOTTOM';
        this.displayY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
        this.targetPitchY = liveInput.y;
        this.ringState.y = this.displayY;
        this.ringState.visibility = 0;
        this.targetState.visibility = Math.max(0.82, liveInput.visibility ?? 0.9);
    }

    transitionToRelease() {
        if (this.ringLifecycleState === 'IDLE/FALLEN' || this.ringLifecycleState === 'RELEASE_FALL') {
            return;
        }
        this.ringLifecycleState = 'RELEASE_FALL';
    }

    setLiveState(liveState = null, dt = 1 / 60, elapsed = 0) {
        const state = liveState || {};
        const voiced = Boolean(state.voiced);

        if (voiced) {
            this.targetPitchY = state.y ?? this.targetPitchY;
            this.targetState.radius = state.radius ?? this.targetState.radius;
            this.targetState.visibility = state.visibility ?? this.targetState.visibility;
            this.targetState.coreIntensity = state.coreIntensity ?? this.targetState.coreIntensity;
            this.targetState.haloIntensity = state.haloIntensity ?? this.targetState.haloIntensity;
            this.targetState.thicknessEmphasis = state.thicknessEmphasis ?? this.targetState.thicknessEmphasis;
            this.targetState.radiusEmphasis = state.radiusEmphasis ?? this.targetState.radiusEmphasis;
            this.lastActiveTime = elapsed;

            if (this.ringLifecycleState === 'IDLE/FALLEN' || this.ringLifecycleState === 'RELEASE_FALL') {
                this.transitionToAttack(state);
            } else if (this.ringLifecycleState !== 'ATTACK_FROM_BOTTOM') {
                this.ringLifecycleState = 'TRACKING_LIVE_NOTE';
            }
        } else {
            this.transitionToRelease();
            this.targetState.visibility = 0;
            this.targetState.coreIntensity = 0;
            this.targetState.haloIntensity = 0;
            this.targetState.thicknessEmphasis = 0;
            this.targetState.radiusEmphasis = 0;
        }

        const visibilitySpeed = this.targetState.visibility > this.ringState.visibility
            ? VISUAL_SCENE_CONFIG.ringVisibilityAttackSpeed
            : VISUAL_SCENE_CONFIG.ringVisibilityReleaseSpeed;
        this.ringState.radius = this.smoothToward(this.ringState.radius, this.targetState.radius, VISUAL_SCENE_CONFIG.ringRadiusSmoothingSpeed, dt);
        this.ringState.visibility = this.smoothToward(this.ringState.visibility, this.targetState.visibility, visibilitySpeed, dt);
        this.ringState.coreIntensity = this.smoothToward(this.ringState.coreIntensity, this.targetState.coreIntensity, VISUAL_SCENE_CONFIG.ringStateSmoothingSpeed, dt);
        this.ringState.haloIntensity = this.smoothToward(this.ringState.haloIntensity, this.targetState.haloIntensity, VISUAL_SCENE_CONFIG.ringStateSmoothingSpeed, dt);
        this.ringState.thicknessEmphasis = this.smoothToward(this.ringState.thicknessEmphasis, this.targetState.thicknessEmphasis, VISUAL_SCENE_CONFIG.ringStateSmoothingSpeed, dt);
        this.ringState.radiusEmphasis = this.smoothToward(this.ringState.radiusEmphasis, this.targetState.radiusEmphasis, VISUAL_SCENE_CONFIG.ringStateSmoothingSpeed, dt);

        if (this.ringLifecycleState === 'ATTACK_FROM_BOTTOM') {
            this.displayY = this.smoothToward(this.displayY, this.targetPitchY, VISUAL_SCENE_CONFIG.ringAttackYSpeed, dt);
            if (Math.abs(this.displayY - this.targetPitchY) <= VISUAL_SCENE_CONFIG.ringAttackSettleDistance) {
                this.ringLifecycleState = 'TRACKING_LIVE_NOTE';
            }
        } else if (this.ringLifecycleState === 'TRACKING_LIVE_NOTE') {
            this.displayY = this.smoothToward(this.displayY, this.targetPitchY, VISUAL_SCENE_CONFIG.ringTrackingYSpeed, dt);
        } else if (this.ringLifecycleState === 'RELEASE_FALL') {
            this.displayY = this.smoothToward(this.displayY, VISUAL_SCENE_CONFIG.ringEntrySpawnY, VISUAL_SCENE_CONFIG.ringReleaseFallSpeed, dt);
            const closeToBase = Math.abs(this.displayY - VISUAL_SCENE_CONFIG.ringEntrySpawnY) <= 0.02;
            if (closeToBase && this.ringState.visibility < 0.01) {
                this.ringLifecycleState = 'IDLE/FALLEN';
                this.displayY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
                this.ringState.visibility = 0;
            }
        } else {
            this.displayY = VISUAL_SCENE_CONFIG.ringEntrySpawnY;
            this.ringState.visibility = 0;
        }

        this.ringState.y = this.displayY;
        if (state.color) {
            this.ringState.color.lerp(state.color, 0.18);
            this.targetState.color.copy(state.color);
        }
    }

    update(timeSeconds = 0, liveState = null, dt = 1 / 60) {
        for (const material of this.ringMaterials) {
            material.uniforms.uTime.value = timeSeconds;
        }

        this.setLiveState(liveState, dt, timeSeconds);

        const visible = MathUtils.clamp(this.ringState.visibility, 0, 1);
        this.liveRingGroup.visible = visible > 0.01;
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
            return { voiced: false, visibility: 0 };
        }

        const pitchHz = Math.max(0, audioState.pitchHz ?? 0);
        const pitchConf = MathUtils.clamp(audioState.pitchConf ?? 0, 0, 1);
        const loudNorm = MathUtils.clamp(audioState.loudNorm ?? 0, 0, 1);
        const loudNormRaw = MathUtils.clamp(audioState.loudNormRaw ?? loudNorm, 0, 1);
        const notePresent = Boolean(audioState.note && audioState.note !== '—');
        const minPitch = VISUAL_SCENE_CONFIG.ringVoicedMinPitchHz;
        const maxPitch = VISUAL_SCENE_CONFIG.ringVoicedMaxPitchHz;
        const pitchInRange = pitchHz >= minPitch && pitchHz <= maxPitch;
        const stability = MathUtils.clamp(audioState.stability ?? 0, 0, 1);
        const onset = MathUtils.clamp(Math.max(audioState.transientFlash ?? 0, audioState.onset ?? 0), 0, 1);
        const centroidNorm = MathUtils.clamp(audioState.centroidNorm ?? 0.5, 0, 1);

        const confidenceGate = Math.max(0, (pitchConf - VISUAL_SCENE_CONFIG.ringActivationPitchConfFloor) / (1 - VISUAL_SCENE_CONFIG.ringActivationPitchConfFloor));
        const activateScore = confidenceGate * 0.74 + loudNormRaw * 0.22 + onset * 0.08;
        const minPitchConf = VISUAL_SCENE_CONFIG.ringReactivationMinPitchConf;
        const minLoudness = VISUAL_SCENE_CONFIG.ringReactivationMinLoudness;
        const onThreshold = VISUAL_SCENE_CONFIG.ringReactivationOnThreshold;
        const minStability = VISUAL_SCENE_CONFIG.ringVoicedMinStability;
        const hasVoice = (
            pitchInRange &&
            notePresent &&
            pitchConf >= minPitchConf &&
            loudNormRaw >= minLoudness &&
            stability >= minStability &&
            activateScore >= onThreshold
        );

        if (!hasVoice || !Number.isFinite(pitchHz)) {
            return { voiced: false, visibility: 0 };
        }

        const pitchNorm = MathUtils.clamp((Math.log(MathUtils.clamp(pitchHz, 80, 1500)) - Math.log(80)) / (Math.log(1500) - Math.log(80)), 0, 1);
        const timbreTilt = (centroidNorm - 0.5) * 0.08;
        return {
            voiced: true,
            y: -1.45 + pitchNorm * 3.05,
            radius: MathUtils.clamp(0.72 + loudNorm * 1.18 + onset * 0.09, this.liveRingMinRadius, this.liveRingMaxRadius),
            visibility: MathUtils.clamp(confidenceGate * 0.92 + loudNorm * 0.08, 0, 1),
            coreIntensity: MathUtils.clamp(loudNorm * 0.82 + onset * 0.65, 0, 1.5),
            haloIntensity: MathUtils.clamp(loudNorm * 0.74 + onset * 0.7, 0, 1.5),
            thicknessEmphasis: MathUtils.clamp(confidenceGate * 0.12 + onset * 0.16, 0, 0.35),
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
        const pitchHistory = Array.isArray(raw?.pitchHist) ? raw.pitchHist : [];
        const pitchMean = pitchHistory.length > 0
            ? pitchHistory.reduce((a, b) => a + b, 0) / pitchHistory.length
            : 0;
        const pitchVariance = pitchHistory.length > 2
            ? pitchHistory.reduce((acc, p) => acc + Math.pow(p - pitchMean, 2), 0) / pitchHistory.length
            : 0;
        const stability = MathUtils.clamp(1 - Math.sqrt(Math.max(0, pitchVariance)) / 42, 0, 1);
        const loudNormRaw = MathUtils.clamp(((raw?.loudness ?? -80) + 58) / 38, 0, 1);
        const liveState = this.systems.rings.mapLiveRingState({
            pitchHz: raw?.pitch ?? 0,
            note: raw?.note ?? '—',
            loudNorm: sm?.loudNorm ?? 0,
            loudNormRaw,
            pitchConf: raw?.pitchConf ?? sm?.pitchConf ?? 0,
            onset: raw?.onset ?? sm?.onset ?? 0,
            transientFlash: this.audio?.transientFlash ?? 0,
            centroidNorm: sm?.centroidNorm ?? 0.5,
            stability
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
