import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AbiEntry, LinkReferences, ParsedArtifact } from "./types.js";

export function findArtifact(contractName: string, outDir: string): string {
  const candidates: string[] = [];
  const entries = readdirSync(outDir);

  for (const entry of entries) {
    const entryPath = join(outDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    const jsonPath = join(entryPath, `${contractName}.json`);
    try {
      statSync(jsonPath);
      candidates.push(jsonPath);
    } catch {
      // not found, skip
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `No artifact found for "${contractName}" in ${outDir}. Run \`forge build\` first.`,
    );
  }

  return candidates[0];
}

export function parseArtifact(
  artifactPath: string,
  contractName: string,
): ParsedArtifact {
  const raw = JSON.parse(readFileSync(artifactPath, "utf-8"));

  const abi: AbiEntry[] = raw.abi ?? [];
  let bytecodeHex: string = raw.bytecode?.object ?? "";
  if (bytecodeHex.startsWith("0x")) bytecodeHex = bytecodeHex.slice(2);

  const linkReferences: LinkReferences = raw.bytecode?.linkReferences ?? {};

  const metadata = raw.metadata;
  const solcVersion = metadata?.compiler?.version as string | undefined;
  const settings = metadata?.settings;
  const optimizerRuns = settings?.optimizer?.runs as number | undefined;
  const viaIR = settings?.viaIR as boolean | undefined;
  const evmVersion = settings?.evmVersion as string | undefined;

  let sourcePath: string | undefined;
  if (metadata?.settings?.compilationTarget) {
    const targets = metadata.settings.compilationTarget as Record<string, string>;
    sourcePath = Object.keys(targets)[0];
  }

  return {
    contractName,
    abi,
    bytecode: bytecodeHex,
    linkReferences,
    sourcePath,
    solcVersion,
    optimizerRuns,
    viaIR,
    evmVersion,
  };
}
