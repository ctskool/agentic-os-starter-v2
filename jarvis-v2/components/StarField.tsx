"use client";

import { useEffect, useRef } from "react";

// A still, full-page sky keeps the moving galaxy grounded without adding
// competing motion behind dashboard text. Draw only on resize.
export default function StarField() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    const draw = () => {
      const { width, height } = element.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio, 1.6);
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      let seed = 81173;
      const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const count = Math.min(950, Math.round(width * height / 1700));
      for (let i = 0; i < count; i++) {
        const x = random() * width, y = random() * height;
        const bright = random() > 0.96;
        const radius = bright ? 1 + random() * 0.5 : 0.3 + random() * 0.55;
        const behindText = x < width * 0.28 || x > width * 0.72 || y < height * 0.17 || y > height * 0.76;
        const alpha = (0.18 + random() * 0.48) * (behindText ? 0.58 : 1);
        if (bright) {
          const halo = ctx.createRadialGradient(x, y, 0, x, y, radius * 5);
          halo.addColorStop(0, `rgba(225,229,240,${alpha * 0.22})`);
          halo.addColorStop(1, "rgba(225,229,240,0)");
          ctx.fillStyle = halo;
          ctx.fillRect(x - radius * 5, y - radius * 5, radius * 10, radius * 10);
        }
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(226,230,240,${alpha})`; ctx.fill();
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(element); draw();
    return () => observer.disconnect();
  }, []);
  return <canvas ref={canvas} className="ambient-stars" aria-hidden="true" />;
}
