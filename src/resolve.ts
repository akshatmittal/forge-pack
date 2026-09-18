import { findArtifact, parseArtifact } from "./artifact.js";
import type { LinkReferences, ResolvedLibrary } from "./types.js";
import { uniqueName } from "./names.js";

export function collectLibIds(linkRefs: LinkReferences): { file: string; lib: string }[] {
  const seen = new Set<string>();
  const result: { file: string; lib: string }[] = [];
  for (const [file, libs] of Object.entries(linkRefs)) {
    for (const lib of Object.keys(libs)) {
      const key = `${file}:${lib}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ file, lib });
      }
    }
  }
  return result;
}

export function makeParamName(libName: string): string {
  return libName.charAt(0).toLowerCase() + libName.slice(1);
}

/**
 * Recursively resolve all library dependencies for a contract's linkReferences.
 * Returns libraries in topological order (deploy-order: leaves first).
 * Disambiguates duplicate paramName values with numeric suffixes.
 */
export function resolveLibraries(linkRefs: LinkReferences, outDir: string): ResolvedLibrary[] {
  const resolved = new Map<string, ResolvedLibrary>();
  const visiting = new Set<string>();
  const usedNames = new Set<string>();

  function resolve(file: string, lib: string): ResolvedLibrary {
    const key = `${file}:${lib}`;
    if (resolved.has(key)) return resolved.get(key)!;
    if (visiting.has(key)) {
      throw new Error(`Circular library dependency detected: ${key}`);
    }
    visiting.add(key);

    const artifactPath = findArtifact(lib, outDir, file);
    const artifact = parseArtifact(artifactPath, lib);

    const libIds = collectLibIds(artifact.linkReferences);
    const deps: string[] = [];
    for (const dep of libIds) {
      const depResolved = resolve(dep.file, dep.lib);
      deps.push(depResolved.paramName);
    }

    visiting.delete(key);

    const entry: ResolvedLibrary = {
      paramName: uniqueName(makeParamName(lib), usedNames),
      file,
      lib,
      artifact,
      deps,
    };
    resolved.set(key, entry);
    return entry;
  }

  const topLevel = collectLibIds(linkRefs);
  for (const { file, lib } of topLevel) {
    resolve(file, lib);
  }

  return Array.from(resolved.values());
}
