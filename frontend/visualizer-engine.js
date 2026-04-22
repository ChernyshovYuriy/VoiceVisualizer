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
    ringYOffsetRelease: 0.07,
    ringLayerLift: 0.055,
    ringHaloOpacity: 0.32,
    ringContourDepth: 0.075,
    ringDepthStagger: 0.22,
    ringTiltMax: 0.09,
    ringShellDepthStep: 0.05,
    ringMainShellBoost: 1.0,
    ringSisterShellBoost: 0.78,
    ringMainShellCount: 4,
    ringSisterShellCount: 2,
    // Runtime-budget knobs: keep richness bounded to avoid audio/render contention.
    ringMainDetailUpdateDivisor: 1,
    ringSisterDetailUpdateDivisor: 3,
    ringMainDetailBudget: 1.0,
    ringSisterDetailBudget: 0.58,
    ringMaxContourWarp: 0.16,
    ringSecondaryBandBiasClamp: 0.55,
    ringSecondaryOnsetClamp: 0.42,
    verticalColorSmoothing: 0.11,
    verticalColorPitchMinY: -3.8,
    verticalColorPitchMaxY: 3.8,
    verticalPaletteStops: [
        { t: 0.0, color: 0x6e2520 }, // deep ember red
        { t: 0.24, color: 0x9d4724 }, // burnt orange
        { t: 0.46, color: 0xb8742f }, // amber
        { t: 0.62, color: 0xc59a46 }, // muted gold
        { t: 0.78, color: 0x4e8b79 }, // muted jade
        { t: 0.9, color: 0x3e8fa2 }, // cyan-blue
        { t: 1.0, color: 0x356da6 } // deep cool blue
    ],
    maxPixelRatio: 1.5
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
        this._frameCount = 0;
        this._cachedSignalVectors = {
            melBands: new THREE.Vector4(),
            peakShape: new THREE.Vector4(),
            peakWeights: new THREE.Vector4()
        };
        this._detailCache = {
            main: { variation: 0.1, contour: VISUAL_SCENE_CONFIG.ringContourDepth, bandBias: 0.2, depthBias: 0.0, harmonicRichness: 0.2, onsetExcite: 0.0, pitchTightness: 0.5 },
            sister: { variation: 0.08, contour: VISUAL_SCENE_CONFIG.ringContourDepth, bandBias: 0.2, depthBias: 0.0, harmonicRichness: 0.16, onsetExcite: 0.0, pitchTightness: 0.5 }
        };
        this._planeGeometry = new THREE.PlaneGeometry(12, 12);

        this._createCentralBeam(scene);
        this._createRings(scene);
    }

    _mapYToVerticalNorm(y) {
        return MathUtils.clamp(
            (y - VISUAL_SCENE_CONFIG.verticalColorPitchMinY) /
            (VISUAL_SCENE_CONFIG.verticalColorPitchMaxY - VISUAL_SCENE_CONFIG.verticalColorPitchMinY),
            0,
            1
        );
    }

    _sampleVerticalPalette(verticalNorm) {
        const stops = VISUAL_SCENE_CONFIG.verticalPaletteStops;
        if (!stops || stops.length === 0) return new THREE.Color(0x8fa5c2);

        if (verticalNorm <= stops[0].t) return new THREE.Color(stops[0].color);
        if (verticalNorm >= stops[stops.length - 1].t) return new THREE.Color(stops[stops.length - 1].color);

        for (let i = 0; i < stops.length - 1; i++) {
            const a = stops[i];
            const b = stops[i + 1];
            if (verticalNorm >= a.t && verticalNorm <= b.t) {
                const localT = MathUtils.clamp((verticalNorm - a.t) / (b.t - a.t), 0, 1);
                return new THREE.Color(a.color).lerp(new THREE.Color(b.color), localT);
            }
        }

        return new THREE.Color(stops[stops.length - 1].color);
    }

    _createRingMaterial(quality = 'full') {
        const useLite = quality === 'lite';
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
                uFlash: { value: 0 },
                uTime: { value: 0 },
                uVariation: { value: 0.25 },
                uContour: { value: 0.3 },
                uLayerLift: { value: VISUAL_SCENE_CONFIG.ringLayerLift },
                uBandBias: { value: 0.0 },
                uRingPhase: { value: 0.0 },
                uHaloOpacity: { value: VISUAL_SCENE_CONFIG.ringHaloOpacity },
                uDepthBias: { value: 0.0 },
                uHardness: { value: 0.45 },
                uHarmonicRichness: { value: 0.25 },
                uLayerRole: { value: 0.0 },
                uLayerMix: { value: new THREE.Vector4(0.7, 0.85, 0.22, 0.12) },
                uPeakShape: { value: new THREE.Vector4(0.0, 0.0, 0.0, 0.0) },
                uPeakWeights: { value: new THREE.Vector4(0.0, 0.0, 0.0, 0.0) },
                uMelBands: { value: new THREE.Vector4(0.25, 0.2, 0.18, 0.12) },
                uPitchTightness: { value: 0.7 },
                uOnsetExcite: { value: 0.0 },
                uShellDepth: { value: 0.0 },
                uLiteMode: { value: useLite ? 1.0 : 0.0 },
                uDetailBudget: { value: useLite ? VISUAL_SCENE_CONFIG.ringSisterDetailBudget : VISUAL_SCENE_CONFIG.ringMainDetailBudget }
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
                uniform float uTime;
                uniform float uVariation;
                uniform float uContour;
                uniform float uLayerLift;
                uniform float uBandBias;
                uniform float uRingPhase;
                uniform float uHaloOpacity;
                uniform float uDepthBias;
                uniform float uHardness;
                uniform float uHarmonicRichness;
                uniform float uLayerRole;
                uniform vec4 uLayerMix;
                uniform vec4 uPeakShape;
                uniform vec4 uPeakWeights;
                uniform vec4 uMelBands;
                uniform float uPitchTightness;
                uniform float uOnsetExcite;
                uniform float uShellDepth;
                uniform float uLiteMode;
                uniform float uDetailBudget;

                void main() {
                    vec2 uv = vUv * 2.0 - 1.0;
                    uv.x *= 1.08;
                    float theta = atan(uv.y, uv.x);
                    float p0 = sin(theta * (3.0 + uPeakShape.x * 9.0) + uRingPhase * 0.8 + uTime * 0.45);
                    float p1 = sin(theta * (5.0 + uPeakShape.y * 11.0) + uRingPhase * 1.2 + uTime * 0.35) * (1.0 - uLiteMode * 0.45);
                    float p2 = sin(theta * (8.0 + uPeakShape.z * 15.0) - uRingPhase * 0.7 + uTime * 0.25) * (1.0 - uLiteMode * 0.7);
                    float peakContour = p0 * uPeakWeights.x + p1 * uPeakWeights.y + p2 * uPeakWeights.z;
                    // Cheap richness approximation: 2-3 low-frequency contour terms instead of dense geometry.
                    float harmonicA = sin(theta * (4.0 + uHarmonicRichness * 5.0) + uTime * 1.1 + uRingPhase);
                    float harmonicB = sin(theta * (8.0 + uHarmonicRichness * 8.0) - uTime * 0.8 + uRingPhase * 1.7) * (1.0 - uLiteMode * 0.65);
                    float melTexturing = sin(theta * (14.0 + uMelBands.x * 10.0) + uTime * 0.18) * uMelBands.y * (1.0 - uLiteMode * 0.7);
                    float onsetPulse = (sin(theta * 2.0 - uTime * 1.7) * 0.5 + 0.5) * uOnsetExcite;
                    float tighten = mix(0.25, 1.0, uPitchTightness);
                    float rippleA = harmonicA * uVariation;
                    float rippleB = harmonicB * (uContour * 0.65);
                    float structuredWarp = peakContour * (0.045 * tighten) + melTexturing * 0.02 + onsetPulse * 0.015;
                    float contourDelta = (rippleA * 0.02 + rippleB * 0.015 + structuredWarp) * (0.8 + uLayerRole * 0.4) * uDetailBudget;
                    float contourWarp = 1.0 + clamp(contourDelta, -${VISUAL_SCENE_CONFIG.ringMaxContourWarp.toFixed(3)}, ${VISUAL_SCENE_CONFIG.ringMaxContourWarp.toFixed(3)});
                    float dist = length(uv) * 4.0 * contourWarp;
                    float ringDist = abs(dist - uRadius);

                    float innerSharp = mix(1.45, 0.95, uHardness);
                    float innerSoft = mix(0.26, 0.4, uHardness);
                    float inner = smoothstep(uThickness * innerSharp, uThickness * innerSoft, ringDist);
                    float mid = exp(-pow(ringDist / (uThickness * mix(1.05, 0.8, uHardness)), 2.0));
                    float outer = exp(-pow(ringDist / (uThickness * mix(2.2, 1.7, uHardness)), 2.0));
                    float halo = exp(-pow(ringDist / (uThickness * mix(2.2, 2.8, 1.0 - uLiteMode * 0.5)), 2.0));
                    float sisterStroke = exp(-pow((ringDist - uThickness * uLayerLift) / (uThickness * mix(1.0, 1.2, 1.0 - uLiteMode * 0.4)), 2.0));
                    float coreStroke = exp(-pow((ringDist + uThickness * 0.28) / (uThickness * 0.72), 2.0));
                    float depthBand = smoothstep(-0.25, 0.75, uv.y + uDepthBias * 0.9);
                    float shellDepthBand = smoothstep(-0.65, 0.8, uv.y + uShellDepth * 1.4);

                    float layeredAlpha =
                        inner * uLayerMix.x +
                        mid * uLayerMix.y * 0.46 +
                        outer * uLayerMix.z +
                        halo * uHaloOpacity * uLayerMix.z +
                        sisterStroke * uLayerMix.w +
                        coreStroke * (0.08 + uLayerMix.x * 0.14);
                    float alpha = layeredAlpha * uOpacity;
                    vec3 flashMix = mix(uColor, vec3(1.0, 0.94, 0.82), clamp(uFlash * 0.35, 0.0, 0.35));
                    vec3 edgeWarm = vec3(1.0, 0.93, 0.80);
                    vec3 coreColor = mix(flashMix, edgeWarm, clamp(coreStroke * 0.5 + uFlash * 0.2, 0.0, 0.55));
                    vec3 haloTint = mix(flashMix, vec3(0.72, 0.82, 0.95), clamp(uBandBias * 0.45, 0.0, 0.45));
                    vec3 depthTint = mix(vec3(0.84, 0.74, 0.58), vec3(0.68, 0.82, 0.95), depthBand * uBandBias);
                    vec3 shellTint = mix(vec3(0.94, 0.86, 0.72), vec3(0.66, 0.84, 0.96), shellDepthBand * (0.5 + uBandBias * 0.4));
                    vec3 color =
                        coreColor * (0.42 + uGlow * 0.24 + mid * 0.26 + uLayerRole * 0.08) +
                        haloTint * (halo * 0.2 + sisterStroke * 0.16 + uLayerMix.w * 0.08) +
                        depthTint * (halo * 0.12 + outer * 0.1) +
                        shellTint * (outer * 0.11 + uOnsetExcite * 0.06);
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
        const shellProfiles = [
            { role: 0.0, mix: [0.92, 1.05, 0.15, 0.08], thickness: 0.92, opacity: 1.0, radius: 1.0, lift: 0.9, depth: -0.2 },
            { role: 0.35, mix: [0.68, 0.95, 0.26, 0.12], thickness: 1.18, opacity: 0.82, radius: 1.02, lift: 1.0, depth: 0.0 },
            { role: 0.7, mix: [0.32, 0.6, 0.5, 0.18], thickness: 1.45, opacity: 0.58, radius: 1.05, lift: 1.2, depth: 0.22 },
            { role: 0.95, mix: [0.22, 0.42, 0.62, 0.24], thickness: 1.72, opacity: 0.36, radius: 1.08, lift: 1.32, depth: 0.36 }
        ];

        for (let i = 0; i < offsets.length; i++) {
            const group = new THREE.Group();
            scene.add(group);
            const shellLimit = i === 0 ? VISUAL_SCENE_CONFIG.ringMainShellCount : VISUAL_SCENE_CONFIG.ringSisterShellCount;
            const shells = shellProfiles.slice(0, shellLimit).map((shell) => {
                const mat = this._createRingMaterial(i === 0 ? 'full' : 'lite');
                mat.uniforms.uLayerRole.value = shell.role;
                mat.uniforms.uLayerMix.value.set(shell.mix[0], shell.mix[1], shell.mix[2], shell.mix[3]);
                mat.uniforms.uLayerLift.value = VISUAL_SCENE_CONFIG.ringLayerLift * shell.lift;
                mat.uniforms.uOpacity.value = VISUAL_SCENE_CONFIG.ringOpacity * opacityScale[i] * shell.opacity;
                mat.uniforms.uShellDepth.value = shell.depth;

                const mesh = new THREE.Mesh(this._planeGeometry, mat);
                mesh.rotation.x = -Math.PI / 2;
                mesh.position.z = shell.depth * VISUAL_SCENE_CONFIG.ringShellDepthStep * (i === 0 ? VISUAL_SCENE_CONFIG.ringMainShellBoost : VISUAL_SCENE_CONFIG.ringSisterShellBoost);
                group.add(mesh);
                return { mesh, mat, shell };
            });

            this.rings.push({
                group,
                shells,
                yOffset: offsets[i],
                radiusScale: radiusScale[i],
                opacityScale: opacityScale[i],
                toneScale: i === 0 ? 1.0 : (Math.abs(offsets[i]) < farOffset ? 0.95 : 0.9),
                phase: i * 0.83
            });
        }
    }

    update(liveState) {
        this._frameCount += 1;
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

        const pitchNorm = liveState?.pitchNorm ?? this._mapYToVerticalNorm(this.displayY);
        const mappedY = MathUtils.lerp(
            VISUAL_SCENE_CONFIG.verticalColorPitchMinY,
            VISUAL_SCENE_CONFIG.verticalColorPitchMaxY,
            pitchNorm
        );
        const verticalNorm = this._mapYToVerticalNorm(mappedY);
        const targetColor = this._sampleVerticalPalette(verticalNorm);
        const contour = MathUtils.lerp(VISUAL_SCENE_CONFIG.ringContourDepth, 0.16, liveState?.peakSpread ?? 0);
        const variation = MathUtils.lerp(0.08, 0.42, liveState?.melPresence ?? 0);
        const harmonicRichness = liveState?.harmonicRichness ?? 0.2;
        const depthBias = liveState?.depthBias ?? 0;
        const hardness = liveState?.surfaceHardness ?? 0.45;
        const onsetExcite = liveState?.onsetExcite ?? 0;
        const pitchTightness = liveState?.pitchConf ?? 0.5;
        const melBands = liveState?.melBands ?? [0.25, 0.2, 0.16, 0.12];
        const peakShape = liveState?.peakShape ?? [0.1, 0.2, 0.3, 0.0];
        const peakWeights = liveState?.peakWeights ?? [0.35, 0.25, 0.2, 0.0];
        this._cachedSignalVectors.melBands.set(melBands[0], melBands[1], melBands[2], melBands[3]);
        this._cachedSignalVectors.peakShape.set(peakShape[0], peakShape[1], peakShape[2], peakShape[3]);
        this._cachedSignalVectors.peakWeights.set(peakWeights[0], peakWeights[1], peakWeights[2], peakWeights[3]);
        this.displayColor.lerp(targetColor, VISUAL_SCENE_CONFIG.verticalColorSmoothing);

        const sisterCoupling = MathUtils.lerp(0.96, 1.0, liveState?.sisterRichness ?? 0);
        const updateMainDetail = this._frameCount % VISUAL_SCENE_CONFIG.ringMainDetailUpdateDivisor === 0;
        const updateSisterDetail = this._frameCount % VISUAL_SCENE_CONFIG.ringSisterDetailUpdateDivisor === 0;
        if (updateMainDetail) {
            this._detailCache.main.variation = variation;
            this._detailCache.main.contour = contour;
            this._detailCache.main.bandBias = liveState?.centroidNorm ?? 0.2;
            this._detailCache.main.depthBias = depthBias;
            this._detailCache.main.harmonicRichness = harmonicRichness;
            this._detailCache.main.onsetExcite = onsetExcite;
            this._detailCache.main.pitchTightness = pitchTightness;
        }
        if (updateSisterDetail) {
            // Sisters intentionally run on a slower/cheaper path to preserve playback stability.
            this._detailCache.sister.variation = variation * 0.82;
            this._detailCache.sister.contour = contour;
            this._detailCache.sister.bandBias = Math.min(liveState?.centroidNorm ?? 0.2, VISUAL_SCENE_CONFIG.ringSecondaryBandBiasClamp);
            this._detailCache.sister.depthBias = depthBias * 0.72;
            this._detailCache.sister.harmonicRichness = harmonicRichness * VISUAL_SCENE_CONFIG.ringSisterDetailBudget;
            this._detailCache.sister.onsetExcite = Math.min(onsetExcite, VISUAL_SCENE_CONFIG.ringSecondaryOnsetClamp);
            this._detailCache.sister.pitchTightness = pitchTightness;
        }
        this.beam.position.y = this.displayY;
        this.beam.material.color.copy(this.displayColor).multiplyScalar(0.92);

        this.rings.forEach((ring, idx) => {
            ring.group.position.y = this.displayY + ring.yOffset;
            ring.group.position.z = (idx - 2) * VISUAL_SCENE_CONFIG.ringDepthStagger * (liveState?.depthSpread ?? 0.35);
            ring.group.rotation.z = (idx - 2) * (liveState?.ringTilt ?? 0.0);
            const coupledScale = idx === 0 ? 1.0 : sisterCoupling;
            const detailState = idx === 0 ? this._detailCache.main : this._detailCache.sister;
            ring.shells.forEach(({ mat, shell }, shellIdx) => {
                mat.uniforms.uRadius.value = this.displayRadius * ring.radiusScale * coupledScale * shell.radius;
                mat.uniforms.uFlash.value = this.displayFlash;
                mat.uniforms.uThickness.value = thicknessBase * (idx === 0 ? 1.0 : 0.9) * shell.thickness;
                mat.uniforms.uOpacity.value = opacityBase * ring.opacityScale * shell.opacity;
                mat.uniforms.uTime.value += 0.016;
                mat.uniforms.uRingPhase.value = ring.phase + shellIdx * 0.14;
                mat.uniforms.uColor.value.copy(this.displayColor).multiplyScalar(ring.toneScale * (1.0 - shellIdx * 0.05));
                mat.uniforms.uDetailBudget.value = idx === 0
                    ? VISUAL_SCENE_CONFIG.ringMainDetailBudget
                    : VISUAL_SCENE_CONFIG.ringSisterDetailBudget;
                mat.uniforms.uVariation.value = detailState.variation;
                mat.uniforms.uContour.value = detailState.contour;
                mat.uniforms.uBandBias.value = detailState.bandBias;
                mat.uniforms.uDepthBias.value = detailState.depthBias;
                mat.uniforms.uHardness.value = hardness;
                mat.uniforms.uHarmonicRichness.value = detailState.harmonicRichness;
                mat.uniforms.uOnsetExcite.value = detailState.onsetExcite * (1.0 - shellIdx * 0.14);
                mat.uniforms.uPitchTightness.value = detailState.pitchTightness;
                mat.uniforms.uMelBands.value.copy(this._cachedSignalVectors.melBands);
                mat.uniforms.uPeakShape.value.copy(this._cachedSignalVectors.peakShape);
                mat.uniforms.uPeakWeights.value.copy(this._cachedSignalVectors.peakWeights);
            });
        });
    }
}

