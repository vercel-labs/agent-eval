#!/usr/bin/env node

import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {
  repairRoutesManifest,
  resolveNextCommand,
  resolvePlaygroundPort,
} from "./lib/start-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Parse CLI arguments
const args = process.argv.slice(2);
let resultsDir = "./results";
let evalsDir = "./evals";
let port;
let watch = false;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--results-dir":
      resultsDir = args[++i];
      break;
    case "--evals-dir":
      evalsDir = args[++i];
      break;
    case "--port":
    case "-p":
      port = args[++i];
      break;
    case "--watch":
      watch = true;
      break;
    case "--help":
    case "-h":
      console.log(`
Usage: agent-eval-playground [options]

Options:
  --results-dir <dir>  Path to results directory (default: ./results)
  --evals-dir <dir>    Path to evals directory (default: ./evals)
  --port, -p <port>    HTTP server port (default: PORT or 3000)
  --watch              Enable live mode — watch results for changes
  --help, -h           Show this help message
`);
      process.exit(0);
  }
}

port = resolvePlaygroundPort(port);

// Set environment variables for the Next.js app
process.env.RESULTS_DIR = resolve(resultsDir);
process.env.EVALS_DIR = resolve(evalsDir);
process.env.PORT = port;
if (watch) {
  process.env.WATCH = "true";
}

// Next 16.2.4+ crashes if a pre-16.2.4 `.next/routes-manifest.json` omits
// `onMatchHeaders` (`undefined.map`). Repair before `next start`.
repairRoutesManifest(__dirname);

// Find the next binary from this package's dependencies
let nextBin;
try {
  const nextPkgPath = require.resolve("next/package.json");
  nextBin = resolve(dirname(nextPkgPath), "dist", "bin", "next");
} catch {
  console.error(
    'Error: "next" package not found. Make sure dependencies are installed.'
  );
  process.exit(1);
}

const nextCommand = resolveNextCommand(__dirname);

console.log(`Agent Eval Playground`);
console.log(`  Results: ${process.env.RESULTS_DIR}`);
console.log(`  Evals:   ${process.env.EVALS_DIR}`);
console.log(`  Port:    ${port}`);
if (watch) console.log(`  Watch:   enabled`);
if (nextCommand === "dev") {
  console.log(`  Mode:    next dev (no production BUILD_ID)`);
}
console.log();

const child = spawn(process.execPath, [nextBin, nextCommand, "-p", port], {
  cwd: __dirname,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));

// Forward signals
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
