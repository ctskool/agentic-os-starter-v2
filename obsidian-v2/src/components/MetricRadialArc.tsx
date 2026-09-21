import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

interface Props {
	pct: number; // 0-100+
	rawValue: number;
	budget: number;
}

function formatCompact(n: number): string {
	return new Intl.NumberFormat("en-US", {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(n);
}

function pctToneClass(pct: number): string {
	if (pct >= 90) return "aos-v2-cc-arc-hot";
	if (pct >= 70) return "aos-v2-cc-arc-warm";
	return "aos-v2-cc-arc-cool";
}

/** Smooth animation on percentage change, matches MetricCard's tick-up vibe. */
function useAnimatedNumber(target: number, duration = 700): number {
	const [value, setValue] = useState(target);
	const startRef = useRef(target);
	const firstRender = useRef(true);

	useEffect(() => {
		if (firstRender.current) {
			firstRender.current = false;
			setValue(target);
			startRef.current = target;
			return;
		}
		const from = startRef.current;
		const to = target;
		if (from === to) return;
		const startedAt = performance.now();
		let raf = 0;
		const tick = (now: number) => {
			const t = Math.min(1, (now - startedAt) / duration);
			const eased = 1 - Math.pow(1 - t, 3);
			setValue(from + (to - from) * eased);
			if (t < 1) raf = requestAnimationFrame(tick);
			else startRef.current = to;
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [target, duration]);

	return value;
}

export function MetricRadialArc({ pct, rawValue, budget }: Props) {
	const animated = useAnimatedNumber(pct);
	const clamped = Math.max(0, Math.min(100, animated));

	// Geometry — viewBox 100x100, center 50,50, radius 42, stroke width 6.
	// Circumference = 2 * pi * 42 ≈ 263.89. Sweep from 12 o'clock (rotate -90deg).
	const r = 42;
	const C = 2 * Math.PI * r;
	const offset = C * (1 - clamped / 100);

	const tone = pctToneClass(clamped);

	return (
		<div className="aos-v2-cc-arc-wrap" title={`${formatCompact(rawValue)} / ${formatCompact(budget)} tokens`}>
			<svg
				className={`aos-v2-cc-arc ${tone}`}
				viewBox="0 0 100 100"
				width="100%"
				height="100%"
				aria-label={`${clamped.toFixed(0)} percent of budget`}
			>
				{/* Track */}
				<circle
					cx="50"
					cy="50"
					r={r}
					fill="none"
					stroke="var(--cc-ring)"
					strokeWidth="6"
				/>
				{/* Progress arc — rotate -90 so 0% is at 12 o'clock */}
				<circle
					className="aos-v2-cc-arc-progress"
					cx="50"
					cy="50"
					r={r}
					fill="none"
					strokeWidth="6"
					strokeLinecap="round"
					strokeDasharray={C}
					strokeDashoffset={offset}
					transform="rotate(-90 50 50)"
				/>
			</svg>
			<div className="aos-v2-cc-arc-center">
				<div className="aos-v2-cc-arc-value">
					{clamped.toFixed(0)}
					<span className="aos-v2-cc-arc-unit">%</span>
				</div>
				<div className="aos-v2-cc-arc-sub">
					{formatCompact(rawValue)} / {formatCompact(budget)}
				</div>
			</div>
		</div>
	);
}
