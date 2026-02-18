import type { AbiParam, GenerateDeployerOptions, LinkReferences, ParsedArtifact, ResolvedLibrary } from "./types.js";
import { makeParamName } from "./resolve.js";

// ── Struct handling ─────────────────────────────────────────────────────

interface StructDef {
  name: string;
  fields: { type: string; name: string }[];
}

function extractStructName(internalType: string): string {
  let name = internalType.replace(/^struct\s+/, "");
  name = name.replace(/(\[\d*\])+$/, "");
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx !== -1) name = name.slice(dotIdx + 1);
  return name;
}

function collectStructDefs(params: AbiParam[]): StructDef[] {
  const seen = new Map<string, StructDef>();

  function walk(param: AbiParam): void {
    const it = param.internalType ?? "";
    if (!it.startsWith("struct ") || !param.components) return;

    for (const comp of param.components) {
      walk(comp);
    }

    const name = extractStructName(it);
    if (seen.has(name)) return;

    const fields = param.components.map((comp, i) => ({
      type: abiTypeToSolidity(comp),
      name: comp.name || `field${i}`,
    }));

    seen.set(name, { name, fields });
  }

  for (const p of params) walk(p);
  return Array.from(seen.values());
}

// ── ABI type conversion ─────────────────────────────────────────────────

function abiTypeToSolidity(param: AbiParam): string {
  if (param.internalType) {
    const it = param.internalType;
    if (it.startsWith("contract ")) return "address";
    if (it.startsWith("enum ")) return param.type;
    if (it.startsWith("struct ")) {
      const baseName = extractStructName(it);
      const arraySuffix = param.type.replace(/^tuple/, "");
      return baseName + arraySuffix;
    }
    return it;
  }
  return param.type;
}

function formatParamWithStructs(param: AbiParam, index: number, structNames: Set<string>): string {
  const solType = abiTypeToSolidity(param);
  const needsMemory = needsMemoryLocation(solType) || isStructType(solType, structNames);
  const location = needsMemory ? " memory" : "";
  const name = param.name || `arg${index}`;
  return `${solType}${location} ${name}`;
}

function needsMemoryLocation(solType: string): boolean {
  if (solType === "string" || solType === "bytes") return true;
  if (solType.endsWith("[]") || /\[\d+\]$/.test(solType)) return true;
  return false;
}

function isStructType(solType: string, structNames: Set<string>): boolean {
  const baseName = solType.replace(/(\[\d*\])+$/, "");
  return structNames.has(baseName);
}

// ── Bytecode segmenting ─────────────────────────────────────────────────

interface BytecodeSegment {
  type: "hex" | "lib";
  value: string;
}

interface LibParam {
  name: string;
  file: string;
  lib: string;
}

function buildBytecodeSegments(
  bytecode: string,
  linkReferences: LinkReferences,
): { segments: BytecodeSegment[]; libParams: LibParam[] } {
  const placeholders: {
    start: number;
    length: number;
    file: string;
    lib: string;
  }[] = [];
  for (const [file, libs] of Object.entries(linkReferences)) {
    for (const [lib, refs] of Object.entries(libs)) {
      for (const ref of refs) {
        placeholders.push({ start: ref.start, length: ref.length, file, lib });
      }
    }
  }
  placeholders.sort((a, b) => a.start - b.start);

  if (placeholders.length === 0) {
    return { segments: [{ type: "hex", value: bytecode }], libParams: [] };
  }

  const libMap = new Map<string, string>();
  const libParams: LibParam[] = [];
  for (const p of placeholders) {
    const key = `${p.file}:${p.lib}`;
    if (!libMap.has(key)) {
      const paramName = makeParamName(p.lib);
      libMap.set(key, paramName);
      libParams.push({ name: paramName, file: p.file, lib: p.lib });
    }
  }

  const segments: BytecodeSegment[] = [];
  let cursor = 0;

  for (const p of placeholders) {
    const hexStart = p.start * 2;
    const hexEnd = (p.start + p.length) * 2;

    if (hexStart > cursor) {
      segments.push({ type: "hex", value: bytecode.slice(cursor, hexStart) });
    }

    const key = `${p.file}:${p.lib}`;
    segments.push({ type: "lib", value: libMap.get(key)! });
    cursor = hexEnd;
  }

  if (cursor < bytecode.length) {
    segments.push({ type: "hex", value: bytecode.slice(cursor) });
  }

  return { segments, libParams };
}

