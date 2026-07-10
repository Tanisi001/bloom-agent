import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * @typedef {Object} McpTool
 * @property {string} name
 * @property {string} description
 * @property {Record<string, any>} inputSchema
 */

/**
 * @typedef {Object} McpServer
 * @property {string} name
 * @property {Client} client
 * @property {McpTool[]} tools
 */

/** @type {McpServer[]} */
const servers = [];

/** @type {Map<string, McpServer>} */
const toolToServer = new Map();

/**
 * @typedef {Object} McpServerConfig
 * @property {string} name
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string>} env
 */

/**
 * Get configured MCP servers from environment.
 * @returns {McpServerConfig[]}
 */
function getServerConfigs() {
  /** @type {McpServerConfig[]} */
  const configs = [];

  if (process.env.ATLASSIAN_SITE_NAME) {
    configs.push({
      name: 'jira',
      command: process.env.MCP_JIRA_COMMAND || 'npx',
      args: (process.env.MCP_JIRA_ARGS || '-y,@aashari/mcp-server-atlassian-jira').split(','),
      env: {
        ATLASSIAN_SITE_NAME: process.env.ATLASSIAN_SITE_NAME || '',
        ATLASSIAN_USER_EMAIL: process.env.ATLASSIAN_USER_EMAIL || '',
        ATLASSIAN_API_TOKEN: process.env.ATLASSIAN_API_TOKEN || '',
      },
    });
  }

  if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    configs.push({
      name: 'github',
      command: process.env.MCP_GITHUB_COMMAND || 'npx',
      args: (process.env.MCP_GITHUB_ARGS || '-y,@modelcontextprotocol/server-github').split(','),
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '',
      },
    });
  }

  return configs;
}

/**
 * Connect to all configured MCP servers and discover tools.
 * @returns {Promise<McpTool[]>}
 */
export async function connectMcp() {
  if (servers.length > 0) return servers.flatMap((s) => s.tools);

  const configs = getServerConfigs();
  /** @type {McpTool[]} */
  const allTools = [];

  for (const config of configs) {
    try {
      console.log(`[MCP:${config.name}] Connecting...`);
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: {
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME || '',
          ...config.env,
        },
      });
      const client = new Client({ name: `tanisi-agent-${config.name}`, version: '0.1.0' });
      await client.connect(transport);

      const { tools } = await client.listTools();
      const mcpTools = /** @type {McpTool[]} */ (tools || []);
      const server = { name: config.name, client, tools: mcpTools };
      servers.push(server);

      for (const tool of mcpTools) {
        toolToServer.set(tool.name, server);
      }
      allTools.push(...mcpTools);
      console.log(`[MCP:${config.name}] Connected. ${mcpTools.length} tools available.`);
    } catch (e) {
      console.warn(`[MCP:${config.name}] Failed to connect: ${/** @type {any} */ (e).message}`);
    }
  }

  return allTools;
}

/**
 * Call a tool on the appropriate MCP server.
 * @param {string} name - Tool name
 * @param {Record<string, any>} args - Tool arguments
 * @returns {Promise<string>}
 */
export async function callMcpTool(name, args) {
  const server = toolToServer.get(name);
  if (!server) throw new Error(`No MCP server found for tool: ${name}`);
  const result = await server.client.callTool({ name, arguments: args });
  const texts = /** @type {any[]} */ (result.content || [])
    .filter((/** @type {any} */ c) => c.type === 'text')
    .map((/** @type {any} */ c) => c.text);
  return texts.join('\n') || 'No response from tool.';
}

/**
 * Convert MCP tools to Gemini function declarations.
 * @param {McpTool[]} tools
 * @returns {Array<{name: string, description: string, parameters: Record<string, any>}>}
 */
export function toGeminiFunctionDeclarations(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description || t.name,
    parameters: convertSchema(t.inputSchema),
  }));
}

/**
 * Convert JSON Schema to Gemini-compatible schema (strip unsupported keys recursively).
 * @param {Record<string, any>} schema
 * @returns {Record<string, any>}
 */
function convertSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  return stripUnsupported(schema);
}

/** Keys not supported by Gemini function declarations */
const UNSUPPORTED_KEYS = new Set([
  '$schema', 'additionalProperties', 'propertyNames', 'patternProperties',
  'if', 'then', 'else', 'allOf', 'anyOf', 'oneOf', 'not', 'default',
  'examples', 'title', '$id', '$ref', '$comment', 'readOnly', 'writeOnly',
  'contentEncoding', 'contentMediaType', 'definitions', '$defs',
]);

/**
 * Recursively strip unsupported keys from a schema object.
 * @param {any} obj
 * @returns {any}
 */
function stripUnsupported(obj) {
  if (Array.isArray(obj)) return obj.map(stripUnsupported);
  if (obj === null || typeof obj !== 'object') return obj;
  /** @type {Record<string, any>} */
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;
    result[key] = stripUnsupported(value);
  }
  // Clean required array to only reference existing properties
  if (result.required && Array.isArray(result.required) && result.properties) {
    const validProps = Object.keys(result.properties);
    result.required = result.required.filter((/** @type {string} */ r) => validProps.includes(r));
    if (result.required.length === 0) delete result.required;
  }
  return result;
}
