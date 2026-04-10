#!/usr/bin/env node
// Reads ../data/nuts_codes.csv and generates src/nuts_data.ts
// Run before deploy: npm run generate-nuts

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = resolve(__dirname, "../../data/nuts_codes.csv");
const outPath = resolve(__dirname, "../src/nuts_data.ts");

const csv = readFileSync(csvPath, "utf-8");
const lines = csv.trim().split("\n").slice(1); // skip header

const entries = [];
for (const line of lines) {
  // Simple CSV parse (no quotes in our data)
  const firstComma = line.indexOf(",");
  const code = line.slice(0, firstComma).trim();
  const label = line.slice(firstComma + 1).trim();
  if (code && label) {
    entries.push({ code, label });
  }
}

const ts = `// Auto-generated from data/nuts_codes.csv — do not edit manually.
// Run: npm run generate-nuts

export const NUTS_DATA: ReadonlyArray<{ code: string; label: string }> = ${JSON.stringify(entries, null, 2)};
`;

writeFileSync(outPath, ts, "utf-8");
console.log(`Generated ${outPath} with ${entries.length} entries.`);
