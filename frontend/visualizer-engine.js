/**
 * VOICE VISUALIZER ENGINE — Smoke & Filament
 *
 * A two-layer visualization tuned for chanson / contralto voices
 * (designed around Patricia Kaas):
 *
 *   BackgroundSystem   — midnight gradient + warm stage-light glow from below
 *   FilamentSystem     — scrolling pitch contour over ~6 s, vibrato visible
 *                        as natural undulation in the line. Color along its
 *                        length encodes register (chest warm ↔ head cool).
 *   PlumeSystem        — volumetric smoke anchored at the *current* note,
 *                        warmth from centroid, drift from instability,
 *                        inner-core pulse on consonant onsets.
 *
 * Data mapping:
 *   pitch        → Y (vertical position of filament tip + plume)
 *   loudness     → filament thickness + plume size
 *   centroid     → warmth (dark/chest amber ↔ bright/head pewter)
 *   stability    → plume settle (1 = still, 0 = drifting)
 *   onset        → plume inner-core flash (consonant attacks)
 *   vibrato      → emergent — already visible in the contour itself
 *
 * The contour scrolls right-to-left; "now" is at the right edge where the
 * plume sits. Older samples fade out on the left.
 *
 * Public API preserved (visualizer.html is unmodified):
 *   class VisualizerEngine { constructor(canvasId, audioManager); ... }
 *   engine.systems.rings.smState  // 'IDLE' | 'TRACKING'  (kept for UI hook)
 */

var CFG = {
    // camera
    cameraFOV:      40,
    cameraDistance: 12.0,
    // world bounds
    xLeft:         -7.0,
    xRight:         6.0,    // "now" anchor — plume sits a bit short of the edge
    yMin:          -3.6,
    yMax:           3.6,
    // trail
    trailSeconds:   6.0,
    trailMaxSamples: 360,   // ring buffer cap (~60 fps worth)
    filamentWidth:  0.08,   // base thickness (multiplied by loudness)
    filamentMaxW:   0.22,
    // plume
    plumeBaseR:     0.55,
    plumeMaxR:      1.85,
    // motion
    yAttack:        0.45,
    yRelease:       0.08,
    flashDecay:     0.55,
    // colours — chanson palette
    //   t=0  deep wine (low register, dark timbre)
    //   t=1  pewter blue (high register, bright timbre)
    palette: [
        { t: 0.00, r: 0.46, g: 0.11, b: 0.13 },  // deep wine
        { t: 0.22, r: 0.62, g: 0.22, b: 0.14 },  // burnt orange
        { t: 0.45, r: 0.78, g: 0.46, b: 0.20 },  // amber
        { t: 0.65, r: 0.85, g: 0.66, b: 0.34 },  // warm gold
        { t: 0.82, r: 0.50, g: 0.56, b: 0.50 },  // muted jade
        { t: 1.00, r: 0.42, g: 0.54, b: 0.66 },  // desaturated pewter
    ],
    // pixel ratio cap
    maxDPR: 1.5,
};

/* ─────────────────────────────── helpers ─────────────── */
var M = {
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    lerp:  (a, b, t)   => a + (b - a) * t,
};

function samplePalette(t) {
    const p = CFG.palette;
    if (t <= p[0].t) return { r: p[0].r, g: p[0].g, b: p[0].b };
    if (t >= p[p.length - 1].t) { const last = p[p.length - 1]; return { r: last.r, g: last.g, b: last.b }; }
    for (let i = 0; i < p.length - 1; i++) {
        if (t >= p[i].t && t <= p[i + 1].t) {
            const f = (t - p[i].t) / (p[i + 1].t - p[i].t);
            return {
                r: M.lerp(p[i].r, p[i + 1].r, f),
                g: M.lerp(p[i].g, p[i + 1].g, f),
                b: M.lerp(p[i].b, p[i + 1].b, f),
            };
        }
    }
}

