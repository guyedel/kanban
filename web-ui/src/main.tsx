import "@primer/primitives/dist/css/functional/themes/light.css";
import "@primer/primitives/dist/css/functional/themes/dark.css";
import "@primer/css/dist/primer.css";
import { BaseStyles, ThemeProvider } from "@primer/react";
import ReactDOM from "react-dom/client";
import App from "@/App";

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element was not found.");
}

ReactDOM.createRoot(root).render(
	<ThemeProvider colorMode="night" nightScheme="dark" dayScheme="light">
		<BaseStyles>
			<App />
		</BaseStyles>
	</ThemeProvider>,
);
