import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";
import ganache from "ganache";
import { BrowserProvider, ContractFactory } from "ethers";

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "forge-pack-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function compile(sources) {
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: Object.fromEntries(Object.entries(sources).map(([file, content]) => [file, { content }])),
        settings: {
          evmVersion: "shanghai",
          outputSelection: { "*": { "*": ["abi", "metadata", "evm.bytecode"] } },
        },
      }),
    ),
  );
  assert.deepEqual(output.errors?.filter((e) => e.severity === "error") ?? [], []);
  return output.contracts;
}

export function writeArtifacts(dir, contracts) {
  for (const [file, entries] of Object.entries(contracts)) {
    const folder = join(dir, basename(file));
    mkdirSync(folder, { recursive: true });
    for (const [name, contract] of Object.entries(entries)) {
      writeFileSync(
        join(folder, `${name}.json`),
        JSON.stringify({
          abi: contract.abi,
          bytecode: contract.evm.bytecode,
          metadata: JSON.parse(contract.metadata),
        }),
      );
    }
  }
}

export async function harness(t, sources, body) {
  const contracts = compile(sources);
  const dir = tempDir(t);
  const out = join(dir, "out");
  const deployers = join(dir, "deployers");
  writeArtifacts(out, contracts);
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../dist/cli.mjs", import.meta.url)),
    "Target",
    "--out",
    out,
    "--output",
    deployers,
  ]);
  const generated = readFileSync(join(deployers, "TargetDeployer.sol"), "utf8");
  const helper = readFileSync(join(deployers, "utils/DeployHelper.sol"), "utf8");
  const compiled = compile({
    "TargetDeployer.sol": generated,
    "utils/DeployHelper.sol": helper,
    "Harness.sol": `pragma solidity ^0.8.20;
      import {TargetDeployer} from "./TargetDeployer.sol";
      contract Harness { address public deployed; ${body} }`,
  });
  const rpc = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "shanghai" } });
  const provider = new BrowserProvider(rpc);
  t.after(async () => {
    provider.destroy();
    await rpc.disconnect();
  });
  const signer = await provider.getSigner();
  const artifact = compiled["Harness.sol"].Harness;
  const instance = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer).deploy();
  await instance.waitForDeployment();
  return { instance, provider, contracts, generated, out };
}
