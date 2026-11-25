// Fails if any source file contains UTF-8 text that was decoded as Windows-1252 and re-saved (mojibake like "â€“").
import { readdirSync, readFileSync } from "node:fs";
const bad = /â€|Ã[\u0080-\u00bf]|Â[\u00a0-\u00bf]/;
const files = readdirSync("src").filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => `src/${f}`);
const hits = files.filter((f) => bad.test(readFileSync(f, "utf8")));
if (hits.length) { console.error("Mis-encoded characters in:", hits.join(", ")); process.exit(1); }
console.log(`encoding check passed (${files.length} files)`);