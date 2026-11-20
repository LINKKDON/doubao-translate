import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const bytes = await readFile(new URL("./worker.js", import.meta.url));
if (bytes.byteLength > 45_000) throw new Error(`Worker is ${bytes.byteLength} bytes; the limit is 45,000.`);
console.log(`Single-file Worker: ${bytes.byteLength} / 45000 bytes; gzip: ${gzipSync(bytes).byteLength} bytes`);
