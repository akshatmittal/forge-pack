/** Claim a name in a generated Solidity scope, including any numeric suffixes. */
export function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base}${suffix++}`;
  used.add(name);
  return name;
}
