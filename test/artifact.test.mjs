import assert from "node:assert/strict";
import { test } from "node:test";
import { findArtifact, resolveLibraries } from "../dist/index.mjs";
import { compile, tempDir, writeArtifacts } from "./helpers.mjs";

test("library resolution selects the source-qualified artifact and rejects ambiguous names", (t) => {
  const out = tempDir(t);
  const contracts = compile({
    "src/First.sol":
      "pragma solidity ^0.8.20; library Math { function value() external pure returns(uint) { return 11; } }",
    "vendor/Second.sol":
      "pragma solidity ^0.8.20; library Math { function value() external pure returns(uint) { return 29; } }",
  });
  writeArtifacts(out, contracts);
  const [library] = resolveLibraries({ "vendor/Second.sol": { Math: [{ start: 0, length: 20 }] } }, out);
  assert.equal(library.artifact.bytecode, contracts["vendor/Second.sol"].Math.evm.bytecode.object);
  assert.throws(() => findArtifact("Math", out), /ambiguous/i);
  assert.throws(() => resolveLibraries({ "missing/Second.sol": { Math: [] } }, out), /No artifact found/);
});
