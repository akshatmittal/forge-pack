import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, Contract, keccak256 } from "ethers";
import { harness } from "./helpers.mjs";

test("payable constructors compile and receive the deployment value", async (t) => {
  const { instance, provider, contracts } = await harness(
    t,
    {
      "Target.sol": `pragma solidity ^0.8.20;
      contract Target { uint public received; constructor(uint multiplier) payable { received = msg.value * multiplier; } }`,
    },
    `function run() external payable { deployed = TargetDeployer.deploy(7, bytes32(0)); }`,
  );
  await (await instance.run({ value: 13 })).wait();
  const address = await instance.deployed();
  const target = new Contract(address, contracts["Target.sol"].Target.abi, provider);
  assert.equal(await target.received(), 91n);
  assert.equal(await provider.getBalance(address), 13n);
});

test("contract arrays preserve fixed and dynamic dimensions in constructor encoding", async (t) => {
  const { instance, provider, contracts } = await harness(
    t,
    {
      "Target.sol": `pragma solidity ^0.8.20;
      interface I {}
      contract Target { bytes32 public digest;
        constructor(I[][2] memory items) { digest = keccak256(abi.encode(items)); }
      }`,
    },
    `function run(address[][2] memory items) external { deployed = TargetDeployer.deploy(items, bytes32(0)); }`,
  );
  const items = [
    ["0x0000000000000000000000000000000000000011", "0x0000000000000000000000000000000000000022"],
    ["0x0000000000000000000000000000000000000033"],
  ];
  await (await instance.run(items)).wait();
  const target = new Contract(await instance.deployed(), contracts["Target.sol"].Target.abi, provider);
  assert.equal(await target.digest(), keccak256(AbiCoder.defaultAbiCoder().encode(["address[][2]"], [items])));
});

test("user-defined value types use their underlying ABI types", async (t) => {
  const { instance, provider, contracts } = await harness(
    t,
    {
      "Target.sol": `pragma solidity ^0.8.20;
      type Amount is uint128;
      contract Target { uint public total;
        constructor(Amount base, Amount[] memory amounts) {
          total = Amount.unwrap(base) + Amount.unwrap(amounts[0]) * 10 + Amount.unwrap(amounts[1]) * 100;
        }
      }`,
    },
    `function run(uint128 base, uint128[] memory amounts) external { deployed = TargetDeployer.deploy(base, amounts, bytes32(0)); }`,
  );
  await (await instance.run(3, [5, 7])).wait();
  const target = new Contract(await instance.deployed(), contracts["Target.sol"].Target.abi, provider);
  assert.equal(await target.total(), 753n);
});
