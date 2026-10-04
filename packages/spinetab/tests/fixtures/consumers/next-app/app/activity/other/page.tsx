import { OtherProbe } from "../activity-probe";

// The route a Cache Components back-navigation leaves and returns from: /activity stays hidden in <Activity> while this page is shown.
export default function ActivityOther() {
	return (
		<main>
			<h1>Activity probe, other route</h1>
			<OtherProbe />
		</main>
	);
}
