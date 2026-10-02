import { defineConfig } from "wxt";
import { createManifest } from "./src/manifest";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  manifestVersion: 3,
  manifest: ({ browser }) => createManifest(browser),
});
