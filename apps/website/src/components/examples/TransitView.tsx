import { memo, useId, useState } from "react";
import "./transit.css";

export interface TransitVehicle {
	vehicleId: string;
	lastUpdated: string;
	location: { latitude: number; longitude: number } | null;
	line: { publicCode?: string | null; lineName?: string | null } | null;
	bearing?: number | null;
	speed?: number | null;
	destinationName?: string | null;
	delay?: number | null;
	monitoredCall?: { vehicleAtStop?: boolean | null } | null;
}

const REPORT_TIME = new Intl.DateTimeFormat("en-GB", {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
	timeZone: "Europe/Oslo",
});
const LINE_ORDER = new Intl.Collator("en-GB", { numeric: true });

function reportTime(value: string): string {
	const date = new Date(value);
	return Number.isFinite(date.getTime())
		? REPORT_TIME.format(date)
		: "Unavailable";
}

function coordinate(value: number, positive: string, negative: string): string {
	return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positive : negative}`;
}

function punctuality(delay: number | null | undefined) {
	if (delay == null) return { label: "Timing unavailable", tone: "unknown" };
	const seconds = Math.round(Math.abs(delay));
	if (seconds === 0) return { label: "On time", tone: "on-time" };
	const duration =
		seconds < 60
			? `${seconds}s`
			: `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
	return {
		label: `${duration} ${delay > 0 ? "late" : "early"}`,
		tone: delay > 0 ? "late" : "early",
	};
}

function PositionPlot({
	vehicles,
	selected,
}: {
	vehicles: readonly TransitVehicle[];
	selected: TransitVehicle | undefined;
}) {
	const valid = vehicles.filter(
		(vehicle) =>
			vehicle.location &&
			Number.isFinite(vehicle.location.latitude) &&
			Number.isFinite(vehicle.location.longitude),
	);
	valid.sort(
		(left, right) =>
			Number(left.vehicleId === selected?.vehicleId) -
			Number(right.vehicleId === selected?.vehicleId),
	);
	const centre = selected?.location ?? { latitude: 59.95, longitude: 10.75 };
	const latitudeScale = 145 / 0.06;
	const longitudeScale = latitudeScale * Math.cos((59.95 * Math.PI) / 180);
	const bearing = selected?.bearing;
	const available = typeof bearing === "number" && Number.isFinite(bearing);
	const direction = available ? ((bearing % 360) + 360) % 360 : 0;
	const id = useId();
	return (
		<figure className="transit-plot">
			<svg viewBox="0 0 240 200" role="img" aria-labelledby={id}>
				<title id={id}>
					{selected?.location
						? "Vehicle positions centred on the selected vehicle. North is up; the scale stays fixed as you change selection."
						: "Recent vehicle positions in the Oslo area. The selected vehicle has no reported position."}
				</title>
				<defs>
					<clipPath id={`${id}-bounds`}>
						<rect x="25" y="25" width="190" height="145" rx="4" />
					</clipPath>
				</defs>
				<rect
					className="transit-plot-area"
					x="25"
					y="25"
					width="190"
					height="145"
					rx="4"
				/>
				<path
					className="transit-plot-grid"
					d="M25 61H215 M25 97.5H215 M25 134H215 M72 25V170 M120 25V170 M168 25V170"
				/>
				<text x="25" y="16">
					{(centre.latitude + 0.03).toFixed(2)}° N
				</text>
				<text x="25" y="188">
					{(centre.latitude - 0.03).toFixed(2)}° N
				</text>
				<text x="215" y="188" textAnchor="end">
					{(centre.longitude + 95 / longitudeScale).toFixed(2)}° E
				</text>
				<text x="215" y="16" textAnchor="end">
					N
				</text>
				<g clipPath={`url(#${id}-bounds)`}>
					{valid.map((vehicle) => {
						const location = vehicle.location;
						if (!location) return null;
						const x =
							120 + (location.longitude - centre.longitude) * longitudeScale;
						const y =
							97.5 - (location.latitude - centre.latitude) * latitudeScale;
						if (x < 25 || x > 215 || y < 25 || y > 170) return null;
						const active = vehicle.vehicleId === selected?.vehicleId;
						return (
							<g
								key={vehicle.vehicleId}
								transform={`translate(${x},${y})`}
								className={
									active
										? "transit-plot-marker is-selected"
										: "transit-plot-marker"
								}
							>
								{active && <circle r="12" className="transit-plot-halo" />}
								{active && available && (
									<path
										className="transit-plot-direction"
										d="m-4 -17 4-7 4 7"
										transform={`rotate(${direction})`}
									/>
								)}
								<circle r={active ? 4.5 : 3} />
							</g>
						);
					})}
				</g>
			</svg>
			<figcaption className="transit-bearing">
				{available
					? `${Math.round(direction)}° reported bearing`
					: "Bearing unavailable"}
			</figcaption>
		</figure>
	);
}

