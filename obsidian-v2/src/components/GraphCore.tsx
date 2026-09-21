
import {visibleFrames,watchWebGLContext} from '../../shared/visible-frames';
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// ---------------------------------------------------------------------------
// GRAPH CORE — ported from jarvis-hud/components/GraphCore.tsx (Preact build).
// Volumetric knowledge-graph cloud: ~2200 nodes, center-dense, linked to
// nearest neighbors, constant slow rotation + per-node wander, speech pulses
// brightness across the whole cloud, UnrealBloom for the glow.
// Cockpit differences vs the HUD original:
//  - hue voyage writes --cc-orb-h on the .aos-v2-cc-root ancestor, not
//    documentElement (don't repaint the rest of Obsidian)
//  - `bloom` prop: UnrealBloomPass half-float FBOs corrupt on some
//    ANGLE/D3D stacks — off falls back to a plain render pass
//  - ResizeObserver on the mount (pane resizes don't fire window resize)
// ---------------------------------------------------------------------------

export type CoreMode = "idle" | "working" | "listening" | "speaking" | "error";
export type BgMode = "flat" | "depth" | "grid" | "nebula";
export const BG_MODES: BgMode[] = ["flat", "depth", "grid", "nebula"];

interface ModeFeel {
	speed: number; // rotation/drift multiplier
	boost: number; // brightness multiplier
	hueRate: number; // hue cycle multiplier
}

const FEELS: Record<CoreMode, ModeFeel> = {
	idle: { speed: 1, boost: 1, hueRate: 1 },
	working: { speed: 1.7, boost: 1.25, hueRate: 2.2 },
	listening: { speed: 1.2, boost: 1.1, hueRate: 0.6 },
	speaking: { speed: 1.3, boost: 1.15, hueRate: 1 },
	error: { speed: 1.8, boost: 1.2, hueRate: 0 },
};

const ERROR_HUE = 0.015;

const CLOUD_R = 1.5;
const N_NODES = 2200;
const LINKS_PER_NODE = 2;

const NODE_VERT = /* glsl */ `
uniform float uTime;
uniform float uPx;
uniform float uBig;
attribute float aSeed;
varying float vR;
varying float vSeed;
void main() {
  vR = length(position) / ${CLOUD_R.toFixed(2)};
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float big = step(0.86, fract(aSeed * 7.13)); // 14% are hub nodes
  gl_PointSize = (0.5 + big * uBig) * (58.0 / -mv.z) * uPx;
  gl_Position = projectionMatrix * mv;
}
`;

