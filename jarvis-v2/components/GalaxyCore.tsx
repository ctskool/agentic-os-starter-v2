"use client";

import {visibleFrames} from '../../obsidian-v2/shared/visible-frames';

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { CoreMode } from "./GraphCore";
import { GALAXY_VARIANTS, type GalaxyVariant } from "@/lib/galaxyVariants";

// A deterministic stellar disk. State changes take place in the
// shader; no per-particle allocations or React updates in the render loop.
export default function GalaxyCore({ mode = "idle", paused = false, variant = "tight", getLevel }: { mode?: CoreMode; paused?: boolean; variant?: GalaxyVariant; getLevel?:()=>number|null }) {
  const mount = useRef<HTMLDivElement>(null);
  const feel = useRef({ mode, paused, getLevel });
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => { feel.current = { mode, paused, getLevel }; }, [mode, paused, getLevel]);

  useEffect(() => {
    const element = mount.current;
    if (!element) return;
    setUnavailable(false);
    const shape = GALAXY_VARIANTS[variant];
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false }); }
    catch { setUnavailable(true); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    renderer.setClearColor(0x060708, 0);
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(43, 1, 0.1, 60);
    camera.position.z = 10;
    camera.zoom = 1.12;
    const disk = new THREE.Group();
    disk.rotation.set(0.34, -0.12, -0.3);
    scene.add(disk);
    let seed = 2718;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 0.00001))) * Math.cos(random() * Math.PI * 2);
    const count = innerWidth < 700 ? 19000 : 37000;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const radius = Math.pow(random(), 0.72) * shape.radius;
      const arm = (i % shape.arms) * Math.PI * 2 / shape.arms;
      const scatter = normal() * (0.10 + radius * 0.06) * shape.width;
      const theta = arm + radius * shape.winding + scatter / Math.max(radius, 0.25);
      const diffuse = random() < 0.16;
      const angle = diffuse ? random() * Math.PI * 2 : theta;
      positions[i * 3] = Math.cos(angle) * radius + normal() * 0.018;
      positions[i * 3 + 1] = Math.sin(angle) * radius + normal() * 0.018;
      positions[i * 3 + 2] = normal() * (diffuse ? 0.13 : 0.055) * (1.15 - radius / 4);
      seeds[i] = random();
      sizes[i] = random() > 0.968 ? 7 + random() * 10 : 0.8 + Math.pow(random(), 2.6) * 3;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uEnergy: { value: 0 }, uVoice: { value: 0 }, uListen: { value: 0 }, uRatio: { value: renderer.getPixelRatio() }, uBloom: { value: 0 } },
      vertexShader: `
        attribute float aSeed; attribute float aSize;
        uniform float uTime; uniform float uEnergy; uniform float uVoice; uniform float uListen; uniform float uRatio; uniform float uBloom;
        varying float vAlpha; varying float vSize;
        void main() {
          float r = length(position.xy);
          vec3 p = position;
          p.xy *= 1.0 - uListen * 0.065;
          float wave = sin(r * 5.0 - uTime * 3.0);
          vAlpha = (0.35 + aSeed * 0.65) * (0.85 + 0.15 * sin(uTime * 0.6 + aSeed * 90.0));
          vAlpha *= 1.0 + uEnergy * (0.5 + wave * 0.5);
          // The voice lights the galaxy from its centre: strongest at the core, gone by the outer arms.
          vAlpha *= 1.0 + uVoice * 0.65 * exp(-r * r * 0.55);
          vSize = aSize;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(aSize * mix(1.0, 3.2, uBloom) * uRatio * (9.0 / -mv.z), 1.0, 80.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uBloom;
        varying float vAlpha; varying float vSize;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          float core = exp(-d*d*12.0);
          float halo = exp(-d*d*3.5) * 0.30;
          float a = (core + halo) * vAlpha;
          a = mix(a, exp(-d*d*5.0) * 0.12 * vAlpha, uBloom);
          a *= 1.0 - smoothstep(0.75, 1.0, d);
          gl_FragColor = vec4(vec3(0.96, 0.975, 1.0), a);
        }`,
    });
    disk.add(new THREE.Points(geometry, material));

    // A small second layer gives the bright stellar clusters soft bloom,
    // without a full-screen postprocessing pass or blurring the fine dust.
    const brightPositions: number[] = [], brightSeeds: number[] = [], brightSizes: number[] = [];
    for (let i = 0; i < count; i++) {
      if (sizes[i] < 7) continue;
      brightPositions.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      brightSeeds.push(seeds[i]); brightSizes.push(sizes[i]);
    }
    const bloomGeometry = new THREE.BufferGeometry();
    bloomGeometry.setAttribute("position", new THREE.Float32BufferAttribute(brightPositions, 3));
    bloomGeometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(brightSeeds, 1));
    bloomGeometry.setAttribute("aSize", new THREE.Float32BufferAttribute(brightSizes, 1));
    const bloomMaterial = material.clone();
    // Share animation uniforms so every cluster moves with its visible star.
    bloomMaterial.uniforms = { ...material.uniforms, uBloom: { value: 1 } };
    disk.add(new THREE.Points(bloomGeometry, bloomMaterial));

    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = textureCanvas.height = 128;
    const ctx = textureCanvas.getContext("2d")!;
    const glow = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    glow.addColorStop(0, "rgba(255,255,255,1)");
    glow.addColorStop(0.1, "rgba(255,255,255,.98)");
    glow.addColorStop(0.24, "rgba(240,243,255,.5)");
    glow.addColorStop(0.5, "rgba(230,235,255,.10)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow; ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(textureCanvas);
    const nucleusMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const nucleus = new THREE.Sprite(nucleusMaterial);
    nucleus.scale.setScalar(1.3);
    scene.add(nucleus);
    const auraMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.1 });
    const aura = new THREE.Sprite(auraMaterial);
    aura.scale.setScalar(3.5); scene.add(aura);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let dirty = true, drew = false, lastMode = "";
    const resize = () => {
      dirty = true;
      const w = element.clientWidth, h = element.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h); camera.aspect = w / h;
      camera.position.z = w < 700 ? 12.5 : 10;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const frames=visibleFrames(element);
    let frame = 0, time = 0, breathTime = 0, voice = 0, previous = performance.now(), lastDraw = 0;
    const animate = (now: number) => {
      frame = frames.request(animate);
      const dt = Math.min((now - previous) / 1000, 0.05); previous = now;
      if (document.hidden || !element.getClientRects().length || now - lastDraw < 30) return;
      const drawDt = Math.min((now - lastDraw) / 1000, 0.1);
      lastDraw = now;
      const { mode: current, paused: isPaused } = feel.current;
      const still = reduced.matches || isPaused;
      if (still && drew && !dirty && lastMode === current) return;
      dirty = false; drew = true; lastMode = current;
      if (!still) time += dt * (current === "working" ? 1.8 : 0.65);
      if (!still) breathTime += drawDt;
      // Real playback level (0..1) while Astra speaks; a speech-like stand-in when no analyser is available.
      const heard = current === "speaking" && !still ? Math.min(1, Math.max(0, feel.current.getLevel?.() ?? (0.45 + Math.sin(time * 7) * 0.3 + Math.sin(time * 17) * 0.15))) : 0;
      voice += (heard - voice) * (heard > voice ? 0.5 : 0.12);
      const target = current === "speaking" ? 0.35 + voice * 0.3 : current === "working" ? 0.45 : current === "listening" ? 0.25 : 0;
      material.uniforms.uEnergy.value += (target - material.uniforms.uEnergy.value) * 0.08;
      material.uniforms.uVoice.value = voice;
      material.uniforms.uListen.value += ((current === "listening" ? 1 : 0) - material.uniforms.uListen.value) * 0.05;
      material.uniforms.uTime.value = time;
      disk.rotation.z = -0.3 + time * 0.045 * 1.25;
      // One quiet breath every eight seconds; pause and reduced motion freeze it.
      const breath = 0.5 + 0.5 * Math.sin(breathTime * Math.PI / 4);
      // The core glow swells and brightens with each word; the wide aura answers more softly.
      nucleus.scale.setScalar(1.60 + breath * 0.14 + material.uniforms.uEnergy.value * 0.25 + voice * 0.32);
      nucleusMaterial.opacity = current === "error" ? 0.45 : Math.min(1, 0.82 + breath * 0.12 + voice * 0.1);
      aura.scale.setScalar(3.3 + breath * 0.3 + voice * 0.8);
      auraMaterial.opacity = current === "error" ? 0.04 : 0.09 + breath * 0.04 + voice * 0.08;
      renderer.render(scene, camera);
    };
    frame = frames.request(animate);
    const lost = (event: Event) => { event.preventDefault(); setUnavailable(true); };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    return () => {
      frames.dispose(); observer.disconnect();
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      geometry.dispose(); material.dispose(); texture.dispose(); nucleusMaterial.dispose();
      bloomGeometry.dispose(); bloomMaterial.dispose();
      auraMaterial.dispose(); renderer.dispose(); renderer.domElement.remove();
    };
  }, [variant]);

  return <div className="galaxy-core" data-variant={variant} aria-hidden={!unavailable}>
    <div ref={mount} className="galaxy-canvas" />
    {unavailable && <div className="galaxy-fallback"><span />Galaxy animation unavailable. Dashboard controls remain available.</div>}
  </div>;
}
