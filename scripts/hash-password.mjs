// Prints an Argon2id hash (m=64 MiB, t=3, p=4) for the users table.
// Usage: npm run hash-password, then type the password (input is hidden).
import { argon2id } from "hash-wasm";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
rl._writeToOutput = () => {};
process.stderr.write("Password: ");
const password = await new Promise((resolve) => rl.question("", resolve));
rl.close();
process.stderr.write("\n");
if (password.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
console.log(
  await argon2id({
    password,
    salt: randomBytes(16),
    parallelism: 4,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    outputType: "encoded",
  }),
);
