// Argon2id verification for PHC strings like
//   $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
//
// Workers can't compile WebAssembly from bytes at runtime, so the argon2id
// wasm binaries are imported as modules (wrangler bundles them) and handed to
// the library's setup function.

import setupWasm from "argon2id/lib/setup.js";
import simd from "argon2id/dist/simd.wasm";
import noSimd from "argon2id/dist/no-simd.wasm";

type ComputeHash = (params: {
  password: Uint8Array;
  salt: Uint8Array;
  parallelism: number;
  passes: number;
  memorySize: number;
  tagLength: number;
}) => Uint8Array;

// A fresh instance per verification: its wasm memory starts at ~68 MB and
// never shrinks, so keeping it would leave little of the isolate's 128 MB for
// an upload handled next. Logins are rare, so instantiating each time is fine.
function loader(): Promise<ComputeHash> {
  return setupWasm(
    async (imports: WebAssembly.Imports) => ({ instance: await WebAssembly.instantiate(simd, imports) }),
    async (imports: WebAssembly.Imports) => ({ instance: await WebAssembly.instantiate(noSimd, imports) }),
  );
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** True if `password` matches the encoded hash. False for malformed hashes. */
export async function argon2idVerify(password: string, encoded: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/_-]+)\$([A-Za-z0-9+/_-]+)$/.exec(encoded);
  if (!m) return false;
  const expected = fromBase64(m[5]);
  const actual = (await loader())({
    password: new TextEncoder().encode(password),
    salt: fromBase64(m[4]),
    memorySize: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
