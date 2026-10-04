import type { ExampleKind, TabSnapshot } from "./protocol";

export default function DeliveryDiagram({
	kind,
	tabs,
	ownId,
	shared,
	pending,
}: {
	kind: ExampleKind;
	tabs: readonly TabSnapshot[];
	ownId: string;
	shared: boolean;
	pending: boolean;
}) {
	const source = kind === "orbit" ? "ISS API" : "Entur";
	return (
		<div className="example-flow" data-pending={pending} aria-hidden="true">
			{shared && (
				<div className="example-flow-origin">
					<span className="example-flow-source">
						{source}
						<small>Live source</small>
					</span>
					<span className="example-flow-wire" />
					<span className="example-flow-hub">spinetab</span>
					<span className="example-flow-wire" />
				</div>
			)}
			<div
				className="example-flow-tabs"
				data-branched={shared && tabs.length > 1}
			>
				{tabs.slice(0, 3).map((tab, index) => (
					<div className="example-flow-row" key={tab.id}>
						{!shared && (
							<span className="example-flow-source">
								{source}
								<small>Live source</small>
							</span>
						)}
						<span className="example-flow-wire" />
						<div className="example-flow-tab" data-current={tab.id === ownId}>
							<span>
								{tab.id === ownId ? "This tab" : `Tab ${index + 1}`}
								<i
									className={tab.connected && tab.received > 0 ? "is-live" : ""}
								/>
							</span>
							{kind === "orbit" && tab.valueTime > 0 && (
								<time dateTime={new Date(tab.valueTime).toISOString()}>
									{new Date(tab.valueTime).toISOString().slice(11, 19)}
								</time>
							)}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
