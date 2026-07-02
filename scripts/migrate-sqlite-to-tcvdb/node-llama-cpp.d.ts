/**
 * Type stub for node-llama-cpp — the migration script does not use local
 * embedding but TypeScript still resolves the module through transitive
 * imports (sqlite.ts → embedding.ts → import("node-llama-cpp")).
 *
 * This stub satisfies the compiler without requiring the actual package.
 * 中文：类型声明用于node-llama-cpp——迁移脚本不使用本地嵌入，但TypeScript仍通过传递性导入（sqlite.ts → embedding.ts → import("node-llama-cpp")）解析该模块。（此声明满足编译器而不需实际包。）
 */
declare module "node-llama-cpp" {
  const _: any;
  export = _;
}
