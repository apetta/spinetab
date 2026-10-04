// Operations used by the application's two live panels.
export const FEED =
	"subscription Feed($label: String) { ticks(intervalMs: 300, label: $label) { n label } }";
export const SUMMARY =
	'subscription Summary { ticks(intervalMs: 1000, label: "summary") { n } }';
