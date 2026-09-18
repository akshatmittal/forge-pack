import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, Contract, ContractFactory, getCreate2Address, keccak256, ZeroHash } from "ethers";
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

test("same-named structs retain distinct layouts in nested fields and arrays", async (t) => {
  const { instance, provider, contracts } = await harness(
    t,
    {
      "Target.sol": `pragma solidity ^0.8.20;
      library A { struct Config { uint x; } }
      library B { struct Config { uint x; uint y; } }
      contract Target { struct Outer { A.Config left; B.Config right; } uint public total;
        constructor(A.Config memory a, B.Config[] memory b, Outer memory c) {
          total = a.x + b[0].x * 10 + b[0].y * 100 + c.left.x * 1000 + c.right.y * 10000;
        }
      }`,
    },
    `function run(TargetDeployer.Config memory a, TargetDeployer.Config2[] memory b, TargetDeployer.Outer memory c) external {
        deployed = TargetDeployer.deploy(a, b, c, bytes32(0));
      }`,
  );
  await (await instance.run([2], [[3, 5]], [[7], [11, 13]])).wait();
  const target = new Contract(await instance.deployed(), contracts["Target.sol"].Target.abi, provider);
  assert.equal(await target.total(), 137532n);
});

test("constructor names cannot shadow generated variables, functions, or builtins", async (t) => {
  const { instance, provider, contracts } = await harness(
    t,
    {
      "Target.sol": `pragma solidity ^0.8.20;
      contract Target { uint public total;
        constructor(uint salt, uint salt2, uint deployed, uint initcode, uint args, uint initcode_, uint abi, uint DeployHelper) {
          total = salt + salt2 * 10 + deployed * 100 + initcode * 1000 + args * 10000 + initcode_ * 100000 + abi * 1000000 + DeployHelper * 10000000;
        }
      }`,
    },
    `function run() external { deployed = TargetDeployer.deploy(1, 2, 3, 4, 5, 6, 7, 8, bytes32(0)); }`,
  );
  await (await instance.run()).wait();
  const target = new Contract(await instance.deployed(), contracts["Target.sol"].Target.abi, provider);
  assert.equal(await target.total(), 87654321n);
});

test("colliding library names link the correct implementations through nested dependencies", async (t) => {
  const { instance, provider, contracts } = await harness(
    t,
    {
      "Upper.sol": "pragma solidity ^0.8.20; library A { function value() external pure returns(uint) { return 11; } }",
      "Lower.sol": "pragma solidity ^0.8.20; library a { function value() external pure returns(uint) { return 29; } }",
      "Suffix.sol":
        "pragma solidity ^0.8.20; library a2 { function value() external pure returns(uint) { return 47; } }",
      "Parent.sol": `pragma solidity ^0.8.20; import {A} from './Upper.sol'; import {a} from './Lower.sol';
      library Parent { function value() external view returns(uint) { return a.value() * 100 + A.value(); } }`,
      "Target.sol": `pragma solidity ^0.8.20;
      import {A} from './Upper.sol'; import {a as Lower} from './Lower.sol';
      import {a2 as Suffix} from './Suffix.sol'; import {Parent} from './Parent.sol';
      contract Target { uint[6] public values;
        constructor(uint a, uint _aInitcode) { values = [Parent.value(), A.value(), Lower.value(), Suffix.value(), a, _aInitcode]; }
      }`,
    },
    `function run() external { deployed = TargetDeployer.deploy(71, 83, bytes32(0)); }`,
  );
  await (await instance.run()).wait();
  const target = new Contract(await instance.deployed(), contracts["Target.sol"].Target.abi, provider);
  assert.deepEqual(await Promise.all([0, 1, 2, 3, 4, 5].map((i) => target.values(i))), [
    2911n,
    11n,
    29n,
    47n,
    71n,
    83n,
  ]);
});

