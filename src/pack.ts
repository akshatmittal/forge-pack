import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export interface LinkReference {
  start: number;
  length: number;
}

export interface LinkReferences {
  [file: string]: {
    [lib: string]: LinkReference[];
  };
}

export interface AbiParam {
  name: string;
  type: string;
  internalType?: string;
  components?: AbiParam[];
  indexed?: boolean;
}

export interface AbiEntry {
  type: string;
  name?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  stateMutability?: string;
}

export interface ParsedArtifact {
  contractName: string;
  abi: AbiEntry[];
  bytecode: string;
  linkReferences: LinkReferences;
  sourcePath?: string;
  solcVersion?: string;
  optimizerRuns?: number;
  viaIR?: boolean;
  evmVersion?: string;
}

export interface FindArtifactOptions {
  solcVersion?: string;
}

/**
 * A library dependency resolved from linkReferences, with its own parsed
 * artifact and the param name used in generated code.
 */
export interface ResolvedLibrary {
  /** Parameter-style name, e.g. "mathLib" */
  paramName: string;
  /** Source file declaring the library, e.g. "src/libs/MathLib.sol" */
  file: string;
  /** Library contract name, e.g. "MathLib" */
  lib: string;
  /** Parsed artifact for this library */
  artifact: ParsedArtifact;
  /** Param names of libraries this library depends on (its own linkReferences) */
  deps: string[];
}

// ── Artifact discovery ─────────────────────────────────────────────────

export function findArtifact(
  contractName: string,
  outDir: string,
  options?: FindArtifactOptions,
): string {
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

  if (options?.solcVersion && candidates.length > 1) {
    for (const c of candidates) {
      const raw = JSON.parse(readFileSync(c, "utf-8"));
      const version = raw?.metadata?.compiler?.version as string | undefined;
      if (version?.startsWith(options.solcVersion)) return c;
    }
    throw new Error(
      `No artifact for "${contractName}" compiled with solc ${options.solcVersion}.`,
    );
  }

  if (candidates.length > 1) {
    throw new Error(
      `Multiple artifacts found for "${contractName}". Use --solc to disambiguate:\n` +
        candidates.map((c) => `  ${c}`).join("\n"),
    );
  }

  return candidates[0];
}

// ── Artifact parsing ───────────────────────────────────────────────────

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

// ── Library resolution ─────────────────────────────────────────────────

/**
 * Collect unique library identities from linkReferences.
 * Returns deduped entries as { file, lib } pairs.
 */