// ── Initcode rendering ──────────────────────────────────────────────────

function renderInitcodeBody(bytecode: string, segments: BytecodeSegment[], hasLinks: boolean): string {
  if (!hasLinks) {
    return `        return hex"${bytecode}";`;
  }
  const parts = segments.map((seg) => (seg.type === "hex" ? `hex"${seg.value}"` : seg.value)).join(", ");
  return `        return abi.encodePacked(${parts});`;
}

// ── Shared deploy body rendering ────────────────────────────────────────

function renderDeployBody(opts: {
  inlineLibs: boolean;
  resolvedLibs: ResolvedLibrary[];
  ctorParams: AbiParam[];
  initcodeCallArgs: string;
  isPayable: boolean;
}): string {
  const { inlineLibs, resolvedLibs, ctorParams, initcodeCallArgs } = opts;

  const lines: string[] = [];

  if (inlineLibs) {
    for (const rlib of resolvedLibs) {
      const { libParams: libLibParams } = buildBytecodeSegments(rlib.artifact.bytecode, rlib.artifact.linkReferences);
      const callArgs = libLibParams.length > 0 ? libLibParams.map((lp) => lp.name).join(", ") : "";
      lines.push(
        `        address ${rlib.paramName} = DeployHelper.deployLibrary(_${rlib.paramName}Initcode(${callArgs}));`,
      );
    }
  }

  if (ctorParams.length > 0) {
    const encodeArgs = ctorParams.map((p, i) => p.name || `arg${i}`).join(", ");
    lines.push(`        bytes memory args = abi.encode(${encodeArgs});`);
    lines.push(`        bytes memory initcode_ = abi.encodePacked(initcode(${initcodeCallArgs}), args);`);
  } else {
    lines.push(`        bytes memory initcode_ = initcode(${initcodeCallArgs});`);
  }

  lines.push(`        deployed = DeployHelper.deploy(initcode_, salt);`);

  return lines.join("\n");
}

// ── Code generation ─────────────────────────────────────────────────────

