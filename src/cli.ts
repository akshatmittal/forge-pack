import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findArtifact, parseArtifact } from "./artifact.js";
import { resolveLibraries } from "./resolve.js";
import { generateDeployer } from "./codegen.js";
import { DEPLOY_HELPER_SOL } from "./deploy-helper.js";

const pkgPath = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "./out" },
    output: { type: "string", default: "./deployers" },
    build: { type: "boolean", default: false },
    pragma: { type: "string", default: ">=0.8.0" },
    version: { type: "boolean", short: "v", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.version) {
  console.log(pkg.version);
  process.exit(0);
}

if (values.help || positionals.length === 0) {
  console.log(`Usage: forge-pack <ContractName...> [options]

Options:
  --out <dir>        Forge output directory (default: ./out)
  --output <dir>     Where to write the deployer .sol files (default: ./deployers)
  --build            Run \`forge build\` before reading artifacts
  --pragma <range>   Solidity pragma for generated files (default: >=0.8.0)
  -v, --version      Show version number
  -h, --help         Show this help message`);
  process.exit(values.help ? 0 : 1);
}

const outDir = resolve(values.out!);
const outputDir = resolve(values.output!);
const pragma = values.pragma!;

if (values.build) {
  console.log("Running forge build...");
  execSync("forge build", { stdio: "inherit" });
}

// Write DeployHelper.sol if it doesn't already exist
const utilsDir = join(outputDir, "utils");
const deployHelperPath = join(utilsDir, "DeployHelper.sol");
mkdirSync(utilsDir, { recursive: true });
if (!existsSync(deployHelperPath)) {
  writeFileSync(deployHelperPath, DEPLOY_HELPER_SOL);
  console.log(`Generated ${deployHelperPath}`);
}

let hasError = false;

for (const contractName of positionals) {
  try {
    const artifactPath = findArtifact(contractName, outDir);
    const parsed = parseArtifact(artifactPath, contractName);

    if (!parsed.bytecode) {
      console.error(`Error: No bytecode found for "${contractName}". Is it an abstract contract or interface?`);
      hasError = true;
      continue;
    }

    // Resolve library dependencies (recursive, topological order)
    const hasLinks = Object.keys(parsed.linkReferences).length > 0;
    let libraries;
    if (hasLinks) {
      libraries = resolveLibraries(parsed.linkReferences, outDir);
      const libNames = libraries.map((l) => l.lib);
      console.log(`[${contractName}] Resolved ${libNames.length} library dep(s): ${libNames.join(", ")}`);
    }

    const solidity = generateDeployer(parsed, { pragma, libraries });

    mkdirSync(outputDir, { recursive: true });
    const outPath = join(outputDir, `${contractName}Deployer.sol`);
    writeFileSync(outPath, solidity);

    console.log(`Generated ${outPath}`);
  } catch (err: any) {
    console.error(`Error [${contractName}]: ${err.message}`);
    hasError = true;
  }
}

if (hasError) {
  process.exit(1);
}