const LOG_LO    = Math.log(65.4);
const LOG_RANGE = Math.log(2093.0) - LOG_LO;
function hzToNorm(hz) {
    if (!(hz > 40)) return 0.5;
    return M.clamp((Math.log(M.clamp(hz, 65.4, 2093.0)) - LOG_LO) / LOG_RANGE, 0, 1);
}
function pitchToY(hz) {
    return M.lerp(CFG.yMin, CFG.yMax, hzToNorm(hz));
}

/* ─────────────────────────────── BackgroundSystem ──────── */
class BackgroundSystem {
    constructor(scene) {
        const geo = new THREE.SphereGeometry(48, 32, 24);
        const mat = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            uniforms: {
                uTop:    { value: new THREE.Color(0x05080f) },
                uMid:    { value: new THREE.Color(0x0a0d18) },
                uStage:  { value: new THREE.Color(0x3a1a0e) },
            },
            vertexShader: `
                varying float vY;
                varying vec3 vPos;
                void main() {
                    vec4 wp = modelMatrix * vec4(position,1.0);
                    vY = wp.y;
                    vPos = wp.xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
                }`,
            fragmentShader: `
                varying float vY;
                varying vec3 vPos;
                uniform vec3 uTop, uMid, uStage;
                void main() {
                    // vertical sky
                    float h = clamp((vY + 10.0) / 22.0, 0.0, 1.0);
                    vec3 sky = mix(uMid, uTop, smoothstep(0.0, 1.0, h));

                    // stage glow from below-centre — chanson stage light
                    float d = length(vec2(vPos.x, vPos.y + 14.0)) / 28.0;
                    float glow = exp(-d * 2.2) * 0.65;
                    glow *= smoothstep(0.2, -8.0, vY); // only below mid-line

                    gl_FragColor = vec4(sky + uStage * glow, 1.0);
                }`,
        });
        scene.add(new THREE.Mesh(geo, mat));
    }
}

/* ─────────────────────────────── FilamentSystem ──────────
 * Scrolling pitch contour rendered as a tube along an updating
 * curve. The curve is rebuilt from a ring buffer each frame.
 * Per-vertex colour bakes in the register (centroid) at that moment.
 */
