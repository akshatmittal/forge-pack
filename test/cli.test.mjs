import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the installed package exposes an executable CLI", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "forge-pack-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", dir], { encoding: "utf8" }));
  execFileSync("npm", [
    "install",
    "--prefix",
    dir,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(dir, pack.filename),
  ]);
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const output = execFileSync(join(dir, "node_modules", ".bin", "forge-pack"), ["--version"], { encoding: "utf8" });
  assert.equal(output.trim(), version);
  assert.ok(pack.files.every(({ path }) => !path.startsWith("test/") && !path.startsWith("src/")));
});

test("the CLI warns about an older or customized helper without overwriting it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "forge-pack-helper-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "out", "Target.sol"), { recursive: true });
  writeFileSync(join(dir, "out", "Target.sol", "Target.json"), JSON.stringify({ bytecode: { object: "60006000" } }));
  mkdirSync(join(dir, "deployers", "utils"), { recursive: true });
  const helper = join(dir, "deployers", "utils", "DeployHelper.sol");
  writeFileSync(helper, "// customized helper\n");
  const cli = new URL("../dist/cli.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [cli.pathname, "Target"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Warning:.*DeployHelper.sol.*regenerate/i);
  assert.equal(readFileSync(helper, "utf8"), "// customized helper\n");
});
