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

All deployments use CREATE2. The `deploy()` function requires a `bytes32 salt` parameter for deterministic addressing.

## Library Dependencies

If your contract links against external libraries, `forge-pack` resolves them recursively in topological order and generates inline deployment helpers. Libraries are deployed using CREATE2 with zero salt and are automatically deduplicated, if the same library is used by multiple contracts it is only deployed once. The deployer handles deploying libraries before the main contract, so the output remains self-contained.

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

- `findArtifact(contractName, outDir)` — Locate a contract artifact in the Forge output directory
- `parseArtifact(artifactPath, contractName)` — Parse a Forge artifact JSON into a structured object
- `resolveLibraries(linkReferences, outDir)` — Recursively resolve library dependencies in deploy order
- `generateDeployer(parsed, options?)` — Generate Solidity deployer library source code

**Types:** `ParsedArtifact`, `LinkReference`, `LinkReferences`, `AbiParam`, `AbiEntry`, `ResolvedLibrary`, `GenerateDeployerOptions`

## License

MIT