class FilamentSystem {
    constructor(scene) {
        this._buf = [];                 // ring of samples
        this._capacity = CFG.trailMaxSamples;
        this._lastSampleT = -1;

        const segs = this._capacity - 1;
        this._maxSegs = segs;

        // Pre-allocate buffer geometry: position + color, per vertex of a tube
        // We render the filament as two stacked line bands for body+glow.
        // Approach: a TubeGeometry rebuilt each frame from a CatmullRomCurve3.
        //   This is reasonably cheap at 360 control points with low radial segs.
        this._curve = null;
        this._geometry = new THREE.BufferGeometry();
        this._material = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uTime: { value: 0 },
            },
            vertexShader: `
                attribute vec3 aColor;
                attribute float aAlpha;
                varying vec3 vColor;
                varying float vAlpha;
                void main() {
                    vColor = aColor;
                    vAlpha = aAlpha;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                varying vec3 vColor;
                varying float vAlpha;
                void main() {
                    gl_FragColor = vec4(vColor, vAlpha);
                }`,
        });

        // Two meshes: core (bright, thin) and halo (broad, dim) — both rebuilt per frame
        this._coreMesh = new THREE.Mesh(this._geometry, this._material);
        scene.add(this._coreMesh);

        this._haloGeom = new THREE.BufferGeometry();
        this._haloMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: {},
            vertexShader: this._material.vertexShader,
            fragmentShader: this._material.fragmentShader,
        });
        this._haloMesh = new THREE.Mesh(this._haloGeom, this._haloMat);
        scene.add(this._haloMesh);

        this._tmpVec = new THREE.Vector3();
    }

    /**
     * Append a new sample to the ring buffer. Called when fresh audio data arrives.
     * @param {object} s  { y, thickness, color: {r,g,b}, voiced }
     * @param {number} t  monotonic seconds
     */
    pushSample(s, t) {
        // Avoid duplicate samples at the same instant.
        if (this._lastSampleT >= 0 && (t - this._lastSampleT) < 0.005) return;
        this._lastSampleT = t;

        this._buf.push({
            y: s.y,
            thickness: s.thickness,
            r: s.color.r, g: s.color.g, b: s.color.b,
            voiced: s.voiced ? 1 : 0,
            t: t,
        });
        while (this._buf.length > this._capacity) this._buf.shift();
    }

    /**
     * Rebuild geometry for the current trail window.
     * X axis maps recent → right edge, oldest → left edge.
     */
    rebuild(nowT) {
        const buf = this._buf;
        const n = buf.length;
        if (n < 2) {
            this._geometry.setDrawRange(0, 0);
            this._haloGeom.setDrawRange(0, 0);
            return;
        }

        // Determine the range of timestamps that fall within trailSeconds
        const oldestAllowed = nowT - CFG.trailSeconds;
        let startIdx = 0;
        for (let i = 0; i < n; i++) {
            if (buf[i].t >= oldestAllowed) { startIdx = i; break; }
            if (i === n - 1) startIdx = i; // fallback
        }
        const used = n - startIdx;
        if (used < 2) {
            this._geometry.setDrawRange(0, 0);
            this._haloGeom.setDrawRange(0, 0);
            return;
        }

        // Build per-vertex X positions (oldest = xLeft, newest = xRight).
        // Use actual timestamps for accurate scroll speed.
        const tNew = buf[n - 1].t;
        const tOld = buf[startIdx].t;
        const tSpan = Math.max(0.05, tNew - tOld);

        // We build two ribbon strips (core thin, halo wide) using triangle strips.
        // Each segment between samples = 2 triangles (4 vertices in strip).
        const segCount = used - 1;
        // Use indexed geometry: for each sample we emit top + bottom vertex pair.
        const vertCount = used * 2;

        // Allocate or reuse typed arrays
        const needCore = (!this._coreArrays || this._coreArrays.vertCount !== vertCount);
        if (needCore) {
            this._coreArrays = {
                vertCount,
                pos:   new Float32Array(vertCount * 3),
                color: new Float32Array(vertCount * 3),
                alpha: new Float32Array(vertCount),
                index: this._buildStripIndex(used),
            };
            this._haloArrays = {
                vertCount,
                pos:   new Float32Array(vertCount * 3),
                color: new Float32Array(vertCount * 3),
                alpha: new Float32Array(vertCount),
                index: this._coreArrays.index,
            };
        }

        const C = this._coreArrays;
        const H = this._haloArrays;

        const z = 0.0;
        for (let i = 0; i < used; i++) {
            const s = buf[startIdx + i];
            const tFrac = (s.t - tOld) / tSpan;         // 0 oldest → 1 newest
            const x = M.lerp(CFG.xLeft, CFG.xRight, tFrac);

            // Thickness fades in along the line, fully present near "now".
            // Also fades to zero at the leading edge so the head looks soft.
            const ageFade = Math.pow(tFrac, 0.6);              // 0..1, more weight near right
            const headFade = 1.0 - Math.pow(1 - tFrac, 6.0);   // dies just before xRight if needed
            const wCore = s.thickness * 0.45 * ageFade * (0.4 + 0.6 * headFade);
            const wHalo = s.thickness * 1.8  * ageFade;

            // Skip unvoiced regions by collapsing thickness (they become invisible)
            const voicedW = s.voiced ? 1.0 : 0.15;

            const topY = s.y + wCore * voicedW * 0.5;
            const botY = s.y - wCore * voicedW * 0.5;
            const topYH = s.y + wHalo * voicedW * 0.5;
            const botYH = s.y - wHalo * voicedW * 0.5;

            const o = i * 2;
            // CORE
            C.pos[o*3+0] = x;       C.pos[o*3+1] = topY;  C.pos[o*3+2] = z;
            C.pos[(o+1)*3+0] = x;   C.pos[(o+1)*3+1] = botY; C.pos[(o+1)*3+2] = z;
            // HALO  (slightly behind)
            H.pos[o*3+0] = x;       H.pos[o*3+1] = topYH; H.pos[o*3+2] = z - 0.02;
            H.pos[(o+1)*3+0] = x;   H.pos[(o+1)*3+1] = botYH; H.pos[(o+1)*3+2] = z - 0.02;

            // Colour & alpha
            // Brighten the leading 8% of the trail so the "now" head feels alive.
            const headBoost = 1.0 + Math.pow(M.clamp((tFrac - 0.92) / 0.08, 0, 1), 1.2) * 0.6;
            const coreR = M.clamp(s.r * headBoost, 0, 1.2);
            const coreG = M.clamp(s.g * headBoost, 0, 1.2);
            const coreB = M.clamp(s.b * headBoost, 0, 1.2);
            C.color[o*3+0]=coreR; C.color[o*3+1]=coreG; C.color[o*3+2]=coreB;
            C.color[(o+1)*3+0]=coreR; C.color[(o+1)*3+1]=coreG; C.color[(o+1)*3+2]=coreB;
            // halo dimmer + warmer-shifted
            H.color[o*3+0]=s.r*0.78; H.color[o*3+1]=s.g*0.62; H.color[o*3+2]=s.b*0.50;
            H.color[(o+1)*3+0]=s.r*0.78; H.color[(o+1)*3+1]=s.g*0.62; H.color[(o+1)*3+2]=s.b*0.50;

            // Alpha — fade along length and on unvoiced regions
            const aCore = (s.voiced ? 0.95 : 0.12) * ageFade;
            const aHalo = (s.voiced ? 0.38 : 0.04) * ageFade;
            C.alpha[o] = aCore;   C.alpha[o+1] = aCore;
            H.alpha[o] = aHalo;   H.alpha[o+1] = aHalo;
        }

        this._uploadGeom(this._geometry, C);
        this._uploadGeom(this._haloGeom, H);
    }

    _buildStripIndex(samples) {
        // For `samples` pairs of (top, bottom) we emit 2 tris per segment.
        const segs = samples - 1;
        const idx = new Uint16Array(segs * 6);
        for (let i = 0; i < segs; i++) {
            const a = i * 2;
            const b = a + 1;
            const c = a + 2;
            const d = a + 3;
            const o = i * 6;
            idx[o+0] = a; idx[o+1] = b; idx[o+2] = c;
            idx[o+3] = b; idx[o+4] = d; idx[o+5] = c;
        }
        return idx;
    }

    _uploadGeom(geom, arrays) {
        if (!geom.attributes.position || geom.attributes.position.array.length !== arrays.pos.length) {
            geom.setAttribute('position', new THREE.BufferAttribute(arrays.pos, 3));
            geom.setAttribute('aColor',   new THREE.BufferAttribute(arrays.color, 3));
            geom.setAttribute('aAlpha',   new THREE.BufferAttribute(arrays.alpha, 1));
            geom.setIndex(new THREE.BufferAttribute(arrays.index, 1));
        } else {
            geom.attributes.position.array.set(arrays.pos);
            geom.attributes.position.needsUpdate = true;
            geom.attributes.aColor.array.set(arrays.color);
            geom.attributes.aColor.needsUpdate = true;
            geom.attributes.aAlpha.array.set(arrays.alpha);
            geom.attributes.aAlpha.needsUpdate = true;
        }
        geom.setDrawRange(0, arrays.index.length);
    }
}

