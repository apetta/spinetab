import { QueryLink } from "../query-link";

export default function Other() {
	return (
		<main>
			<h1>Other page</h1>
			<QueryLink href="/" testId="to-home">
				Back to the live view
			</QueryLink>
		</main>
	);
}
