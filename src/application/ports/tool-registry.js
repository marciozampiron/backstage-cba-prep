// A provider-neutral, dependency-free tool registry. Adapters translate these
// entries into provider tools (e.g. Strands `tool({...})`). Keeping it SDK-free
// lets the domain/application list and scope tools without importing a framework.

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name
 * @property {string} [description]
 * @property {object} [inputSchema]                 // optional JSON-Schema-ish shape
 * @property {(input: object) => (any|Promise<any>)} handler
 */

export function createToolRegistry(initialTools = []) {
  const tools = new Map();

  function register(tool) {
    if (!tool || typeof tool.name !== 'string' || !tool.name) throw new TypeError('tool needs a name');
    if (typeof tool.handler !== 'function') throw new TypeError(`tool "${tool.name}" needs a handler`);
    tools.set(tool.name, {
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || null,
      handler: tool.handler,
    });
    return tool.name;
  }

  for (const t of initialTools) register(t);

  return {
    register,
    get: (name) => tools.get(name) || null,
    list: () => [...tools.values()],
    names: () => [...tools.keys()],
    get size() {
      return tools.size;
    },
  };
}
