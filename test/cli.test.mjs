import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
