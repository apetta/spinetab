import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en-GB">
			<body>{children}</body>
		</html>
	);
}
