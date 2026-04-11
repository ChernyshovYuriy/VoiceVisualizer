// Extracted VisualizerEngine class from visualizer.html
// Edit this file to iterate on the 3D visualization only.
// It relies on existing globals: THREE, MathUtils, CONFIG.



    /**
     * ============================================================================
     * VISUALIZER ENGINE (Three.js Wrapper)
     * Maintains the Scene, Shaders, and Render Loop
     * ============================================================================
     */
    class VisualizerEngine {
        constructor(canvasId, audioManager) {
            this.audio = audioManager;
            this.canvas = document.getElementById(canvasId);

            // Core Three.js Setup
            this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap at 2 for performance
            this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
            this.renderer.toneMappingExposure = 1.25;

            this.scene = new THREE.Scene();
            this.scene.background = new THREE.Color(0x020609);
            this.scene.fog = new THREE.FogExp2(0x040a14, 0.022);

            this.camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
            this.camera.position.set(0, 2.2, 5.4);

            this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
            this.controls.target.set(0, 1.4, 0);
            this.controls.enableDamping = true;
            this.controls.dampingFactor = 0.06;
            this.controls.enablePan = false;
            this.controls.minDistance = 2.5;
            this.controls.maxDistance = 10;
            this.controls.maxPolarAngle = Math.PI * 0.52;
            this.controls.minPolarAngle = Math.PI * 0.08;

            // Post-Processing
            this.composer = new THREE.EffectComposer(this.renderer);
            this.composer.addPass(new THREE.RenderPass(this.scene, this.camera));
            this.bloom = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.2, 0.85, 0.3);
            this.composer.addPass(this.bloom);

            this.buildScene();
            this.bindEvents();

            this.lastTime = performance.now();
            this.animate = this.animate.bind(this);
            requestAnimationFrame(this.animate);
        }

        buildScene() {
            // Lights
            this.scene.add(new THREE.AmbientLight(0x0a1828, 0.2));
            this.scene.add(new THREE.HemisphereLight(0x3366aa, 0x020408, 0.2));

            this.lights = {
                key: new THREE.PointLight(0x6699cc, 0.3, 14, 2),
                fill: new THREE.PointLight(0xcc8844, 0.15, 8, 2),
                core: new THREE.PointLight(0xffaa44, 0, 8, 1.5),
                baseGlow: new THREE.PointLight(0x4466cc, 0.3, 5, 2),
                fire: new THREE.PointLight(0xff6622, 0, 10, 1.8)
            };

            this.lights.key.position.set(2.5, 4.5, 3);
            this.lights.fill.position.set(-2.5, 2, -1.5);
            this.lights.core.position.set(0, 2, 0.5);
            this.lights.baseGlow.position.set(0, 0.1, 0);
            this.lights.fire.position.set(0, 1.5, 0);

            Object.values(this.lights).forEach(l => this.scene.add(l));

            // Geometries (Spine, Ribbons, Particles)
            // Note: Incorporating the complex original geometry generation verbatim to preserve original aesthetic
            this.createGround();
            this.createSpine();
            this.createCore();
            this.createNebula();
            this.createRibbons();
            this.createParticles();
        }

        // ... Geometry building methods remain largely the same, encapsulated for scope ...
        createGround() {
            const geo = new THREE.CircleGeometry(5, 96); geo.rotateX(-Math.PI / 2);
            this.groundMat = new THREE.ShaderMaterial({
                transparent: true, depthWrite: false, side: THREE.DoubleSide,
                uniforms: { uTime: { value: 0 }, uEnergy: { value: 0 } },
                vertexShader: 'varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
                fragmentShader: `uniform float uTime,uEnergy;varying vec3 vP;
                    void main(){float d=length(vP.xz);float ring=sin(d*8.0-uTime*0.5)*0.5+0.5;
                    float fade=1.0-smoothstep(1.5,4.5,d);float pulse=0.02+uEnergy*0.06;
                    float bright=(0.04+ring*0.015+pulse)*fade;
                    vec3 col=mix(vec3(0.06,0.12,0.22),vec3(0.1,0.18,0.35),ring*fade);
                    col+=vec3(0.03,0.06,0.12)*uEnergy*fade;gl_FragColor=vec4(col,bright*1.2+0.08*fade);}`
            });
            const mesh = new THREE.Mesh(geo, this.groundMat); mesh.position.y = -0.02;
            this.scene.add(mesh);
        }

        createSpine() {
            const spV = CONFIG.spine.rings * CONFIG.spine.segs;
            this.spPos = new Float32Array(spV * 3); this.spCol = new Float32Array(spV * 3);
            this.sp2Pos = new Float32Array(spV * 3); this.sp2Col = new Float32Array(spV * 3);

            const idx = [];
            for (let r = 0; r < CONFIG.spine.rings - 1; r++) {
                for (let s = 0; s < CONFIG.spine.segs; s++) {
                    const a = r * CONFIG.spine.segs + s, b = a + CONFIG.spine.segs;
                    const c = r * CONFIG.spine.segs + ((s + 1) % CONFIG.spine.segs), d = c + CONFIG.spine.segs;
                    idx.push(a, b, c, c, b, d);
                }
            }

            this.spGeo = new THREE.BufferGeometry();
            this.spGeo.setAttribute('position', new THREE.BufferAttribute(this.spPos, 3));
            this.spGeo.setAttribute('color', new THREE.BufferAttribute(this.spCol, 3));
            this.spGeo.setIndex(idx);
            this.scene.add(new THREE.Mesh(this.spGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })));

            this.spGeo2 = new THREE.BufferGeometry();
            this.spGeo2.setAttribute('position', new THREE.BufferAttribute(this.sp2Pos, 3));
            this.spGeo2.setAttribute('color', new THREE.BufferAttribute(this.sp2Col, 3));
            this.spGeo2.setIndex(idx);
            this.scene.add(new THREE.Mesh(this.spGeo2, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })));

            this.spinePts = Array.from({ length: CONFIG.spine.rings }, () => ({ x: 0, y: 0, z: 0 }));
        }

        createCore() {
            this.core = {
                orb: new THREE.Mesh(new THREE.SphereGeometry(0.1, 28, 28), new THREE.MeshBasicMaterial({ color: 0xffeedd, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false })),
                halo: new THREE.Mesh(new THREE.SphereGeometry(0.2, 28, 28), new THREE.MeshBasicMaterial({ color: 0xffaa66, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false })),
                outer: new THREE.Mesh(new THREE.SphereGeometry(0.35, 28, 28), new THREE.MeshBasicMaterial({ color: 0xff6622, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false })),
                inner: new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })),
                pulseRing: new THREE.Mesh(new THREE.RingGeometry(0.08, 0.22, 64), new THREE.MeshBasicMaterial({ color: 0xff8844, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })),
                baseRing: new THREE.Mesh(new THREE.RingGeometry(0.15, 0.55, 64), new THREE.MeshBasicMaterial({ color: 0x3355aa, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }))
            };

            this.core.pulseRing.rotation.x = this.core.baseRing.rotation.x = -Math.PI / 2;
            this.core.pulseRing.position.y = 0.02; this.core.baseRing.position.y = 0.01;

            Object.values(this.core).forEach(m => this.scene.add(m));
        }

        createNebula() {
            const nebFS = `uniform float uTime;varying vec2 vUv;
                float n(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
                void main(){vec2 uv=vUv-0.5;float d=length(uv);
                float v=n(uv*3.0+uTime*0.02)*0.5+n(uv*7.0-uTime*0.015)*0.3;
                float fade=1.0-smoothstep(0.1,0.5,d);float bright=v*fade*0.035;
                vec3 col=mix(vec3(0.08,0.15,0.30),vec3(0.15,0.08,0.25),v);
                gl_FragColor=vec4(col*bright,bright);}`;

            for (let i = 0; i < 3; i++) {
                const m = new THREE.ShaderMaterial({
                    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
                    uniforms: { uTime: { value: 0 } },
                    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
                    fragmentShader: nebFS
                });
                const p = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), m);
                p.position.set((i - 1) * 3, 2.5, -6 - i * 2); p.rotation.y = (i - 1) * 0.3;
                this.scene.add(p);
            }
        }

        createRibbons() {
            this.ribbons = [];
            for (let ri = 0; ri < CONFIG.ribbons.count; ri++) {
                const nv = CONFIG.ribbons.segs * 2;
                const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = [];
                for (let s = 0; s < CONFIG.ribbons.segs - 1; s++) {
                    const a = s * 2, b = a + 1, c = a + 2, d = a + 3;
                    idx.push(a, c, b, b, c, d);
                }
                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
                geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
                geo.setIndex(idx);

                const t = ri / CONFIG.ribbons.count;
                const isWarm = t < 0.65;
                const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: isWarm ? 0.12 : 0.06, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });

                const mesh = new THREE.Mesh(geo, mat);
                this.scene.add(mesh);

                this.ribbons.push({
                    geo, pos, col, mat,
                    baseAngle: t * Math.PI * 2 + (Math.random() - 0.5) * 0.5,
                    spiralRate: (1.5 + Math.random() * 3.0) * (Math.random() < 0.3 ? -1 : 1),
                    baseRadius: 0.08 + Math.random() * 0.45,
                    width: 0.015 + Math.random() * 0.06,
                    band: Math.floor(Math.random() * CONFIG.bands),
                    phase: Math.random() * 6.28,
                    isWarm, speedMul: 0.6 + Math.random() * 0.8
                });
            }
        }

        createParticles() {
            const total = CONFIG.particles.plasma + CONFIG.particles.aura + CONFIG.particles.wisp;

            this.pUniforms = {
                uTime: { value: 0 }, uBands: { value: new Float32Array(CONFIG.bands) },
                uPeaks: { value: new Float32Array(CONFIG.bands) }, uLoud: { value: 0 },
                uPitchConf: { value: 0 }, uFlash: { value: 0 }, uAlive: { value: 0 },
                uSpineH: { value: 2.0 }, uBreath: { value: 0 }, uVibrato: { value: 0 },
                uOnset: { value: 0 }, uCentroid: { value: 0.5 },
            };

            // Preserved Shader Logic
            const PARTICLE_VS = `attribute float aHomeY,aHomeR,aAngVel,aPhase,aBand,aLayer,aSizeBase;uniform float uTime,uLoud,uPitchConf,uFlash,uAlive,uSpineH,uBreath,uVibrato,uOnset,uCentroid;uniform float uBands[${CONFIG.bands}];uniform float uPeaks[${CONFIG.bands}];varying vec3 vColor; varying float vAlpha;float hash(float n){return fract(sin(n)*43758.5453);}vec3 hsl2rgb(float h,float s,float l){float a=s*min(l,1.0-l);float r=l-a*max(-1.0,min(min(mod(h/30.0,12.0)-3.0,9.0-mod(h/30.0,12.0)),1.0));float g=l-a*max(-1.0,min(min(mod(h/30.0+8.0,12.0)-3.0,9.0-mod(h/30.0+8.0,12.0)),1.0));float b=l-a*max(-1.0,min(min(mod(h/30.0+4.0,12.0)-3.0,9.0-mod(h/30.0+4.0,12.0)),1.0));return vec3(r,g,b);}void main(){int band=int(aBand); float energy=0.0; float peak=0.0;for(int j=0;j<${CONFIG.bands};j++){if(j==band){energy=uBands[j];peak=uPeaks[j];}}float layer=aLayer;float spinMul=1.0+energy*(layer<0.5?1.8:layer<1.5?1.0:0.4);float confT=1.0+uPitchConf*0.8;float bSway=sin(uBreath*0.7+aPhase)*0.15*(1.0-uPitchConf*0.5);float angle=aPhase+(aAngVel*spinMul*confT+bSway)*uTime;float expand=energy*(layer<0.5?0.1:layer<1.5?0.45:1.2);float radius=aHomeR*(0.4+uAlive*0.6)+expand+peak*0.12;radius+=sin(uBreath*1.1+aPhase*3.0+aHomeY*6.28)*0.025*(0.3+energy);radius=max(0.005,radius);float yBase=aHomeY*uSpineH;float yLift=energy*(layer<0.5?0.1:layer<1.5?0.28:0.4);float yVib=sin(uTime*4.0+aPhase*3.0)*uVibrato*0.2;float yBr=sin(uBreath*0.9+aHomeY*4.0)*0.035*(0.2+uPitchConf);float y=yBase+yLift+yVib+yBr;vec3 pos=vec3(cos(angle)*radius,y,sin(angle)*radius);float twist=aHomeY*1.5+sin(uBreath*0.5+aPhase)*0.3*energy;float ca=cos(twist),sa=sin(twist);float nx=pos.x*ca-pos.z*sa; float nz=pos.x*sa+pos.z*ca;pos.x=nx; pos.z=nz;vec4 mv=modelViewMatrix*vec4(pos,1.0);float sizeE=0.3+energy*1.8+peak*0.5+uFlash*0.2;float sz=aSizeBase*sizeE*uAlive;if(layer>1.5)sz*=(0.7+radius*0.3);gl_PointSize=sz*(400.0/(-mv.z));gl_Position=projectionMatrix*mv;float bandT=aBand/${CONFIG.bands}.0;float hue=mix(15.0,50.0,bandT);if(bandT>0.6) hue=mix(50.0,220.0,(bandT-0.6)/0.4);hue+=hash(aPhase*100.0)*12.0-6.0;float sat=0.85+(layer<0.5?0.1:layer<1.5?0.0:-0.2);float lit=0.4+(layer<0.5?0.18:layer<1.5?0.08:-0.05);float brightness=(0.1+energy*0.9+peak*0.25+uFlash*0.08)*uAlive;float prox=layer<0.5?1.4:clamp(1.0-radius*0.5,0.2,1.0);brightness*=prox;vColor=hsl2rgb(hue,clamp(sat,0.0,1.0),clamp(lit,0.0,1.0))*brightness;vAlpha=clamp(brightness*(layer<0.5?0.9:layer<1.5?0.7:0.4),0.0,1.0);}`;
            const PARTICLE_FS = `varying vec3 vColor; varying float vAlpha;void main(){float d=length(gl_PointCoord-0.5)*2.0;float core=1.0-smoothstep(0.0,0.25,d);float glow=1.0-smoothstep(0.0,1.0,d);float alpha=(core*0.85+glow*0.35)*vAlpha;alpha=pow(alpha,1.15);if(alpha<0.003)discard;gl_FragColor=vec4(vColor*(core*1.3+glow*0.5),alpha*0.85);}`;

            const pGeo = new THREE.BufferGeometry();
            const arrays = {
                y: new Float32Array(total), r: new Float32Array(total),
                vel: new Float32Array(total), phase: new Float32Array(total),
                band: new Float32Array(total), layer: new Float32Array(total),
                size: new Float32Array(total), pos: new Float32Array(total * 3)
            };

            let idx = 0;
            const fill = (count, layer, rBase, rVar, vBase, vVar, sBase, sVar) => {
                for (let i = 0; i < count; i++, idx++) {
                    arrays.layer[idx] = layer; arrays.band[idx] = Math.floor(Math.random() * CONFIG.bands); arrays.phase[idx] = Math.random() * 6.2832;
                    arrays.y[idx] = (arrays.band[idx] + Math.random()) / CONFIG.bands; arrays.r[idx] = rBase + Math.random() * rVar;
                    arrays.vel[idx] = (vBase + Math.random() * vVar) * (Math.random() < 0.5 ? 1 : -1); arrays.size[idx] = sBase + Math.random() * sVar;
                }
            };

            fill(CONFIG.particles.plasma, 0, 0.02, 0.12, 1.2, 3.0, 0.014, 0.018);
            fill(CONFIG.particles.aura, 1, 0.1, 0.5, 0.3, 1.4, 0.02, 0.03);
            fill(CONFIG.particles.wisp, 2, 0.4, 1.3, 0.06, 0.3, 0.03, 0.05);

            pGeo.setAttribute('position', new THREE.BufferAttribute(arrays.pos, 3));
            pGeo.setAttribute('aHomeY', new THREE.BufferAttribute(arrays.y, 1));
            pGeo.setAttribute('aHomeR', new THREE.BufferAttribute(arrays.r, 1));
            pGeo.setAttribute('aAngVel', new THREE.BufferAttribute(arrays.vel, 1));
            pGeo.setAttribute('aPhase', new THREE.BufferAttribute(arrays.phase, 1));
            pGeo.setAttribute('aBand', new THREE.BufferAttribute(arrays.band, 1));
            pGeo.setAttribute('aLayer', new THREE.BufferAttribute(arrays.layer, 1));
            pGeo.setAttribute('aSizeBase', new THREE.BufferAttribute(arrays.size, 1));

            this.scene.add(new THREE.Points(pGeo, new THREE.ShaderMaterial({ uniforms: this.pUniforms, vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
        }

        bindEvents() {
            window.addEventListener('resize', () => {
                const w = window.innerWidth, h = window.innerHeight;
                this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
                this.renderer.setSize(w, h); this.composer.setSize(w, h);
                this.bloom.resolution.set(w, h);
            });
        }

        animate(now) {
            requestAnimationFrame(this.animate);
            const dt = Math.min(0.05, (now - this.lastTime) / 1000 || 0.016);
            this.lastTime = now;

            this.audio.updateTime(dt);
            this.updateScene(now * 0.001);

            // Gentle Camera Sway
            const dr = now * 0.000018;
            this.camera.position.x = MathUtils.lerp(this.camera.position.x, Math.sin(dr) * 0.4, 0.003);
            this.camera.position.y = MathUtils.lerp(this.camera.position.y, 2.2 + Math.cos(dr * 0.55) * 0.06, 0.003);

            this.controls.update();
            this.composer.render();
        }

        updateScene(t_s) {
            const aud = this.audio;
            const sm = aud.smoothed;
            const alive = MathUtils.smoothstep(0.01, 0.10, sm.loudNorm);
            const spineHeight = MathUtils.lerp(CONFIG.spine.minH, CONFIG.spine.maxH, sm.pitchNorm * 0.5 + sm.loudNorm * 0.5) * alive * (1 + aud.state.loudEnvelope * 0.12 + Math.sin(aud.breathPhase * 1.1) * 0.02);
            const wobDamp = 1 - sm.pitchConf * 0.65;
            const vib = aud.state.vibratoDepth * 0.05;

            // Color Palette Selection
            let sHue, sSat, sLit;
            if(sm.centroidNorm < 0.25) { sHue=25; sSat=0.9; sLit=0.45; }
            else if(sm.centroidNorm < 0.5) { sHue=32; sSat=0.92; sLit=0.52; }
            else if(sm.centroidNorm < 0.75) { sHue=38; sSat=0.88; sLit=0.55; }
            else { sHue=42; sSat=0.8; sLit=0.6; }

            // Spine Computation
            for(let i=0; i<CONFIG.spine.rings; i++) {
                const t = i / (CONFIG.spine.rings - 1);
                this.spinePts[i].x = Math.sin(t*5 + aud.breathPhase*1.8)*vib*t + Math.sin(t*2 + t_s*0.4)*0.01*wobDamp;
                this.spinePts[i].y = t * spineHeight;
                this.spinePts[i].z = Math.cos(t*4.5 + aud.breathPhase*1.4)*vib*t*0.6 + Math.cos(t*1.7 + t_s*0.3)*0.007*wobDamp;
            }

            // Update Spine Geometry
            for(let ring=0; ring<CONFIG.spine.rings; ring++) {
                const t = ring / (CONFIG.spine.rings - 1);
                const p = this.spinePts[ring];
                const taper = 1 - t*0.55;
                const radius = (0.06 + sm.loudNorm*0.06 + sm.onset*0.03)*taper*alive;
                const glow = MathUtils.smoothstep(0, 0.7, t)*(0.4 + sm.pitchConf*0.55 + aud.transientFlash*0.15);
                const cOut = MathUtils.hsl(sHue + t*25, sSat*0.85, sLit*0.65*glow);
                const cIn = MathUtils.hsl(sHue + t*12, sSat*0.5, Math.min(1, (sLit+0.2)*glow));

                for(let s=0; s<CONFIG.spine.segs; s++) {
                    const a = (s/CONFIG.spine.segs) * Math.PI*2;
                    const vi = (ring*CONFIG.spine.segs + s)*3;
                    const px = p.x + Math.cos(a)*radius, py = p.y, pz = p.z + Math.sin(a)*radius;

                    this.spPos[vi] = px; this.spPos[vi+1] = py; this.spPos[vi+2] = pz;
                    this.spCol[vi] = cOut.r*glow; this.spCol[vi+1] = cOut.g*glow; this.spCol[vi+2] = cOut.b*glow;

                    const rIn = radius * 0.5;
                    this.sp2Pos[vi] = p.x + Math.cos(a)*rIn; this.sp2Pos[vi+1] = py; this.sp2Pos[vi+2] = p.z + Math.sin(a)*rIn;
                    this.sp2Col[vi] = cIn.r*glow; this.sp2Col[vi+1] = cIn.g*glow; this.sp2Col[vi+2] = cIn.b*glow;
                }
            }
            this.spGeo.attributes.position.needsUpdate = true; this.spGeo.attributes.color.needsUpdate = true;
            this.spGeo2.attributes.position.needsUpdate = true; this.spGeo2.attributes.color.needsUpdate = true;

            // Core & Lights
            const tip = this.spinePts[CONFIG.spine.rings - 1];
            const os = MathUtils.clamp((0.45 + sm.loudNorm*0.7 + sm.pitchConf*0.5 + aud.transientFlash*0.3)*alive, 0.08, 2.0);

            this.core.orb.position.set(tip.x, tip.y, tip.z); this.core.orb.scale.setScalar(os);
            this.core.halo.position.copy(tip); this.core.halo.scale.setScalar(os*1.8);
            this.core.outer.position.copy(tip); this.core.outer.scale.setScalar(os*2.5);
            this.core.inner.position.copy(tip); this.core.inner.scale.setScalar(os*0.4);

            this.core.orb.material.opacity = 0.25 + sm.pitchConf*0.5 + aud.transientFlash*0.15;
            this.core.halo.material.opacity = MathUtils.clamp(0.06 + sm.loudNorm*0.12 + aud.transientFlash*0.08, 0, 0.28);

            this.lights.core.position.set(tip.x*0.5, tip.y*0.5, tip.z+0.4);
            this.lights.core.intensity = 0.1 + sm.loudNorm*0.9 + sm.pitchConf*0.4 + aud.transientFlash*0.3;
            this.lights.core.color.setHSL((sHue%360)/360, sSat*0.8, 0.55);

            this.groundMat.uniforms.uTime.value = t_s;
            this.groundMat.uniforms.uEnergy.value = sm.loudNorm;

            // Update Ribbons
            for (let ri = 0; ri < CONFIG.ribbons.count; ri++) {
                const rb = this.ribbons[ri];
                const e = aud.sBandE[rb.band], pk = aud.peakBoost[rb.band];
                const active = (0.15 + e*0.85 + pk*0.3) * alive;

                rb.mat.opacity = (rb.isWarm ? 0.04 : 0.025) + active * (rb.isWarm ? 0.12 : 0.06) + aud.transientFlash*0.02;
                const rRadius = rb.baseRadius * (0.5 + alive*0.5 + e*0.8 + pk*0.3 + aud.transientFlash*0.2);
                const timeOff = t_s * rb.speedMul;

                for (let s = 0; s < CONFIG.ribbons.segs; s++) {
                    const t = s / (CONFIG.ribbons.segs - 1);
                    const spIdx = Math.floor(t * (CONFIG.spine.rings - 1));
                    const sp = this.spinePts[MathUtils.clamp(spIdx, 0, CONFIG.spine.rings - 1)];

                    const angle = rb.baseAngle + t*rb.spiralRate*3.14159 + timeOff*rb.spiralRate*0.3 + Math.sin(aud.breathPhase*0.6+rb.phase)*0.3*(0.3+sm.pitchConf*0.7);
                    const rr = rRadius * (0.7 + 0.3*Math.sin(t*6 + aud.breathPhase*1.4 + rb.phase)) * (1 - t*0.3);
                    const cx = sp.x + Math.cos(angle)*rr, cz = sp.z + Math.sin(angle)*rr;
                    const w = rb.width * (0.4 + e*2.5 + pk*0.8) * alive * (1 - t*0.4);
                    const px = -Math.sin(angle), pz = Math.cos(angle);

                    const vi = s * 6;
                    rb.pos[vi] = cx - px*w; rb.pos[vi+1] = t*spineHeight; rb.pos[vi+2] = cz - pz*w;
                    rb.pos[vi+3] = cx + px*w; rb.pos[vi+4] = t*spineHeight; rb.pos[vi+5] = cz + pz*w;

                    const edgeFade = (0.3 + 0.7*Math.sin(t*3.14159)) * active;
                    let cr, cg, cb;
                    if(rb.isWarm){
                        const c = MathUtils.hsl(sHue + t*20 + (1-e)*10, sSat*0.9, sLit*0.7*edgeFade);
                        cr=c.r; cg=c.g; cb=c.b;
                    } else {
                        const c = MathUtils.hsl(200 + t*30, 0.7, 0.4*edgeFade);
                        cr=c.r; cg=c.g; cb=c.b;
                    }
                    rb.col[vi]=cr; rb.col[vi+1]=cg; rb.col[vi+2]=cb;
                    rb.col[vi+3]=cr*0.8; rb.col[vi+4]=cg*0.8; rb.col[vi+5]=cb*0.8;
                }
                rb.geo.attributes.position.needsUpdate = true; rb.geo.attributes.color.needsUpdate = true;
            }

            // Update GPU Particles
            this.pUniforms.uTime.value = t_s;
            this.pUniforms.uBands.value.set(aud.sBandE);
            this.pUniforms.uPeaks.value.set(aud.peakBoost);
            this.pUniforms.uLoud.value = sm.loudNorm;
            this.pUniforms.uPitchConf.value = sm.pitchConf;
            this.pUniforms.uFlash.value = aud.transientFlash;
            this.pUniforms.uAlive.value = alive;
            this.pUniforms.uSpineH.value = spineHeight;
            this.pUniforms.uBreath.value = aud.breathPhase;

            // Bloom adjust
            this.bloom.strength = MathUtils.lerp(this.bloom.strength, 0.9 + sm.pitchConf*0.4 + aud.transientFlash*0.5 + sm.loudNorm*0.4, 0.06);
            this.bloom.threshold = MathUtils.lerp(this.bloom.threshold, 0.35 - aud.transientFlash*0.1, 0.05);
        }
    }

window.VisualizerEngine = VisualizerEngine;
