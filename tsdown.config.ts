import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: "esm",
  platform: "node",
  dts: true,
  clean: true,
  splitting: false,
});
