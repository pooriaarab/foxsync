// Builds phone/ into dist-phone/: a static page with one classic script, so
// it works from any static host and from file:// (no ES module loading).
import { cpSync, readdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist-phone", { recursive: true, force: true });
await build({ entryPoints: ["phone/phone.js"], outdir: "dist-phone", bundle: true, format: "iife", target: ["firefox128", "safari17", "chrome120"], minify: true, logLevel: "warning" });
for (const file of readdirSync("phone").filter((f) => !f.endsWith(".js"))) cpSync(`phone/${file}`, `dist-phone/${file}`);
console.log("Built dist-phone/.");
