import type { GeoPermissibleObjects } from "d3-geo";
import {
	geoEquirectangular,
	geoGraticule10,
	geoOrthographic,
	geoPath,
} from "d3-geo";
import { memo, useId, useMemo, useState } from "react";
import land from "../../assets/examples/orbit-land.json";
import "./orbit.css";

export interface OrbitSample {
	latitude: number;
	longitude: number;
	altitude: number;
	velocity: number;
	timestamp: number;
	visibility?: string;
}

interface OrbitViewProps {
	sample: OrbitSample | null;
	history: readonly OrbitSample[];
	stale: boolean;
}

const graticule = geoGraticule10();
const coordinate = (value: number, positive: string, negative: string) =>
	`${Math.abs(value).toFixed(2)}° ${value < 0 ? negative : positive}`;

export const OrbitView = memo(function OrbitView({
	sample,
	history,
	stale,
}: OrbitViewProps) {
	const [view, setView] = useState<"globe" | "map">("globe");
	const id = useId().replace(/:/g, "");
	const latitude = sample?.latitude ?? 15;
	const longitude = sample?.longitude ?? 0;
	const globe = useMemo(() => {
		const projection =
			view === "globe"
				? geoOrthographic()
						.scale(155)
						.translate([220, 195])
						.rotate([-longitude + 25, -latitude * 0.65, -12])
						.precision(0.5)
				: geoEquirectangular().scale(64).translate([220, 195]).precision(0.5);
		const path = geoPath(projection).digits(1);
		return {
			projection,
			path,
			land: path(land as GeoPermissibleObjects) ?? "",
			grid: path(graticule) ?? "",
			sphere: path({ type: "Sphere" }) ?? "",
		};
	}, [latitude, longitude, view]);
	const trail = useMemo(
		() =>
			globe.path({
				type: "LineString",
				coordinates: history
					.slice(-36)
					.map((point) => [point.longitude, point.latitude]),
			}) ?? "",
		[globe, history],
	);
	const position = sample
		? globe.projection([sample.longitude, sample.latitude])
		: null;
	const reported = sample
		? new Date(sample.timestamp * 1000).toISOString()
		: null;
	const reportedTime = reported?.slice(11, 19);

	return (
		<div className="orbit-view" data-stale={stale || undefined}>
			<figure className="orbit-globe">
				<fieldset className="orbit-view-switch" aria-label="View of Earth">
					<button
						type="button"
						aria-pressed={view === "globe"}
						onClick={() => setView("globe")}
					>
						Globe
					</button>
					<button
						type="button"
						aria-pressed={view === "map"}
						onClick={() => setView("map")}
					>
						Map
					</button>
				</fieldset>
				<svg
					viewBox="0 0 440 395"
					role="img"
					aria-labelledby={`${id}-title ${id}-description`}
				>
					<title id={`${id}-title`}>
						{sample ? "Current ISS position" : "Earth"}
					</title>
					<desc id={`${id}-description`}>
						{sample
							? `The International Space Station is above ${coordinate(sample.latitude, "north", "south")}, ${coordinate(sample.longitude, "east", "west")}. ${view === "globe" ? "The globe follows its position." : "The map shows the whole Earth."} The short trail joins received positions; it is not a predicted orbit.`
							: "The globe will show the International Space Station when its first position arrives."}
					</desc>
					<defs>
						<radialGradient id={`${id}-ocean`} cx="32%" cy="25%" r="80%">
							<stop offset="0" className="orbit-ocean-light" />
							<stop offset="1" className="orbit-ocean-deep" />
						</radialGradient>
						<radialGradient id={`${id}-shade`} cx="30%" cy="25%" r="75%">
							<stop offset="0.45" stopColor="#251e30" stopOpacity="0" />
							<stop offset="1" stopColor="#251e30" stopOpacity="0.18" />
						</radialGradient>
					</defs>
					<g>
						{view === "globe" && (
							<circle className="orbit-dial" cx="220" cy="195" r="175" />
						)}
						<path
							visibility={view === "globe" ? "visible" : "hidden"}
							className="orbit-dial-ticks"
							d="M220 16v9 M220 365v9 M41 195h9 M390 195h9 M94 69l6 6 M340 315l6 6 M94 321l6-6 M340 75l6-6"
						/>
						<path d={globe.sphere} fill={`url(#${id}-ocean)`} />
						<path className="orbit-land" d={globe.land} />
						<path className="orbit-graticule" d={globe.grid} />
						<path d={globe.sphere} fill={`url(#${id}-shade)`} />
						<path className="orbit-rim" d={globe.sphere} />
						{sample && <path className="orbit-trail" d={trail} />}
						{position && (
							<g
								className="orbit-station"
								transform={`translate(${position[0]},${position[1]})`}
							>
								<circle className="orbit-station-ring" r="23" />
								{view === "globe" && (
									<path className="orbit-station-leader" d="M19-12l13-13h29" />
								)}
								<text
									className="orbit-station-label"
									x={view === "globe" ? 37 : -10}
									y="-31"
								>
									ISS
								</text>
								<g transform="rotate(-25)">
									<path
										className="orbit-solar-panels"
										d="M-18-10h10v20h-10z M8-10h10v20H8z"
									/>
									<path
										className="orbit-station-body"
										d="M-8-2H8v4H-8z M-3-7h6V7h-6z"
									/>
									<path
										className="orbit-panel-lines"
										d="M-18 0h10 M8 0h10 M-13-10v20 M13-10v20"
									/>
								</g>
							</g>
						)}
					</g>
				</svg>
				<figcaption>
					{sample
						? "Trail joins received positions. Change this view in each tab."
						: "Waiting for the first position from space."}
				</figcaption>
			</figure>
			<div className="orbit-readout">
				<dl className="orbit-telemetry">
					<div className="orbit-altitude">
						<dt>Above Earth</dt>
						<dd>
							{sample ? Math.round(sample.altitude) : "—"}
							<span> km</span>
						</dd>
					</div>
					<div>
						<dt>Speed</dt>
						<dd>
							{sample
								? Math.round(sample.velocity).toLocaleString("en-GB")
								: "—"}
							<span> km/h</span>
						</dd>
					</div>
					<div className="orbit-coordinates">
						<dt>Position</dt>
						<dd>
							{sample ? coordinate(sample.latitude, "N", "S") : "—"}
							<br />
							{sample ? coordinate(sample.longitude, "E", "W") : "—"}
						</dd>
					</div>
				</dl>
				<p className="orbit-source-time">
					{reported ? (
						<>
							<span>{stale ? "Last report" : "Reported"}</span>
							<time dateTime={reported}>{reportedTime} UTC</time>
						</>
					) : (
						"Live readout appears when the feed arrives."
					)}
				</p>
			</div>
		</div>
	);
});

export default OrbitView;