const NODE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uBoost;
uniform float uLevel;
uniform float uHue;
uniform vec3 uInner;
uniform vec3 uOuter;
varying float vR;
varying float vSeed;
vec3 hsl2rgb(vec3 hsl) {
  vec3 rgb = clamp(abs(mod(hsl.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return hsl.z + hsl.y * (rgb - 0.5) * (1.0 - abs(2.0 * hsl.z - 1.0));
}
uniform float uEdge;
uniform float uCore;
uniform float uAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float alpha = smoothstep(0.5, uEdge, length(c));
  vec3 col = mix(uInner, uOuter, smoothstep(0.0, 0.95, vR));
  // speaking: nodes shimmer within ±~40° of the current accent hue
  float off = (fract(vSeed * 3.17) - 0.5) * 0.22 + 0.04 * sin(uTime * 0.9 + vSeed * 31.0);
  vec3 shimmer = hsl2rgb(vec3(fract(uHue + off), 0.8, 0.62));
  col = mix(col, shimmer, uLevel * 0.55);
  // white-hot center — nodes near the core bleach toward white for contrast.
  // uCore scales it down in compact: at widget size the bleach + additive
  // stacking fuses into one white blob
  col = mix(col, vec3(1.0), uCore * (1.0 - smoothstep(0.05, 0.5, vR)));
  // twinkle — every node flickers on its own clock
  alpha *= 0.3 + 0.7 * (0.5 + 0.5 * sin(uTime * (1.0 + vSeed * 2.5) + vSeed * 43.0));
  // speaking: brightness waves ripple outward from the center per syllable
  alpha *= 1.0 + uLevel * 0.45 * sin(vR * 9.0 - uTime * 5.5);
  alpha *= uBoost;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0) * uAlpha);
}
`;

// synthetic speech envelope — syllable bursts with pauses
function fakeSpeechLevel(): number {
	const t = performance.now() * 0.001;
	const gate = Math.sin(t * 0.9) > -0.6 ? 1 : 0.08;
	const syllables =
		(0.45 + 0.55 * Math.sin(t * 6.1)) * (0.4 + 0.6 * Math.sin(t * 2.3));
	return gate * Math.max(0, syllables);
}

function glowTexture(doc:Document): THREE.Texture {
	const size = 256;
	const canvas = doc.createElement("canvas");
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	const g = ctx.createRadialGradient(
		size / 2,
		size / 2,
		0,
		size / 2,
		size / 2,
		size / 2,
	);
	g.addColorStop(0, "rgba(255,255,255,1)");
	g.addColorStop(0.25, "rgba(255,255,255,0.4)");
	g.addColorStop(0.6, "rgba(255,255,255,0.08)");
	g.addColorStop(1, "rgba(255,255,255,0)");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, size, size);
	return new THREE.CanvasTexture(canvas);
}

export function GraphCore({
	mode = "idle",
	bgMode = "depth",
	bloom: useBloom = true,
	compact = false,
	paused = false,
	getLevel,
}: {
	mode?: CoreMode;
	bgMode?: BgMode;
	/** UnrealBloom half-float FBOs corrupt on some ANGLE/D3D stacks — escape hatch */
	bloom?: boolean;
	/** small floating-widget tuning: transparent canvas, full DPR, tighter
	 *  points, closer camera, gentler bloom — soft discs read as blobs at
	 *  130px, crisp ones don't */
	compact?: boolean;
	paused?: boolean;
	/** real speech envelope 0..1, or null when no audio is playing */
	getLevel?: () => number | null;
}) {
	const mountRef = useRef<HTMLDivElement>(null);
	const [unavailable,setUnavailable]=useState(false);
	const modeRef = useRef<CoreMode>(mode);
	const bgRef = useRef<BgMode>(bgMode);
	const getLevelRef = useRef(getLevel);
	const pausedRef = useRef(paused);
	pausedRef.current = paused;
	modeRef.current = mode;
	bgRef.current = bgMode;
	getLevelRef.current = getLevel;

	useEffect(() => {
		const mount = mountRef.current;
		if (!mount) return;
		const view=mount.ownerDocument.defaultView||window;
		setUnavailable(false);
		// accent hue target: the cockpit shell, not documentElement
		const accentRoot = mount.closest<HTMLElement>(
			".aos-v2-cc-orb-root, .aos-v2-cc-root",
		);
		// compact: thinner cloud — full density has no room to breathe at 124px
		const nNodes = compact ? 1300 : N_NODES;

		let renderer:THREE.WebGLRenderer;
		try{renderer = new THREE.WebGLRenderer({
			canvas:mount.ownerDocument.createElement('canvas'),
			antialias: false,
			alpha: compact,
		})}catch{setUnavailable(true);return}
		// compact: full DPR — the small widget lives or dies on sharpness
		renderer.setPixelRatio(
			compact
				? Math.min(view.devicePixelRatio, 2.5)
				: Math.min(view.devicePixelRatio, 1.75),
		);
		renderer.setSize(Math.max(1,mount.clientWidth), Math.max(1,mount.clientHeight));
		mount.appendChild(renderer.domElement);

		const scene = new THREE.Scene();
		if (!compact) scene.background = new THREE.Color("#0a0909");

		const cloudY = compact ? 0 : 0.32;
		const camera = new THREE.PerspectiveCamera(
			45,
			Math.max(1,mount.clientWidth) / Math.max(1,mount.clientHeight),
			0.1,
			100,
		);
		camera.position.set(0, 0, compact ? 4.1 : 5.7);

		const cloud = new THREE.Group();
		cloud.position.y = cloudY;
		scene.add(cloud);

		// --- nodes: center-dense volumetric cloud ------------------------------
		const base = new Float32Array(nNodes * 3);
		for (let i = 0; i < nNodes; i++) {
			const cosT = Math.random() * 2 - 1;
			const sinT = Math.sqrt(1 - cosT * cosT);
			const phi = Math.random() * Math.PI * 2;
			const r = Math.pow(Math.random(), 0.45) * CLOUD_R;
			base[i * 3] = sinT * Math.cos(phi) * r;
			base[i * 3 + 1] = cosT * r;
			base[i * 3 + 2] = sinT * Math.sin(phi) * r;
		}
		const freq = new Float32Array(nNodes * 3);
		const phase = new Float32Array(nNodes * 3);
		const amp = new Float32Array(nNodes);
		for (let i = 0; i < nNodes; i++) {
			for (let k = 0; k < 3; k++) {
				freq[i * 3 + k] = 0.3 + Math.random() * 0.55;
				phase[i * 3 + k] = Math.random() * Math.PI * 2;
			}
			amp[i] = 0.04 + Math.random() * 0.05;
		}

		const live = new Float32Array(base);
		const nodeGeo = new THREE.BufferGeometry();
		const posAttr = new THREE.BufferAttribute(live, 3);
		posAttr.setUsage(THREE.DynamicDrawUsage);
		nodeGeo.setAttribute("position", posAttr);
		const seeds = new Float32Array(nNodes);
		for (let i = 0; i < nNodes; i++) seeds[i] = Math.random();
		nodeGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

		// uniforms as a typed local — the index-signature type on .uniforms
		// trips noUncheckedIndexedAccess everywhere otherwise
		const nodeUni = {
			uTime: { value: 0 },
			uBoost: { value: 1 },
			uLevel: { value: 0 },
			uHue: { value: 0.62 },
			uPx: { value: compact ? 0.42 : 1 },
			// hub nodes read as "very large circles" at widget size — flatten
			// the size spread so the cloud stays granular
			uBig: { value: compact ? 0.35 : 0.8 },
			uEdge: { value: compact ? 0.42 : 0.22 },
			uCore: { value: compact ? 0.45 : 0.85 },
			uAlpha: { value: compact ? 0.42 : 0.55 },
			uInner: { value: new THREE.Color().setHSL(0.62, 0.65, 0.84) },
			uOuter: { value: new THREE.Color().setHSL(0.62, 0.85, 0.45) },
		};
		const nodeMat = new THREE.ShaderMaterial({
			vertexShader: NODE_VERT,
			fragmentShader: NODE_FRAG,
			uniforms: nodeUni,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		cloud.add(new THREE.Points(nodeGeo, nodeMat));

		// --- edges: each node linked to its nearest neighbors ------------------
		// O(n²) once at init (~5M dist checks, fine); edges then follow drift.
		const edgePairs: number[] = [];
		{
			const seen = new Set<string>();
			const bestIdx = new Array<number>(LINKS_PER_NODE);
			const bestD = new Array<number>(LINKS_PER_NODE);
			for (let i = 0; i < nNodes; i++) {
				bestIdx.fill(-1);
				bestD.fill(Infinity);
				const ix = base[i * 3]!;
				const iy = base[i * 3 + 1]!;
				const iz = base[i * 3 + 2]!;
				for (let j = 0; j < nNodes; j++) {
					if (j === i) continue;
					const dx = base[j * 3]! - ix;
					const dy = base[j * 3 + 1]! - iy;
					const dz = base[j * 3 + 2]! - iz;
					const d = dx * dx + dy * dy + dz * dz;
					for (let k = 0; k < LINKS_PER_NODE; k++) {
						if (d < bestD[k]!) {
							for (let m = LINKS_PER_NODE - 1; m > k; m--) {
								bestD[m] = bestD[m - 1]!;
								bestIdx[m] = bestIdx[m - 1]!;
							}
							bestD[k] = d;
							bestIdx[k] = j;
							break;
						}
					}
				}
				for (let k = 0; k < LINKS_PER_NODE; k++) {
					const j = bestIdx[k]!;
					if (j < 0) continue;
					const key = i < j ? `${i}:${j}` : `${j}:${i}`;
					if (!seen.has(key)) {
						seen.add(key);
						edgePairs.push(i, j);
					}
				}
			}
		}
		const E = edgePairs.length / 2;
		const edgePos = new Float32Array(E * 6);
		const edgeGeo = new THREE.BufferGeometry();
		const edgeAttr = new THREE.BufferAttribute(edgePos, 3);
		edgeAttr.setUsage(THREE.DynamicDrawUsage);
		edgeGeo.setAttribute("position", edgeAttr);
		const edgeMat = new THREE.LineBasicMaterial({
			color: new THREE.Color().setHSL(0.62, 0.8, 0.55),
			transparent: true,
			opacity: 0.14,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
		});
		cloud.add(new THREE.LineSegments(edgeGeo, edgeMat));

		// --- ambient halo ------------------------------------------------------
		const tex = glowTexture(mount.ownerDocument);
		const halo = new THREE.Sprite(
			new THREE.SpriteMaterial({
				map: tex,
				color: "#1d3fb8",
				transparent: true,
				opacity: 0.16,
				blending: THREE.AdditiveBlending,
				depthWrite: false,
			}),
		);
		halo.material.opacity = 0.09;
		halo.scale.setScalar(3.0);
		// compact: no halo at all — a 124px additive glow sprite IS the blob
		if (!compact) cloud.add(halo);

		// --- background layers (toggled by bgMode) -----------------------------
		const bgGlow = new THREE.Sprite(
			new THREE.SpriteMaterial({
				map: tex,
				color: "#1d3fb8",
				transparent: true,
				opacity: 0.07,
				depthWrite: false,
			}),
		);
		bgGlow.position.set(0, 0.32, -2.2);
		bgGlow.scale.setScalar(9);
		scene.add(bgGlow);

		const DUST = 420;
		const dustGeo = new THREE.BufferGeometry();
		const dustPts = new Float32Array(DUST * 3);
		for (let i = 0; i < DUST; i++) {
			dustPts[i * 3] = (Math.random() - 0.5) * 18;
			dustPts[i * 3 + 1] = (Math.random() - 0.5) * 10 + 0.32;
			dustPts[i * 3 + 2] = -2.5 - Math.random() * 6.5;
		}
		dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPts, 3));
		const dustMat = new THREE.PointsMaterial({
			color: "#7a8cc8",
			size: 0.018,
			transparent: true,
			opacity: 0.35,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const dust = new THREE.Points(dustGeo, dustMat);
		scene.add(dust);

		const gridPts: number[] = [];
		const GHALF = 11;
		const GSTEP = 0.55;
		const GY = -2.4;
		for (let v = -GHALF; v <= GHALF + 0.001; v += GSTEP) {
			gridPts.push(-GHALF, GY, v, GHALF, GY, v);
			gridPts.push(v, GY, -GHALF, v, GY, GHALF);
		}
		const gridGeo = new THREE.BufferGeometry();
		gridGeo.setAttribute(
			"position",
			new THREE.BufferAttribute(new Float32Array(gridPts), 3),
		);
		const gridMat = new THREE.LineBasicMaterial({
			color: "#2f5ce0",
			transparent: true,
			opacity: 0.13,
			depthWrite: false,
			fog: true,
		});
		const grid = new THREE.LineSegments(gridGeo, gridMat);
		scene.add(grid);

		const nebUni = {
			uTime: { value: 0 },
			uCol: { value: new THREE.Color("#16307a") },
		};
		const nebMat = new THREE.ShaderMaterial({
			vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
			fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCol;
        varying vec2 vUv;
        float hash(vec2 p) {
          p = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
          p += dot(p, p + 19.19);
          return fract(p.x * p.y);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1, 0)), f.x),
            mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x),
            f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * vnoise(p);
            p *= 2.1;
            a *= 0.5;
          }
          return v;
        }
        void main() {
          vec2 uv = vUv * 3.4;
          float n = fbm(uv + vec2(uTime * 0.018, -uTime * 0.011));
          n = smoothstep(0.35, 0.95, n);
          float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x)
                     * smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
          gl_FragColor = vec4(uCol, n * edge * 0.34);
        }`,
			uniforms: nebUni,
			transparent: true,
			depthWrite: false,
		});
		const nebula = new THREE.Mesh(new THREE.PlaneGeometry(20, 11.5), nebMat);
		nebula.position.set(0, 0.32, -3.2);
		scene.add(nebula);

		// --- post: bloom (optional — see prop doc) -----------------------------
		let composer: EffectComposer | null = null;
		let bloomPass: UnrealBloomPass | null = null;
		if (useBloom) {
			composer = new EffectComposer(renderer);
			composer.addPass(new RenderPass(scene, camera));
			// compact: gentler glow — bloom at widget scale smears the detail
			bloomPass = new UnrealBloomPass(
				new THREE.Vector2(Math.max(1,mount.clientWidth), Math.max(1,mount.clientHeight)),
				compact ? 0.2 : 0.45,
				compact ? 0.25 : 0.5,
				compact ? 0.4 : 0.2,
			);
			composer.addPass(bloomPass);
			composer.addPass(new OutputPass());
		}

		// --- interaction -------------------------------------------------------
		const target = { x: 0, y: 0 };
		const onMouse = (e: MouseEvent) => {
			target.x = (e.clientX / view.innerWidth - 0.5) * 0.6;
			target.y = (e.clientY / view.innerHeight - 0.5) * 0.4;
		};
		view.addEventListener("mousemove", onMouse);

		const onResize = () => {
			if (mount.clientWidth === 0 || mount.clientHeight === 0) return;
			drew=false;
			camera.aspect = mount.clientWidth / mount.clientHeight;
			camera.updateProjectionMatrix();
			renderer.setSize(mount.clientWidth, mount.clientHeight);
			composer?.setSize(mount.clientWidth, mount.clientHeight);
		};
		const ro = new view.ResizeObserver(onResize);
		ro.observe(mount);

		const tInner = new THREE.Color();
		const tOuter = new THREE.Color();
		const tEdge = new THREE.Color();

		const clock = new THREE.Clock();
		let level = 0;
		let speed = 1;
		let hue = 0.62;
		let lastT = 0;
		// speed-integrated clock — mode changes alter velocity, never position
		let simT = 0;
		let lastDeg = -1;
    const frames=visibleFrames(mount,error=>{recovery.fail();console.warn('[Agentic OS] Graph rendering paused.',error)});
		let raf = 0;
		let drew = false;
		const reduced = view.matchMedia("(prefers-reduced-motion: reduce)");
		const tick = () => {
			if (drew && (mount.ownerDocument.hidden || !mount.getClientRects().length || pausedRef.current || reduced.matches)) { lastT = clock.getElapsedTime(); raf = frames.request(tick); return; }
			drew = true;
			const t = clock.getElapsedTime();
			const dt = Math.min(t - lastT, 0.1);
			lastT = t;
			const feel = FEELS[modeRef.current];

			// voice envelope — fast attack, soft release; real RMS when live
			let targetLevel = 0;
			if (modeRef.current === "speaking") {
				const real = getLevelRef.current?.();
				targetLevel = real ?? fakeSpeechLevel();
			}
			level += (targetLevel - level) * (targetLevel > level ? 0.5 : 0.12);
			speed += (feel.speed - speed) * 0.03;
			simT += dt * speed;

			if (modeRef.current !== "error") {
				hue = (hue + dt * (0.014 * feel.hueRate + level * 0.05)) % 1;
			}
			const hh = modeRef.current === "error" ? ERROR_HUE : hue;

			// cockpit chrome may follow the voyage — scoped var, opt-in in CSS
			const deg = Math.round(hh * 360);
			if (deg !== lastDeg && accentRoot) {
				lastDeg = deg;
				accentRoot.style.setProperty("--cc-orb-h", String(deg));
			}

			const ts = simT;
			for (let i = 0; i < nNodes; i++) {
				const a = amp[i]!;
				const i3 = i * 3;
				live[i3] = base[i3]! + a * Math.sin(ts * freq[i3]! + phase[i3]!);
				live[i3 + 1] =
					base[i3 + 1]! + a * Math.sin(ts * freq[i3 + 1]! + phase[i3 + 1]!);
				live[i3 + 2] =
					base[i3 + 2]! + a * Math.sin(ts * freq[i3 + 2]! + phase[i3 + 2]!);
			}
			for (let e = 0; e < E; e++) {
				const ai = edgePairs[e * 2]! * 3;
				const bi = edgePairs[e * 2 + 1]! * 3;
				const o = e * 6;
				edgePos[o] = live[ai]!;
				edgePos[o + 1] = live[ai + 1]!;
				edgePos[o + 2] = live[ai + 2]!;
				edgePos[o + 3] = live[bi]!;
				edgePos[o + 4] = live[bi + 1]!;
				edgePos[o + 5] = live[bi + 2]!;
			}
			posAttr.needsUpdate = true;
			edgeAttr.needsUpdate = true;

			tInner.setHSL(hh, 0.65, 0.84);
			tOuter.setHSL(hh, 0.85, 0.45);
			tEdge.setHSL(hh, 0.8, 0.55);
			nodeUni.uInner.value.lerp(tInner, 0.06);
			nodeUni.uOuter.value.lerp(tOuter, 0.06);
			edgeMat.color.lerp(tEdge, 0.06);

			nodeUni.uTime.value = t;
			nodeUni.uLevel.value = level;
			nodeUni.uHue.value = hh;
			nodeUni.uBoost.value = feel.boost * (1 + level * 0.6);
			edgeMat.opacity = 0.11 + 0.05 * Math.sin(t * 0.7) + level * 0.22;

			const bg = bgRef.current;
			bgGlow.visible = bg !== "flat";
			dust.visible = bg !== "flat";
			grid.visible = bg === "grid";
			nebula.visible = bg === "nebula";
			if (bgGlow.visible) bgGlow.material.color.lerp(tOuter, 0.06);
			if (dust.visible) {
				dust.rotation.z = t * 0.008;
				dustMat.color.lerp(tEdge, 0.06);
			}
			if (grid.visible) gridMat.color.lerp(tEdge, 0.06);
			if (nebula.visible) {
				nebUni.uTime.value = t;
				nebUni.uCol.value.lerp(tOuter, 0.06);
			}

			halo.material.color.copy(nodeUni.uOuter.value);
			halo.material.opacity = (compact ? 0.04 : 0.08) + level * 0.1;

			cloud.rotation.y = simT * 0.1;
			cloud.rotation.x = Math.sin(t * 0.07) * 0.08 + target.y * 0.25;
			if (bloomPass)
				bloomPass.strength = (compact ? 0.2 : 0.45) + level * (compact ? 0.18 : 0.35);

			camera.position.x += (target.x * 1.1 - camera.position.x) * 0.04;
			camera.position.y += (-target.y * 0.7 - camera.position.y) * 0.04;
			camera.lookAt(0, cloudY, 0);

			if (composer) composer.render();
			else renderer.render(scene, camera);
			raf = frames.request(tick);
		};
		const recovery=watchWebGLContext(renderer.domElement,frames,setUnavailable,()=>{drew=false;lastT=clock.getElapsedTime();onResize();frames.request(tick)});
		raf=frames.request(tick);

		return () => {
			recovery.dispose();frames.dispose();
			view.removeEventListener("mousemove", onMouse);
			ro.disconnect();
			nodeGeo.dispose();
			nodeMat.dispose();
			edgeGeo.dispose();
			edgeMat.dispose();
			tex.dispose();
			halo.material.dispose();
			bgGlow.material.dispose();
			dustGeo.dispose();
			dustMat.dispose();
			gridGeo.dispose();
			gridMat.dispose();
			nebula.geometry.dispose();
			nebMat.dispose();
			for(const pass of composer?.passes||[])pass.dispose();
			composer?.dispose();
			renderer.dispose();
			renderer.forceContextLoss();
			renderer.domElement.remove();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [compact,useBloom]);

	return (
		<div className="aos-v2-cc-orb" aria-hidden="true">
			<div ref={mountRef} className="aos-v2-cc-orb-canvas" />
			{unavailable&&<div className="galaxy-fallback">Voice animation unavailable.</div>}
		</div>
	);
}
