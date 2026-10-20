import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    index: "src/index.ts",
  },
  fixedExtension: false,
  format: "esm",
  platform: "node",
  sourcemap: true,
  target: "esnext",
  unbundle: true,
});
