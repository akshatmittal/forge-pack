import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findArtifact,
  parseArtifact,
  generateDeployer,
  resolveLibraries,
} from "./pack.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "./out" },
    output: { type: "string", default: "./deployers" },
    build: { type: "boolean", default: false },
    solc: { type: "string" },
    pragma: { type: "string", default: ">=0.8.0" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log(`Usage: forge-pack <ContractName> [options]

Options:
  --out <dir>        Forge output directory (default: ./out)
  --output <dir>     Where to write the deployer .sol file (default: ./deployers)
  --build            Run \`forge build\` before reading artifacts
  --solc <version>   Filter artifact by solc version (when multiple exist)
  --pragma <range>   Solidity pragma for generated file (default: >=0.8.0)
  -h, --help         Show this help message`);
  process.exit(values.help ? 0 : 1);
}

const contractName = positionals[0];
const outDir = resolve(values.out!);
const outputDir = resolve(values.output!);
const pragma = values.pragma!;

if (values.build) {
  console.log("Running forge build...");
  execSync("forge build", { stdio: "inherit" });
}

try {
  const artifactPath = findArtifact(contractName, outDir, {
    solcVersion: values.solc,
  });

  const parsed = parseArtifact(artifactPath, contractName);

  if (!parsed.bytecode) {
    console.error(
      `Error: No bytecode found for "${contractName}". Is it an abstract contract or interface?`,
    );
    process.exit(1);
  }

  // Resolve library dependencies (recursive, topological order)
  const hasLinks = Object.keys(parsed.linkReferences).length > 0;
  let libraries;
  if (hasLinks) {
    libraries = resolveLibraries(parsed.linkReferences, outDir);
    const libNames = libraries.map((l) => l.lib);
    console.log(`Resolved ${libNames.length} library dep(s): ${libNames.join(", ")}`);
  }

  const solidity = generateDeployer(parsed, { pragma, libraries });

  mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, `${contractName}Deployer.sol`);
  writeFileSync(outPath, solidity);

  console.log(`Generated ${outPath}`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
