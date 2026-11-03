import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import { createManifest } from "./src/manifest";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifestVersion: 3,
  manifest: ({ browser }) => createManifest(browser),
});
