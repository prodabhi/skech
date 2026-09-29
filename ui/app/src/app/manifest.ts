import type { MetadataRoute } from "next";

/** What a phone needs to put skech on its Home Screen and open it like an app: no browser bar around it. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "skech",
    short_name: "skech",
    description: "Draw ahead of the Bitcoin price. The ink it runs through pays.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png" }],
  };
}
