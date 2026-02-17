import { findArtifact, parseArtifact } from "./artifact.js";
import type { LinkReferences, ResolvedLibrary } from "./types.js";

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

  function resolve(file: string, lib: string): ResolvedLibrary {
    const key = `${file}:${lib}`;
    if (resolved.has(key)) return resolved.get(key)!;
    if (visiting.has(key)) {
      throw new Error(`Circular library dependency detected: ${key}`);
    }
    visiting.add(key);

    const artifactPath = findArtifact(lib, outDir);
    const artifact = parseArtifact(artifactPath, lib);

    const libIds = collectLibIds(artifact.linkReferences);
    const deps: string[] = [];
    for (const dep of libIds) {
      const depResolved = resolve(dep.file, dep.lib);
      deps.push(depResolved.paramName);
    }

    visiting.delete(key);

    const entry: ResolvedLibrary = {
      paramName: makeParamName(lib),
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

  // Disambiguate colliding paramNames with numeric suffixes
  const libs = Array.from(resolved.values());
  const nameCount = new Map<string, number>();
  for (const entry of libs) {
    const count = nameCount.get(entry.paramName) ?? 0;
    nameCount.set(entry.paramName, count + 1);
  }

  const collisions = new Set<string>();
  for (const [name, count] of nameCount) {
    if (count > 1) collisions.add(name);
  }

  if (collisions.size > 0) {
    const nameIndex = new Map<string, number>();
    for (const entry of libs) {
      if (!collisions.has(entry.paramName)) continue;
      const idx = (nameIndex.get(entry.paramName) ?? 0) + 1;
      nameIndex.set(entry.paramName, idx);
      if (idx > 1) {
        const oldName = entry.paramName;
        entry.paramName = `${oldName}${idx}`;
      }
    }

    // Update deps references to use new names
    const keyToName = new Map<string, string>();
    for (const entry of libs) {
      keyToName.set(`${entry.file}:${entry.lib}`, entry.paramName);
    }
    for (const entry of libs) {
      const depLibIds = collectLibIds(entry.artifact.linkReferences);
      entry.deps = depLibIds.map((d) => keyToName.get(`${d.file}:${d.lib}`)!);
    }
  }

  return libs;
}
