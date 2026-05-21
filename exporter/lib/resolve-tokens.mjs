// Token resolver — walks an arbitrary value tree and replaces $token refs
// with their concrete values from a variables map.

/**
 * @param {any} value
 * @param {Record<string, { value: any, type?: string }>} variables  flat map: { "color-accent": { value: "#3D1B5C", type: "color" }, ... }
 * @param {Set<string>} [seen]  cycle guard
 * @returns {any}
 */
export function resolveTokens(value, variables, seen = new Set()) {
  if (value == null) return value;

  // Direct $token-name string
  if (typeof value === "string" && value.startsWith("$")) {
    const name = value.slice(1);
    if (seen.has(name)) return value; // cycle
    const v = variables[name];
    if (!v) return value; // unknown — leave untouched, easier to debug
    seen.add(name);
    const resolved = resolveTokens(v.value, variables, seen);
    seen.delete(name);
    return resolved;
  }

  if (Array.isArray(value)) {
    return value.map((v) => resolveTokens(v, variables, seen));
  }

  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveTokens(v, variables, seen);
    }
    return out;
  }

  return value;
}

/**
 * Normalize the variables map returned by Pencil MCP into a flat
 * Record<name, {value, type}> shape.
 */
export function normalizeVariables(raw) {
  if (!raw) return {};
  // Pencil's get_variables returns { variables: { "color-accent": { type, value }, ... } }
  if (raw.variables && typeof raw.variables === "object") {
    return raw.variables;
  }
  // Already flat
  return raw;
}
