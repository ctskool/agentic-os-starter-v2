import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { MetricSnapshot, SeriesPoint } from "../lib/metrics";
import { MetricRadialArc } from "./MetricRadialArc";

interface Props {
	label: string;
	snapshot: MetricSnapshot | null;
	format?: "currency" | "integer" | "compact" | "percent";
	unit?: string;
	budget?: number; // required when format === "percent"
	hero?: boolean;
	series?: SeriesPoint[];
	tone?: "youtube" | "instagram" | "tiktok" | "neutral";
}

/**
 * Smoothly animates from prior value to next over `duration` ms with ease-out cubic.
 * First render shows target value immediately (no count-up from zero on boot).
 */
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
			const v = from + (to - from) * eased;
			setValue(v);
			if (t < 1) raf = requestAnimationFrame(tick);
			else startRef.current = to;
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [target, duration]);

	return value;
}

function formatValue(value: number, format: NonNullable<Props["format"]>): string {
	if (format === "currency") {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: "USD",
			maximumFractionDigits: 0,
		}).format(value);
	}
	if (format === "compact" || format === "percent") {
		return new Intl.NumberFormat("en-US", {
			notation: "compact",
			maximumFractionDigits: 1,
		}).format(value);
	}
	return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function pctClass(pct: number): string {
	if (pct >= 90) return "aos-v2-cc-pct-hot";
	if (pct >= 70) return "aos-v2-cc-pct-warm";
	return "aos-v2-cc-pct-cool";
}

function statusClass(status: string): string {
	switch (status) {
		case "ok":
			return "aos-v2-cc-status-ok";
		case "mock":
			return "aos-v2-cc-status-mock";
		case "stale":
			return "aos-v2-cc-status-stale";
		default:
			return "aos-v2-cc-status-error";
	}
}

export function MetricCard({
	label,
	snapshot,
	format = "integer",
	unit,
	budget,
	hero,
	series,
	tone,
}: Props) {
	// IMPORTANT — hook order must be stable across renders. Always call before any early return.
	const animatedValue = useAnimatedNumber(snapshot?.latest.value ?? 0);

	const toneAttrs = tone && tone !== "neutral" ? { "data-tone": tone } : {};

	if (!snapshot) {
		return (
			<div
				className="aos-v2-cc-card aos-v2-cc-card-empty"
				{...(hero ? { "data-hero": "true" } : {})}
				{...toneAttrs}
			>
				<div className="aos-v2-cc-card-label">{label}</div>
				<div className="aos-v2-cc-card-value aos-v2-cc-dim">—</div>
				<div className="aos-v2-cc-card-delta aos-v2-cc-dim">no data</div>
			</div>
		);
	}

	const { latest, deltaPct, delta } = snapshot;
	const isStaleish = latest.status !== "ok";
	const isHeroArc = !!(hero && format === "percent" && budget && budget > 0);

	let primary: h.JSX.Element | string;
	let pctClassName = "";

	if (format === "percent" && budget && budget > 0) {
		const pct = (animatedValue / budget) * 100;
		pctClassName = pctClass(pct);
		primary = (
			<span
				title={`${formatValue(latest.value, "compact")} / ${formatValue(budget, "compact")}`}
			>
				{pct.toFixed(0)}
				<span className="aos-v2-cc-card-unit">%</span>
			</span>
		);
	} else {
		const value = formatValue(animatedValue, format);
		primary = (
			<span>
				{value}
				{unit ? <span className="aos-v2-cc-card-unit">{unit}</span> : null}
			</span>
		);
	}

	let deltaText = "—";
	let deltaClass = "aos-v2-cc-dim";
	if (deltaPct !== null) {
		const arrow = deltaPct > 0 ? "▲" : deltaPct < 0 ? "▼" : "·";
		deltaText = `${arrow} ${Math.abs(deltaPct).toFixed(1)}%`;
		deltaClass = deltaPct > 0 ? "aos-v2-cc-up" : deltaPct < 0 ? "aos-v2-cc-down" : "";
	} else if (delta !== null) {
		deltaText = `${delta > 0 ? "+" : ""}${delta}`;
	}

	return (
		<div
			className={`aos-v2-cc-card ${isStaleish ? "aos-v2-cc-card-dim" : ""}`}
			{...(hero ? { "data-hero": "true" } : {})}
			{...toneAttrs}
		>
			<div className="aos-v2-cc-card-head">
				<span className="aos-v2-cc-card-label">{label}</span>
				<span
					className={`aos-v2-cc-status-dot ${statusClass(latest.status)}`}
					title={`${latest.status}${latest.error ? ` — ${latest.error}` : ""}`}
				/>
			</div>
			{isHeroArc ? (
				<MetricRadialArc
					pct={(animatedValue / budget!) * 100}
					rawValue={latest.value}
					budget={budget!}
				/>
			) : (
				<div className={`aos-v2-cc-card-value ${pctClassName}`}>{primary}</div>
			)}
			<div className={`aos-v2-cc-card-delta ${deltaClass}`}>{deltaText}</div>
		</div>
	);
}
