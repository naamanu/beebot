import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// The app's own light zinc theme and fonts (web/index.css).
export const C = {
  bg: "oklch(0.985 0 0)",
  card: "#ffffff",
  fg: "oklch(0.21 0.006 285.9)",
  muted: "oklch(0.52 0.014 286)",
  border: "oklch(0 0 0 / 8%)",
  ring: "oklch(0 0 0 / 10%)",
  secondary: "oklch(0 0 0 / 4%)",
  agent: "oklch(0.63 0.19 30)",
  chat: "oklch(0.58 0.17 298)",
  tool: "oklch(0.6 0.16 140)",
  retrieval: "oklch(0.6 0.12 215)",
  http: "oklch(0.64 0.17 52)",
  workflow: "oklch(0.56 0.18 258)",
  error: "oklch(0.58 0.21 25)",
  // the dark stage the app window sits on
  stage: "#0f1013",
  stageFg: "#f4f4f5",
  stageMuted: "#a1a1aa",
};

export const F = {
  heading: "'Cal Sans', 'Inter', sans-serif",
  sans: "'Inter', ui-sans-serif, system-ui, sans-serif",
  mono: "'Geist Mono', ui-monospace, monospace",
};

let loaded: Promise<unknown> | null = null;
export const loadFonts = () =>
  (loaded ??= Promise.all([
    loadFont({ family: "Cal Sans", url: staticFile("fonts/CalSans.woff2") }),
    loadFont({ family: "Inter", url: staticFile("fonts/Inter.woff2"), weight: "100 900" }),
    loadFont({ family: "Geist Mono", url: staticFile("fonts/GeistMono.woff2"), weight: "100 900" }),
  ]));