export function TransitView({
	vehicles,
	stale,
}: {
	vehicles: readonly TransitVehicle[];
	stale: boolean;
}) {
	const detailId = useId();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const rows = [...vehicles].sort(
		(left, right) =>
			LINE_ORDER.compare(
				left.line?.publicCode ?? "",
				right.line?.publicCode ?? "",
			) ||
			(left.vehicleId < right.vehicleId
				? -1
				: left.vehicleId > right.vehicleId
					? 1
					: 0),
	);
	const selected =
		rows.find((vehicle) => vehicle.vehicleId === selectedId) ?? rows[0];
	const location = selected?.location;
	const hasLocation =
		location !== undefined &&
		location !== null &&
		Number.isFinite(location.latitude) &&
		Number.isFinite(location.longitude);

	return (
		<section
			className={`transit-view not-content${stale ? " is-stale" : ""}`}
			aria-label="Oslo-area bus reports"
		>
			<div className="transit-layout">
				<div className="transit-board">
					<div className="transit-board-heading">
						<strong>Oslo-area buses</strong>
						<span>{rows.length} reporting</span>
					</div>
					<div className="transit-list">
						<div className="transit-columns" aria-hidden="true">
							<span>Line / vehicle</span>
							<span>Last report · Oslo time</span>
						</div>
						{rows.length > 0 ? (
							<ul
								className="transit-vehicles"
								aria-label="Choose a vehicle to inspect"
							>
								{rows.map((vehicle, index) => {
									const timing = punctuality(vehicle.delay);
									return (
										<li
											key={vehicle.vehicleId}
											data-vehicle-id={vehicle.vehicleId}
											data-updated={vehicle.lastUpdated}
										>
											<button
												type="button"
												className="transit-vehicle"
												aria-pressed={selected?.vehicleId === vehicle.vehicleId}
												aria-controls={detailId}
												onClick={() => setSelectedId(vehicle.vehicleId)}
											>
												<span className="transit-line">
													{vehicle.line?.publicCode || "—"}
												</span>
												<span className="transit-vehicle-name">
													<span title={vehicle.vehicleId}>
														{vehicle.destinationName
															? `To ${vehicle.destinationName}`
															: vehicle.line?.lineName ||
																`Vehicle ${index + 1}`}
													</span>
													<span
														className="transit-vehicle-caption"
														data-tone={timing.tone}
													>
														{vehicle.monitoredCall?.vehicleAtStop === true &&
															"At a stop · "}
														{timing.label}
													</span>
												</span>
												<time
													className="transit-report"
													dateTime={vehicle.lastUpdated}
												>
													{reportTime(vehicle.lastUpdated)}
													<span
														key={vehicle.lastUpdated}
														className="transit-report-mark"
														aria-hidden="true"
													/>
												</time>
											</button>
										</li>
									);
								})}
							</ul>
						) : (
							<div className="transit-empty">
								<svg viewBox="0 0 64 64" aria-hidden="true">
									<rect x="16" y="10" width="32" height="41" rx="7" />
									<path d="M16 31h32 M25 16h14 M21 51v4 M43 51v4" />
									<circle cx="24" cy="41" r="2" />
									<circle cx="40" cy="41" r="2" />
								</svg>
								<p>No vehicle reports yet.</p>
								<span>The board fills as positions arrive.</span>
							</div>
						)}
					</div>
					<p className="transit-board-note">
						{stale
							? "Showing the last received positions."
							: "Choose a vehicle. Your selection stays in this tab."}
					</p>
				</div>
				<div className="transit-detail" id={detailId}>
					<div className="transit-detail-heading">
						<span>Oslo area</span>
						<strong title={selected?.vehicleId}>
							{selected
								? selected.destinationName ||
									selected.line?.lineName ||
									`Vehicle ${rows.indexOf(selected) + 1}`
								: "Waiting for a report"}
						</strong>
					</div>
					<PositionPlot vehicles={rows} selected={selected} />
					<dl className="transit-position">
						<div>
							<dt>Latitude</dt>
							<dd>
								{hasLocation
									? coordinate(location.latitude, "N", "S")
									: "Unavailable"}
							</dd>
						</div>
						<div>
							<dt>Longitude</dt>
							<dd>
								{hasLocation
									? coordinate(location.longitude, "E", "W")
									: "Unavailable"}
							</dd>
						</div>
					</dl>
				</div>
			</div>
		</section>
	);
}

export default memo(TransitView);