/* ─────────────────────────────── PlumeSystem ───────────────
 * Volumetric smoke billow anchored at the current note position.
 * One shader-rendered plane with multi-octave radial falloff.
 * NOT a particle system — single mesh, single eval per pixel.
 */
class PlumeSystem {
    constructor(scene) {
        const geo = new THREE.PlaneGeometry(8, 8);
        this._mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uTime:     { value: 0 },
                uColor:    { value: new THREE.Color(0.78, 0.46, 0.20) },
                uInnerCol: { value: new THREE.Color(1.0, 0.85, 0.55) },
                uSize:     { value: 1.0 },
                uOpacity:  { value: 0.9 },
                uDrift:    { value: 0.0 },     // 0 still → 1 turbulent
                uFlash:    { value: 0.0 },     // onset core flash
                uWarm:     { value: 0.7 },     // 0 cool (head) → 1 warm (chest)
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uColor, uInnerCol;
                uniform float uTime, uSize, uOpacity, uDrift, uFlash, uWarm;

                // Cheap value noise (no textures)
                float hash(vec2 p) {
                    p = fract(p * vec2(123.34, 456.21));
                    p += dot(p, p + 45.32);
                    return fract(p.x * p.y);
                }
                float noise(vec2 p) {
                    vec2 i = floor(p), f = fract(p);
                    float a = hash(i);
                    float b = hash(i + vec2(1.0, 0.0));
                    float c = hash(i + vec2(0.0, 1.0));
                    float d = hash(i + vec2(1.0, 1.0));
                    vec2 u = f * f * (3.0 - 2.0 * f);
                    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
                }
                float fbm(vec2 p) {
                    float v = 0.0;
                    float a = 0.5;
                    for (int i = 0; i < 4; i++) {
                        v += a * noise(p);
                        p *= 2.07;
                        a *= 0.5;
                    }
                    return v;
                }

                void main() {
                    vec2 uv = vUv * 2.0 - 1.0;       // -1..1

                    // Plume drifts upward (breath) over time. Drift amount scales with instability.
                    vec2 nuv = uv * 1.4;
                    nuv.y += uTime * 0.10;            // gentle upward drift
                    nuv += vec2(uTime * 0.03, uTime * 0.05) * uDrift;

                    float n = fbm(nuv);
                    n = mix(0.5, n, 0.65 + uDrift * 0.35); // less turbulent when steady

                    // Radial falloff — soft circular billow, scaled by uSize
                    float r = length(uv) / max(0.5, uSize);
                    float radial = exp(-r * r * 1.6);

                    // Combine: radial × noise gives an organic billow
                    float dens = radial * mix(0.55, 1.0, n);

                    // Inner bright core
                    float core = exp(-r * r * 8.0);
                    float innerPulse = core * (0.55 + uFlash * 0.45);

                    // Compose colour
                    vec3 outer = uColor;
                    // Warm-vs-cool mix: when uWarm low, plume tints toward cool slate
                    vec3 cool = vec3(0.32, 0.42, 0.55);
                    outer = mix(cool * 0.7, outer, uWarm);

                    vec3 col = mix(outer, uInnerCol, innerPulse);

                    // Alpha — additive blend, so keep modest to avoid blowout
                    float a = dens * uOpacity * 0.55 + innerPulse * 0.35 * uOpacity;
                    gl_FragColor = vec4(col, a);
                }`,
        });

        this.mesh = new THREE.Mesh(geo, this._mat);
        this.mesh.position.set(CFG.xRight, 0, 0.01);
        scene.add(this.mesh);

        // Secondary larger halo plane (further back, slower) for depth
        this._haloMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uTime: { value: 0 },
                uColor: { value: new THREE.Color(0.40, 0.18, 0.10) },
                uSize: { value: 1.4 },
                uOpacity: { value: 0.35 },
                uDrift: { value: 0 },
                uWarm:  { value: 0.7 },
            },
            vertexShader: this._mat.vertexShader,
            fragmentShader: `
                varying vec2 vUv;
                uniform vec3 uColor;
                uniform float uTime, uSize, uOpacity, uDrift, uWarm;
                float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
                float noise(vec2 p){vec2 i=floor(p),f=fract(p);float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));vec2 u=f*f*(3.0-2.0*f);return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;}
                float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<3;i++){v+=a*noise(p);p*=2.1;a*=0.5;}return v;}
                void main() {
                    vec2 uv = vUv * 2.0 - 1.0;
                    vec2 nuv = uv * 0.9;
                    nuv.y += uTime * 0.05;
                    nuv += vec2(uTime*0.02, uTime*0.03) * uDrift;
                    float n = fbm(nuv);
                    float r = length(uv) / max(0.5, uSize);
                    float radial = exp(-r * r * 1.1);
                    float dens = radial * mix(0.5, 1.0, n);
                    vec3 cool = vec3(0.22, 0.30, 0.42);
                    vec3 col = mix(cool * 0.7, uColor, uWarm);
                    gl_FragColor = vec4(col, dens * uOpacity * 0.6);
                }`,
        });
        const haloGeo = new THREE.PlaneGeometry(12, 12);
        this.halo = new THREE.Mesh(haloGeo, this._haloMat);
        this.halo.position.set(CFG.xRight, 0, -0.05);
        scene.add(this.halo);

        // Smoothed display state
        this.dispY = 0;
        this.dispSize = 0.6;
        this.dispDrift = 0.5;
        this.dispWarm = 0.7;
        this.dispFlash = 0;
        this._color = new THREE.Color(0.78, 0.46, 0.20);
        this._target = new THREE.Color();
    }

    update(live, dt) {
        const voiced = !!live.active;

        const tY     = voiced ? live.y : 0;
        const tSize  = voiced ? (CFG.plumeBaseR + live.loudNorm * (CFG.plumeMaxR - CFG.plumeBaseR)) : 0.45;
        const tDrift = voiced ? (1.0 - M.clamp(live.stability, 0, 1)) : 0.8;
        const tWarm  = voiced ? (1.0 - M.clamp(live.centroidNorm, 0, 1)) : 0.5;
        const tFlash = voiced ? live.transient : 0;

        const yAlpha = (tY > this.dispY) ? CFG.yAttack : CFG.yRelease;
        this.dispY     = M.lerp(this.dispY, tY, yAlpha);
        this.dispSize  = M.lerp(this.dispSize, tSize, voiced ? 0.18 : 0.06);
        this.dispDrift = M.lerp(this.dispDrift, tDrift, 0.08);
        this.dispWarm  = M.lerp(this.dispWarm, tWarm, 0.10);
        this.dispFlash = M.lerp(this.dispFlash, tFlash, CFG.flashDecay);

        // Colour: pitch-derived but pulled toward chest tint when centroid low
        const pCol = samplePalette(M.clamp(live.pitchNorm, 0, 1));
        const chestPull = this.dispWarm * 0.5;
        const r = M.lerp(pCol.r, 0.85, chestPull * 0.4);
        const g = M.lerp(pCol.g, 0.45, chestPull * 0.4);
        const b = M.lerp(pCol.b, 0.20, chestPull * 0.4);
        this._target.setRGB(r, g, b);
        this._color.lerp(this._target, 0.18);

        // Apply
        this.mesh.position.y = this.dispY;
        this.halo.position.y = this.dispY;

        const u = this._mat.uniforms;
        u.uTime.value += dt;
        u.uSize.value  = this.dispSize;
        u.uDrift.value = this.dispDrift;
        u.uFlash.value = this.dispFlash;
        u.uWarm.value  = this.dispWarm;
        u.uColor.value.copy(this._color);
        // Inner core stays warm-bright; cool slightly with head voice
        u.uInnerCol.value.setRGB(
            M.lerp(0.78, 1.0, this.dispWarm),
            M.lerp(0.72, 0.85, this.dispWarm),
            M.lerp(0.70, 0.55, this.dispWarm)
        );
        u.uOpacity.value = voiced ? 0.9 : 0.25;

        const uh = this._haloMat.uniforms;
        uh.uTime.value += dt;
        uh.uSize.value  = this.dispSize * 1.4;
        uh.uDrift.value = this.dispDrift;
        uh.uWarm.value  = this.dispWarm;
        uh.uColor.value.setRGB(this._color.r * 0.55, this._color.g * 0.42, this._color.b * 0.32);
        uh.uOpacity.value = voiced ? 0.45 : 0.12;
    }
}

/* ─────────────────────────────── VisualizerEngine ──────── */
class VisualizerEngine {
    constructor(canvasId, audioManager) {
        this.audio  = audioManager;
        this.canvas = document.getElementById(canvasId);

        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.maxDPR));
        this.renderer.setSize(window.innerWidth, window.innerHeight);

        this.scene  = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(CFG.cameraFOV, window.innerWidth / window.innerHeight, 0.1, 100);
        this.camera.position.set(0, 0.6, CFG.cameraDistance);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.enablePan = false;
        this.controls.minDistance = 6;
        this.controls.maxDistance = 22;

        this.clock = new THREE.Clock();
        this._elapsed = 0;

        const bg       = new BackgroundSystem(this.scene);
        const filament = new FilamentSystem(this.scene);
        const plume    = new PlumeSystem(this.scene);

        // Public hook expected by visualizer.html ui code: `engine.systems.rings.smState`
        // We expose the plume under the legacy name so UI keeps working.
        plume.smState = 'IDLE';
        this.systems = {
            bg,
            filament,
            plume,
            rings: plume,    // legacy alias for the UI
        };

        // Hook AudioManager.ingestFrame to capture per-frame samples for the filament trail
        this._hookIngest();

        this._live = {};
        this.animate();
    }

    _hookIngest() {
        const audio = this.audio;
        const engine = this;
        const orig = audio.ingestFrame.bind(audio);
        audio.ingestFrame = function(d) {
            orig(d);
            engine._onFrame();
        };
    }

    /** Called immediately after a websocket frame is ingested */
    _onFrame() {
        const S = this.audio.state;
        const voiced = (S.pitch > 40) && (S.pitchConf > 0.1);

        const pitchNorm = hzToNorm(S.pitch > 40 ? S.pitch : 220);
        const loudNorm  = M.clamp((S.loudness + 58) / 38, 0, 1);
        const centroidNorm = M.clamp((S.centroid - 250) / 3600, 0, 1);

        // Colour for this sample = pitch palette pulled toward chest when centroid low
        const pCol = samplePalette(pitchNorm);
        const chestPull = (1 - centroidNorm) * 0.55;
        const sampleCol = {
            r: M.lerp(pCol.r, 0.78, chestPull * 0.5),
            g: M.lerp(pCol.g, 0.38, chestPull * 0.5),
            b: M.lerp(pCol.b, 0.16, chestPull * 0.5),
        };

        const thickness = M.lerp(CFG.filamentWidth * 0.4, CFG.filamentMaxW, loudNorm);

        this.systems.filament.pushSample({
            y: pitchToY(S.pitch > 40 ? S.pitch : 220),
            thickness,
            color: sampleCol,
            voiced,
        }, this._elapsed);
    }

    _buildLive() {
        const sm = this.audio.smoothed;
        const S  = this.audio.state;
        const conf = M.clamp(sm.pitchConf, 0, 1);

        const rawNorm   = S.pitch > 40 ? hzToNorm(S.pitch) : sm.pitchNorm;
        const pitchNorm = M.lerp(sm.pitchNorm, rawNorm, conf);

        const rawLoud  = M.clamp((S.loudness + 58) / 38, 0, 1);
        const loudMix  = M.clamp(0.7 * rawLoud + 0.3 * sm.energyNorm, 0, 1);
        const transient = M.clamp(this.audio.transientFlash * 0.9 + sm.histOnset * 0.2, 0, 1);

        const ls = this._live;
        ls.active      = S.pitch > 40 && conf > 0.08;
        ls.y           = M.lerp(CFG.yMin, CFG.yMax, pitchNorm);
        ls.pitchNorm   = pitchNorm;
        ls.loudNorm    = loudMix;
        ls.centroidNorm = sm.centroidNorm;
        ls.stability   = conf;
        ls.transient   = transient;
        ls.energy      = M.clamp(S.energy, 0, 1);
        return ls;
    }

    renderFrame() {
        const dt = Math.min(this.clock.getDelta(), 0.033);
        this._elapsed += dt;

        this.controls.update();
        this.audio.update(dt);

        const live = this._buildLive();
        this.systems.filament.rebuild(this._elapsed);
        this.systems.plume.update(live, dt);

        // Update legacy state hook used by visualizer.html UI
        this.systems.plume.smState = live.active ? 'TRACKING' : 'IDLE';

        this.renderer.render(this.scene, this.camera);
    }

    animate() {
        this.renderFrame();
        requestAnimationFrame(() => this.animate());
    }
}
