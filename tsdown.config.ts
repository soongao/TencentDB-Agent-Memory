import { defineConfig } from "tsdown";
import packageJson from "./package.json" with { type: "json" };

/** Collect all declared dependencies that must NOT be bundled. */
/** 中文：收集所有必须外部加载的已声明依赖. */
function collectExternalDependencies(): string[] {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ];
}

export default defineConfig({
  entry: ["./index.ts"],
  outDir: "./dist",
  format: "esm",
  platform: "node",
  clean: true,
  fixedExtension: true,
  dts: false,
  sourcemap: false,
  deps: {
    neverBundle: (id) => {
      // openclaw SDK — always external
      // 中文：openclaw SDK — 始终外部
      if (id === "openclaw" || id.startsWith("openclaw/")) return true;
      // node: builtins
      // 中文：node: builtins
      if (id.startsWith("node:")) return true;
      // all declared dependencies
      // 中文：所有已声明的依赖
      for (const dep of collectExternalDependencies()) {
        if (id === dep || id.startsWith(`${dep}/`)) return true;
      }
      return false;
    },
  },
});
