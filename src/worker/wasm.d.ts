declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "argon2id/lib/setup.js" {
  export default function setupWasm(
    getSIMD: (imports: WebAssembly.Imports) => Promise<{ instance: WebAssembly.Instance }>,
    getNonSIMD: (imports: WebAssembly.Imports) => Promise<{ instance: WebAssembly.Instance }>,
  ): Promise<any>;
}
