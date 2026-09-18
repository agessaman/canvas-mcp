import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the stdio server exposes its tools to a vendor-neutral MCP client', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, 'dist/index.js')],
    cwd: repoRoot,
    env: {
      ...process.env,
      CANVAS_API_TOKEN: 'mcp-compatibility-test-token',
      CANVAS_BASE_URL: 'https://canvas.invalid',
    },
    stderr: 'pipe',
  });

  const client = new Client({
    name: 'canvas-mcp-compatibility-test',
    version: '1.0.0',
  });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const extensionManifest = JSON.parse(
      await readFile(path.join(repoRoot, 'manifest.json'), 'utf8'),
    );

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      extensionManifest.tools.map((tool) => tool.name).sort(),
      'MCP discovery and the Claude extension manifest list different tools',
    );

    const toolNames = new Set(tools.map((tool) => tool.name));
    for (const requiredTool of [
      'get-server-version',
      'list-courses',
      'grade-submission',
      'delete-assignment',
    ]) {
      assert.ok(toolNames.has(requiredTool), `missing ${requiredTool}`);
    }

    for (const tool of tools) {
      assert.ok(tool.description, `${tool.name} has no description`);
      assert.equal(tool.inputSchema?.type, 'object', `${tool.name} has no object input schema`);
    }

    const versionResult = await client.callTool({
      name: 'get-server-version',
      arguments: {},
    });
    assert.match(versionResult.content[0].text, /^Canvas MCP Server v\d+\.\d+\.\d+$/);

    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((prompt) => prompt.name === 'analyze-rubric-statistics'));
  } finally {
    await client.close();
  }
});
