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

export interface GenerateDeployerOptions {
  pragma?: string;
  libraries?: ResolvedLibrary[];
}