export function generateDeployer(parsed: ParsedArtifact, pragmaOrOpts?: string | GenerateDeployerOptions): string {
  const opts: GenerateDeployerOptions =
    typeof pragmaOrOpts === "string" ? { pragma: pragmaOrOpts } : (pragmaOrOpts ?? {});

  const pragma = opts.pragma ?? ">=0.8.0";
  const resolvedLibs = opts.libraries ?? [];

  const { contractName, abi, bytecode, linkReferences } = parsed;
  const libName = `${contractName}Deployer`;

  // Find constructor
  const ctorEntry = abi.find((e) => e.type === "constructor");
  const ctorParams = ctorEntry?.inputs ?? [];
  const isPayable = ctorEntry?.stateMutability === "payable";

  // Collect struct definitions from constructor params
  const structDefs = collectStructDefs(ctorParams);
  const structNames = new Set(structDefs.map((s) => s.name));

  // Build bytecode segments for the main contract
  const { segments: mainSegments, libParams: mainLibParams } = buildBytecodeSegments(bytecode, linkReferences);
  const hasLinks = mainLibParams.length > 0;

  // Determine if we're inlining library deployment
  const inlineLibs = hasLinks && resolvedLibs.length > 0;

  // ── Metadata comment ──
  const metaLines: string[] = [];
  if (parsed.sourcePath) metaLines.push(`@notice Source Contract: ${parsed.sourcePath}`);
  if (parsed.solcVersion) metaLines.push(`- solc: ${parsed.solcVersion}`);
  if (parsed.optimizerRuns !== undefined) metaLines.push(`- optimizer_runs: ${parsed.optimizerRuns}`);
  metaLines.push(`- viaIR: ${parsed.viaIR ?? false}`);
  if (parsed.evmVersion) metaLines.push(`- evm_version: ${parsed.evmVersion}`);
  metaLines.push(`- bytecodeHash: ${parsed.bytecodeHash ?? "ipfs"}`);

  const metaBlock =
    metaLines.length > 0
      ? [
          `    /**`,
          `     * @dev autogenerated by forge-pack`,
          `     *`,
          ...metaLines.map((l) => `     * ${l}`),
          `     */`,
        ].join("\n") + "\n"
      : "";

  // ── Struct definitions ──
  const structBlock = structDefs
    .map((s) => {
      const fields = s.fields.map((f) => `        ${f.type} ${f.name};`).join("\n");
      return `    struct ${s.name} {\n${fields}\n    }`;
    })
    .join("\n\n");

  // ── initcode() — always accepts library addresses for composability ──
  const initcodeParams = hasLinks ? mainLibParams.map((lp) => `address ${lp.name}`).join(", ") : "";

  const initcodeBody = renderInitcodeBody(bytecode, mainSegments, hasLinks);

  // ── Library initcode functions (private, one per resolved lib) ──
  const libInitcodeFns: string[] = [];
  if (inlineLibs) {
    for (const rlib of resolvedLibs) {
      const { segments: libSegs, libParams: libLibParams } = buildBytecodeSegments(
        rlib.artifact.bytecode,
        rlib.artifact.linkReferences,
      );
      const libHasLinks = libLibParams.length > 0;
      const fnParams = libHasLinks ? libLibParams.map((lp) => `address ${lp.name}`).join(", ") : "";
      const fnBody = renderInitcodeBody(rlib.artifact.bytecode, libSegs, libHasLinks);
      libInitcodeFns.push(
        `    function _${rlib.paramName}Initcode(${fnParams}) private pure returns (bytes memory) {\n${fnBody}\n    }`,
      );
    }
  }

  // ── deploy() params: only constructor args when libs are inlined ──
  const deployParams: string[] = [];
  for (let i = 0; i < ctorParams.length; i++) {
    deployParams.push(formatParamWithStructs(ctorParams[i], i, structNames));
  }
  // If libs are NOT inlined, require them as address params (legacy path)
  if (hasLinks && !inlineLibs) {
    for (const lp of mainLibParams) {
      deployParams.push(`address ${lp.name}`);
    }
  }

  const deployParamStr = deployParams.length > 0 ? `${deployParams.join(", ")}, bytes32 salt` : `bytes32 salt`;

  const initcodeCallArgs = hasLinks ? mainLibParams.map((lp) => lp.name).join(", ") : "";

  const payableModifier = isPayable ? " payable" : "";

  // ── Shared deploy body ──
  const deployBody = renderDeployBody({
    inlineLibs,
    resolvedLibs,
    ctorParams,
    initcodeCallArgs,
    isPayable,
  });

  // ── Assemble ──
  const structSection = structBlock ? `\n${structBlock}\n` : "";
  const libInitcodeSection = libInitcodeFns.length > 0 ? "\n" + libInitcodeFns.join("\n\n") + "\n" : "";

  return `// SPDX-License-Identifier: MIT
pragma solidity ${pragma};

import {DeployHelper} from "./utils/DeployHelper.sol";

library ${libName} {
${metaBlock}${structSection}
    function deploy(${deployParamStr}) internal${payableModifier} returns (address deployed) {
${deployBody}
    }

    function initcode(${initcodeParams}) internal pure returns (bytes memory) {
${initcodeBody}
    }
${libInitcodeSection}}
`;
}
