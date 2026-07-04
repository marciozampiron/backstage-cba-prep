// Translate provider-neutral ToolRegistry entries into Strands tools. The Strands
// `tool()` helper and Zod live here (infrastructure) only — the ToolRegistry and
// the domain/application layers stay SDK-free, carrying a neutral JSON-schema-ish
// `inputSchema`. Both `strands` and `zod` are injectable so unit tests stay offline.

export async function toStrandsTools(toolDefs, deps = {}) {
  if (!toolDefs || !toolDefs.length) return undefined;
  const { tool } = deps.strands || (await import('@strands-agents/sdk'));
  const { z } = deps.zod || (await import('zod'));

  return toolDefs.map((t) =>
    tool({
      name: t.name,
      description: t.description || '',
      inputSchema: jsonSchemaToZod(t.inputSchema, z),
      callback: async (input) => t.handler(input),
    })
  );
}

// Minimal, provider-neutral JSON-schema subset -> Zod. Handles an object with
// typed properties (string/number/integer/boolean), a `required` list, and
// descriptions. Anything outside the subset degrades to a permissive object so a
// tool is never rejected just because its schema is richer than we model.
export function jsonSchemaToZod(schema, z) {
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
    return z.object({}).passthrough();
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    let field;
    switch (prop && prop.type) {
      case 'string':
        field = z.string();
        break;
      case 'number':
        field = z.number();
        break;
      case 'integer':
        field = z.number().int();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      default:
        field = z.any();
    }
    if (prop && prop.description) field = field.describe(prop.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(shape);
}
