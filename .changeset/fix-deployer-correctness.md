---
"forge-pack": patch
---

Fix the installed CLI entrypoint, payable constructor generation, ABI type conversion, source-qualified library resolution, and generated identifier collisions. Deploy linked libraries with zero value and forward ETH only to payable targets.

Regenerate both deployers and `utils/DeployHelper.sol` after upgrading. Existing helper files are preserved with a warning; back up custom changes and remove the old helper before regeneration.