class VisualizerEngine {
    constructor(canvasId, audioManager) {
        this.audio = audioManager;
        this.canvas = document.getElementById(canvasId);
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, VISUAL_SCENE_CONFIG.maxPixelRatio));
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

    _average(arr, fallback = 0) {
        return (arr && arr.length) ? arr.reduce((a, b) => a + b, 0) / arr.length : fallback;
    }

    _analyzeMel(mel, melHist) {
        if (!mel || !mel.length) {
            return { presence: 0.3, lowMidLift: 0.3, motion: 0.0 };
        }
        const len = mel.length;
        const lowEnd = Math.max(1, Math.floor(len * 0.35));
        const midStart = Math.floor(len * 0.28);
        const midEnd = Math.floor(len * 0.72);
        const highStart = Math.min(len - 1, Math.floor(len * 0.65));
        let low = 0;
        let mid = 0;
        let high = 0;
        for (let i = 0; i < lowEnd; i++) low += mel[i];
        for (let i = midStart; i < midEnd; i++) mid += mel[i];
        for (let i = highStart; i < len; i++) high += mel[i];
        low /= lowEnd;
        mid /= Math.max(1, midEnd - midStart);
        high /= Math.max(1, len - highStart);

        // melHist is used for spectral-memory motion only (no decorative trails).
        const prev = (melHist && melHist.length) ? melHist[melHist.length - 1] : null;
        let motion = 0;
        if (prev && prev.length === len) {
            for (let i = 0; i < len; i++) motion += Math.abs((mel[i] ?? 0) - (prev[i] ?? 0));
            motion = MathUtils.clamp(motion / len * 1.4, 0, 1);
        }
        return {
            presence: MathUtils.clamp(0.48 * low + 0.34 * mid + 0.18 * high, 0, 1),
            lowMidLift: MathUtils.clamp(0.65 * low + 0.35 * mid, 0, 1),
            motion
        };
    }

    _analyzePeaks(peaks, pitchConf) {
        if (!peaks || !peaks.length) {
            return {
                shape: [0.08, 0.18, 0.3, 0.0],
                weights: [0.2, 0.13, 0.1, 0.0],
                spread: 0.0
            };
        }
        const top = [{ bin: 0, value: 0 }, { bin: 0, value: 0 }, { bin: 0, value: 0 }];
        for (let i = 0; i < peaks.length; i++) {
            const p = peaks[i];
            const value = p?.value ?? 0;
            const bin = p?.bin ?? 0;
            if (!Number.isFinite(value) || !Number.isFinite(bin)) continue;
            if (value > top[0].value) {
                top[2] = top[1];
                top[1] = top[0];
                top[0] = { bin, value };
            } else if (value > top[1].value) {
                top[2] = top[1];
                top[1] = { bin, value };
            } else if (value > top[2].value) {
                top[2] = { bin, value };
            }
        }
        const total = Math.max(0.001, top[0].value + top[1].value + top[2].value);
        const shape = [0, 0, 0, 0];
        const weights = [0, 0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const p = top[i]?.value > 0 ? top[i] : { bin: i * 8, value: 0 };
            shape[i] = MathUtils.clamp((p.bin ?? 0) / 64, 0, 1);
            weights[i] = MathUtils.clamp((p.value ?? 0) / total, 0, 1);
        }
        let spread = 0;
        let minBin = Infinity;
        let maxBin = -Infinity;
        let activeBins = 0;
        for (let i = 0; i < top.length; i++) {
            if (top[i].value <= 0) continue;
            activeBins += 1;
            minBin = Math.min(minBin, top[i].bin);
            maxBin = Math.max(maxBin, top[i].bin);
        }
        if (activeBins > 1) spread = MathUtils.clamp((maxBin - minBin) / 64, 0, 1);
        const confGain = MathUtils.lerp(0.28, 1.0, MathUtils.clamp(pitchConf, 0, 1));
        return {
            shape,
            weights: weights.map((w) => w * confGain),
            spread
        };
    }

    buildLiveState() {
        const sm = this.audio.smoothed;
        const S = this.audio.state;
        const mel = S?.mel;
        const conf = MathUtils.clamp(sm.pitchConf, 0, 1);
        const pitchMix = MathUtils.lerp(sm.histPitchNorm, sm.pitchNorm, conf);
        const loudMix = MathUtils.clamp(0.56 * sm.loudNorm + 0.34 * sm.energyNorm + 0.10 * sm.histLoudNorm, 0, 1);
        const melStats = this._analyzeMel(mel, S?.melHist);
        const yFromPitch = -3.8 + pitchMix * 7.6;
        const memoryOffset = (sm.histPitchNorm - sm.pitchNorm) * 0.7;
        const transient = MathUtils.clamp(this.audio.transientFlash * 0.75 + sm.histOnset * 0.35, 0, 1);
        const sisterRichness = MathUtils.clamp(0.6 * sm.peakSpread + 0.4 * sm.centroidNorm, 0, 1);
        const peaks = S?.peaks || [];
        let peakCount = 0;
        let peakSum = 0;
        let minBin = Infinity;
        let maxBin = -Infinity;
        for (let i = 0; i < peaks.length; i++) {
            const value = peaks[i]?.value ?? 0;
            const bin = peaks[i]?.bin ?? 0;
            if (!Number.isFinite(value) || !Number.isFinite(bin)) continue;
            peakCount += 1;
            peakSum += value;
            minBin = Math.min(minBin, bin);
            maxBin = Math.max(maxBin, bin);
        }
        const peakMean = peakCount ? peakSum / peakCount : 0;
        const peakCluster = peakCount ? MathUtils.clamp(1 - (maxBin - minBin) / 63, 0, 1) : 0;
        const harmonicRichness = MathUtils.clamp(0.65 * peakMean + 0.35 * (1 - peakCluster), 0, 1);
        const centroidHistAvg = this._average(S?.centroidHist, S?.centroid ?? 900);
        const centroidMemory = MathUtils.clamp((centroidHistAvg - 250) / 3600, 0, 1);
        const centroidSwing = MathUtils.clamp(Math.abs((sm.centroidNorm ?? 0) - centroidMemory) * 1.8, 0, 1);
        const timbreSoftness = ({
            Dark: 0.28,
            Warm: 0.42,
            Bright: 0.66,
            Brilliant: 0.82
        }[S?.timbre] ?? 0.5);
        const depthBias = MathUtils.clamp((sm.centroidNorm - 0.5) * 2.0, -1, 1);
        const peakAnalysis = this._analyzePeaks(S?.peaks, conf);
        const melBands = [
            MathUtils.clamp(melStats.lowMidLift, 0, 1),
            MathUtils.clamp(melStats.presence, 0, 1),
            MathUtils.clamp(0.5 * melStats.motion + 0.5 * sm.centroidNorm, 0, 1),
            MathUtils.clamp(0.55 * sm.histOnset + 0.45 * transient, 0, 1)
        ];
        const onsetExcite = MathUtils.clamp(0.7 * transient + 0.3 * sm.histOnset, 0, 1);

        return {
            active: sm.pitch > 40 && conf > 0.08,
            y: yFromPitch + memoryOffset * 0.35,
            followY: MathUtils.lerp(0.05, 0.2, conf),
            pitchNorm: pitchMix,
            radius: 0.82 + loudMix * 1.75 + transient * 0.2 + melStats.lowMidLift * 0.08,
            transient,
            stability: conf,
            sisterRichness,
            centroidNorm: sm.centroidNorm,
            peakSpread: sm.peakSpread,
            melPresence: melStats.presence,
            harmonicRichness,
            peakShape: peakAnalysis.shape,
            peakWeights: peakAnalysis.weights,
            melBands,
            onsetExcite,
            pitchConf: conf,
            depthBias,
            depthSpread: MathUtils.clamp(0.2 + 0.4 * melStats.motion + 0.22 * centroidSwing + 0.18 * peakAnalysis.spread, 0, 1),
            ringTilt: MathUtils.lerp(-VISUAL_SCENE_CONFIG.ringTiltMax, VISUAL_SCENE_CONFIG.ringTiltMax, sm.centroidNorm),
            surfaceHardness: MathUtils.clamp(0.45 * conf + 0.35 * timbreSoftness + 0.2 * (1 - sm.histOnset), 0.2, 0.95)
        };
    }

    renderFrame() {
        const dt = Math.min(this.clock.getDelta(), 0.033);
        if (this.controls && (this.controls.enableDamping || this.controls.autoRotate)) this.controls.update();
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
