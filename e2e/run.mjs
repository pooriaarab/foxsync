// The E2E test: install the built extension (dist-ext/) in a real Firefox,
// open the demo page, and write artifacts/e2e-<date>.json.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
import { launch, poll, writeArtifact } from "create-foxkit/e2e";

const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: actual === expected });

let fox;
try {
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed") });
  record.firefox = await fox.browser.version();
  const desk = await fox.openExtensionPage("popup.html");
  check("demo page lists no devices", "No paired devices.", await poll(desk, () => document.querySelector("#pairs li")?.textContent));
  await desk.evaluate(() => document.getElementById("pair").click()); // BiDi input actions do not reach moz-extension pages
  check("pairing shows a code", true, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/.test(await poll(desk, () => document.getElementById("code").textContent)));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
}
record.passed = !record.error && record.checks.length === 2 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${c.actual}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