test("fresh and reused libraries receive no ETH while each payable target receives its value", async (t) => {
  const { instance, provider, contracts } = await harness(
    t,
    {
      "Math.sol":
        "pragma solidity ^0.8.20; library Math { function value() external pure returns(uint) { return 29; } }",
      "Target.sol": `pragma solidity ^0.8.20; import {Math} from './Math.sol';
      contract Target { uint public result; uint public received;
        constructor() payable { result = Math.value(); received = msg.value; }
      }`,
    },
    `function run(bytes32 salt) external payable { deployed = TargetDeployer.deploy(salt); }`,
  );
  const library = getCreate2Address(
    await instance.getAddress(),
    ZeroHash,
    keccak256(`0x${contracts["Math.sol"].Math.evm.bytecode.object}`),
  );
  for (const [salt, value] of [
    [ZeroHash, 13n],
    [`0x${"01".repeat(32)}`, 17n],
  ]) {
    await (await instance.run(salt, { value })).wait();
    const address = await instance.deployed();
    const target = new Contract(address, contracts["Target.sol"].Target.abi, provider);
    assert.equal(await target.result(), 29n);
    assert.equal(await target.received(), value);
    assert.equal(await provider.getBalance(address), value);
    assert.notEqual(await provider.getCode(library), "0x");
    assert.equal(await provider.getBalance(library), 0n);
    assert.equal(await provider.getBalance(await instance.getAddress()), 0n);
  }
});

test("same-named libraries from different source files remain distinct at runtime", async (t) => {
  const { instance, provider, contracts } = await harness(
    t,
    {
      "First.sol":
        "pragma solidity ^0.8.20; library Math { function value() external pure returns(uint) { return 11; } }",
      "Second.sol":
        "pragma solidity ^0.8.20; library Math { function value() external pure returns(uint) { return 29; } }",
      "Target.sol": `pragma solidity ^0.8.20; import {Math as First} from './First.sol'; import {Math as Second} from './Second.sol';
      contract Target { uint public result; constructor() { result = First.value() * 100 + Second.value(); } }`,
    },
    `function run() external { deployed = TargetDeployer.deploy(bytes32(0)); }`,
  );
  await (await instance.run()).wait();
  const target = new Contract(await instance.deployed(), contracts["Target.sol"].Target.abi, provider);
  assert.equal(await target.result(), 1129n);
});

test("caller-supplied library addresses work with colliding names", async (t) => {
  const { instance, provider, contracts } = await harness(
    t,
    {
      "Upper.sol": "pragma solidity ^0.8.20; library A { function value() external pure returns(uint) { return 11; } }",
      "Lower.sol": "pragma solidity ^0.8.20; library a { function value() external pure returns(uint) { return 29; } }",
      "Target.sol": `pragma solidity ^0.8.20; import {A} from './Upper.sol'; import {a as Lower} from './Lower.sol';
      contract Target { uint public result; constructor(uint a) {
        uint upper = A.value(); uint lower = Lower.value(); result = upper * 100 + lower + a;
      } }`,
    },
    `function run(address upper, address lower) external { deployed = TargetDeployer.deploy(3, upper, lower, bytes32(0)); }`,
    { inlineLibraries: false },
  );
  const signer = await provider.getSigner();
  const upper = contracts["Upper.sol"].A;
  const lower = contracts["Lower.sol"].a;
  const a = await new ContractFactory(upper.abi, upper.evm.bytecode.object, signer).deploy();
  const b = await new ContractFactory(lower.abi, lower.evm.bytecode.object, signer).deploy();
  await Promise.all([a.waitForDeployment(), b.waitForDeployment()]);
  await (await instance.run(await a.getAddress(), await b.getAddress())).wait();
  const target = new Contract(await instance.deployed(), contracts["Target.sol"].Target.abi, provider);
  assert.equal(await target.result(), 1132n);
});

test("nonpayable targets receive zero value even inside a payable caller", async (t) => {
  const { instance, provider } = await harness(
    t,
    {
      "Target.sol": "pragma solidity ^0.8.20; contract Target {}",
    },
    `function run() external payable { deployed = TargetDeployer.deploy(bytes32(0)); }`,
  );
  await (await instance.run({ value: 19 })).wait();
  assert.notEqual(await provider.getCode(await instance.deployed()), "0x");
  assert.equal(await provider.getBalance(await instance.deployed()), 0n);
  assert.equal(await provider.getBalance(await instance.getAddress()), 19n);
});