function collectLibIds(linkRefs: LinkReferences): { file: string; lib: string }[] {
  const seen = new Set<string>();
  const result: { file: string; lib: string }[] = [];
  for (const [file, libs] of Object.entries(linkRefs)) {
    for (const lib of Object.keys(libs)) {
      const key = `${file}:${lib}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ file, lib });
      }
    }
  }
  return result;
}

function makeParamName(libName: string): string {
  return libName.charAt(0).toLowerCase() + libName.slice(1);
}

/**
 * Recursively resolve all library dependencies for a contract's linkReferences.
 * Returns libraries in topological order (deploy-order: leaves first).
 */
export function resolveLibraries(
  linkRefs: LinkReferences,
  outDir: string,
): ResolvedLibrary[] {
  // key = "file:lib" → ResolvedLibrary
  const resolved = new Map<string, ResolvedLibrary>();
  // Track visit state for cycle detection
  const visiting = new Set<string>();

  function resolve(file: string, lib: string): ResolvedLibrary {
    const key = `${file}:${lib}`;
    if (resolved.has(key)) return resolved.get(key)!;
    if (visiting.has(key)) {
      throw new Error(`Circular library dependency detected: ${key}`);
    }
    visiting.add(key);

    const artifactPath = findArtifact(lib, outDir);
    const artifact = parseArtifact(artifactPath, lib);

    // Recursively resolve this library's own dependencies
    const libIds = collectLibIds(artifact.linkReferences);
    const deps: string[] = [];
    for (const dep of libIds) {
      const depResolved = resolve(dep.file, dep.lib);
      deps.push(depResolved.paramName);
    }

    visiting.delete(key);

    const entry: ResolvedLibrary = {
      paramName: makeParamName(lib),
      file,
      lib,
      artifact,
      deps,
    };
    resolved.set(key, entry);
    return entry;
  }

  const topLevel = collectLibIds(linkRefs);
  for (const { file, lib } of topLevel) {
    resolve(file, lib);
  }

  // Return in insertion order (leaves first due to recursion)
  return Array.from(resolved.values());
}

// ── Solidity generation ────────────────────────────────────────────────

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

// ── Bytecode segmenting ────────────────────────────────────────────────

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
  const placeholders: { start: number; length: number; file: string; lib: string }[] = [];
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

// ── Initcode rendering helper ──────────────────────────────────────────

function renderInitcodeBody(
  bytecode: string,
  segments: BytecodeSegment[],
  hasLinks: boolean,
): string {
  if (!hasLinks) {
    return `        return hex"${bytecode}";`;
  }
  const parts = segments
    .map((seg) => (seg.type === "hex" ? `hex"${seg.value}"` : seg.value))
    .join(", ");
  return `        return abi.encodePacked(${parts});`;
}

// ── Code generation ────────────────────────────────────────────────────

export interface GenerateDeployerOptions {
  pragma?: string;
  libraries?: ResolvedLibrary[];
}

export function generateDeployer(
  parsed: ParsedArtifact,
  pragmaOrOpts?: string | GenerateDeployerOptions,
): string {
  const opts: GenerateDeployerOptions =
    typeof pragmaOrOpts === "string"
      ? { pragma: pragmaOrOpts }
      : pragmaOrOpts ?? {};

  const pragma = opts.pragma ?? ">=0.8.0";
  const resolvedLibs = opts.libraries ?? [];

  const { contractName, abi, bytecode, linkReferences } = parsed;
  const libName = `${contractName}Deployer`;

  // Find constructor
  const ctorEntry = abi.find((e) => e.type === "constructor");
  const ctorParams = ctorEntry?.inputs ?? [];

  // Collect struct definitions from constructor params
  const structDefs = collectStructDefs(ctorParams);
  const structNames = new Set(structDefs.map((s) => s.name));

  // Build bytecode segments for the main contract
  const { segments: mainSegments, libParams: mainLibParams } =
    buildBytecodeSegments(bytecode, linkReferences);
  const hasLinks = mainLibParams.length > 0;

  // Determine if we're inlining library deployment
  const inlineLibs = hasLinks && resolvedLibs.length > 0;

  // ── Metadata comment ──
  const metaLines: string[] = [];
  if (parsed.sourcePath) metaLines.push(`@notice Source Contract: ${parsed.sourcePath}`);
  if (parsed.solcVersion) metaLines.push(`- solc: ${parsed.solcVersion}`);
  if (parsed.optimizerRuns !== undefined) metaLines.push(`- optimizer_runs: ${parsed.optimizerRuns}`);
  if (parsed.viaIR) metaLines.push(`- viaIR: true`);
  if (parsed.evmVersion) metaLines.push(`- evm_version: ${parsed.evmVersion}`);

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
  const initcodeParams = hasLinks
    ? mainLibParams.map((lp) => `address ${lp.name}`).join(", ")
    : "";

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
      const fnParams = libHasLinks
        ? libLibParams.map((lp) => `address ${lp.name}`).join(", ")
        : "";
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

  const deployParamStr = deployParams.join(", ");

  // ── deploy() body ──
  const deployBodyLines: string[] = [];

  if (inlineLibs) {
    // Deploy each library in topological order
    for (const rlib of resolvedLibs) {
      const { libParams: libLibParams } = buildBytecodeSegments(
        rlib.artifact.bytecode,
        rlib.artifact.linkReferences,
      );
      const callArgs =
        libLibParams.length > 0
          ? libLibParams.map((lp) => lp.name).join(", ")
          : "";
      deployBodyLines.push(
        `        address ${rlib.paramName} = _create(_${rlib.paramName}Initcode(${callArgs}));`,
      );
    }
  }

  const initcodeCallArgs = hasLinks
    ? mainLibParams.map((lp) => lp.name).join(", ")
    : "";

  if (ctorParams.length > 0) {
    const encodeArgs = ctorParams.map((p, i) => p.name || `arg${i}`).join(", ");
    deployBodyLines.push(`        bytes memory args = abi.encode(${encodeArgs});`);
    deployBodyLines.push(
      `        bytes memory initcode_ = abi.encodePacked(initcode(${initcodeCallArgs}), args);`,
    );
    deployBodyLines.push(`        deployed = _create(initcode_);`);
  } else {
    deployBodyLines.push(
      `        bytes memory initcode_ = initcode(${initcodeCallArgs});`,
    );
    deployBodyLines.push(`        deployed = _create(initcode_);`);
  }

  const deployBody = deployBodyLines.join("\n");

  // ── deploy2() body ──
  const deploy2BodyLines: string[] = [];

  if (inlineLibs) {
    for (const rlib of resolvedLibs) {
      const { libParams: libLibParams } = buildBytecodeSegments(
        rlib.artifact.bytecode,
        rlib.artifact.linkReferences,
      );
      const callArgs =
        libLibParams.length > 0
          ? libLibParams.map((lp) => lp.name).join(", ")
          : "";
      deploy2BodyLines.push(
        `        address ${rlib.paramName} = _create(_${rlib.paramName}Initcode(${callArgs}));`,
      );
    }
  }

  if (ctorParams.length > 0) {
    const encodeArgs = ctorParams.map((p, i) => p.name || `arg${i}`).join(", ");
    deploy2BodyLines.push(`        bytes memory args = abi.encode(${encodeArgs});`);
    deploy2BodyLines.push(
      `        bytes memory initcode_ = abi.encodePacked(initcode(${initcodeCallArgs}), args);`,
    );
    deploy2BodyLines.push(`        deployed = _create2(initcode_, salt);`);
  } else {
    deploy2BodyLines.push(
      `        bytes memory initcode_ = initcode(${initcodeCallArgs});`,
    );
    deploy2BodyLines.push(`        deployed = _create2(initcode_, salt);`);
  }

  const deploy2Body = deploy2BodyLines.join("\n");

  const deploy2Params =
    deployParams.length > 0 ? `${deployParamStr}, bytes32 salt` : `bytes32 salt`;

  // ── Assemble ──
  const structSection = structBlock ? `\n${structBlock}\n` : "";
  const libInitcodeSection =
    libInitcodeFns.length > 0 ? "\n" + libInitcodeFns.join("\n\n") + "\n" : "";

  return `// SPDX-License-Identifier: MIT
pragma solidity ${pragma};

library ${libName} {
${metaBlock}${structSection}
    function deploy(${deployParamStr}) internal returns (address deployed) {
${deployBody}
    }

    function deploy2(${deploy2Params}) internal returns (address deployed) {
${deploy2Body}
    }

    function initcode(${initcodeParams}) internal pure returns (bytes memory) {
${initcodeBody}
    }
${libInitcodeSection}
    function _create(bytes memory initcode_) private returns (address deployed) {
        assembly {
            deployed := create(0, add(initcode_, 0x20), mload(initcode_))
            if iszero(deployed) { revert(0, returndatasize()) }
        }
    }

    function _create2(bytes memory initcode_, bytes32 salt) private returns (address deployed) {
        assembly {
            deployed := create2(0, add(initcode_, 0x20), mload(initcode_), salt)
            if iszero(deployed) { revert(0, returndatasize()) }
        }
    }
}
`;
}
