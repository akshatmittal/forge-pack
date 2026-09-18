# forge-pack

Generate self-contained Solidity deployer libraries from [Forge](https://book.getfoundry.sh/) build artifacts.

`forge-pack` reads your compiled contract JSON, resolves library dependencies, and outputs a single `.sol` file containing a deployer library with `deploy()` (CREATE2) and `initcode()` functions, ready to use in scripts or tests.

## Usage

The package does not require installation, you can directly use `npx`/`pnpx` to run it:

```bash
npx forge-pack@latest <contract-name>
```

## CLI Usage

```
forge-pack <ContractName> [options]
```

### Options

| Flag               | Description                                | Default       |
| ------------------ | ------------------------------------------ | ------------- |
| `--out <dir>`      | Forge output directory                     | `./out`       |
| `--output <dir>`   | Where to write the deployer `.sol` file    | `./deployers` |
| `--build`          | Run `forge build` before reading artifacts | `false`       |
| `--pragma <range>` | Solidity pragma for generated file         | `>=0.8.0`     |
| `-v, --version`    | Show version number                        | -             |
| `-h, --help`       | Show help message                          | -             |

### Example

```bash
# Generate a deployer for MyToken
forge-pack MyToken

# Build first, then generate with a specific pragma
forge-pack MyToken --build --pragma "^0.8.20"

# Use a custom output directory
forge-pack MyToken --output src/deployers
```

This produces a file like `deployers/MyTokenDeployer.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {DeployHelper} from "./utils/DeployHelper.sol";

library MyTokenDeployer {
    function deploy(string memory name, string memory symbol, bytes32 salt) internal returns (address deployed) { ... }
    function initcode() internal pure returns (bytes memory) { ... }
}
```

Constructor parameters are automatically extracted from the ABI. Struct types used in constructor arguments get their definitions included in the generated file.

Contract and enum parameters use their ABI types, including array dimensions. User-defined value types use their underlying ABI types. Structs are identified by their qualified names; colliding generated identifiers receive numeric suffixes.

All deployments use CREATE2. The `deploy()` function requires a `bytes32 salt` parameter for deterministic addressing.

For payable constructors, call `deploy()` from a payable caller: the target receives the caller's `msg.value`. Nonpayable targets and linked libraries receive zero value. The generated library function itself is not marked `payable`, because Solidity does not allow payable library functions.

### Upgrading existing deployers

Regenerate both the deployer files and `utils/DeployHelper.sol` to get the deployment fixes. The CLI preserves existing helper files and warns if they differ from the bundled version. Back up any custom changes, remove the old helper, and rerun the CLI. New deployers require the helper overload that accepts an explicit deployment value.

## Library Dependencies

If your contract links against external libraries, `forge-pack` resolves them recursively in topological order and generates inline deployment helpers. Libraries are deployed using CREATE2 with zero salt and are automatically deduplicated, if the same library is used by multiple contracts it is only deployed once. The deployer handles deploying libraries before the main contract, so the output remains self-contained.

Library artifacts are matched by the source path in their compiler metadata, not just the library name. Ambiguous or missing matches produce an error rather than selecting an unrelated artifact.

## Programmatic API

```typescript
import { findArtifact, parseArtifact, generateDeployer, resolveLibraries } from "forge-pack";

const artifactPath = findArtifact("MyToken", "./out");
const parsed = parseArtifact(artifactPath, "MyToken");

const libraries = resolveLibraries(parsed.linkReferences, "./out");
const solidity = generateDeployer(parsed, { pragma: ">=0.8.0", libraries });
```

### Exports

**Functions:**

- `findArtifact(contractName, outDir, sourcePath?)` — Locate a contract artifact in the Forge output directory; pass its exact source path to disambiguate duplicate names
- `parseArtifact(artifactPath, contractName)` — Parse a Forge artifact JSON into a structured object
- `resolveLibraries(linkReferences, outDir)` — Recursively resolve library dependencies in deploy order
- `generateDeployer(parsed, options?)` — Generate Solidity deployer library source code

**Types:** `ParsedArtifact`, `LinkReference`, `LinkReferences`, `AbiParam`, `AbiEntry`, `ResolvedLibrary`, `GenerateDeployerOptions`

## Development

Run `pnpm test` to build and execute the regression tests, and `pnpm typecheck` to check TypeScript. All tests and Solidity fixtures live under `test/`, outside `src/`. Tests compile fixtures with solc and execute generated deployers on a disposable local EVM; Forge is not required.

## License

MIT
