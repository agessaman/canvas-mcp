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
      // The manifest lists every tool the extension can expose, item banks
      // included, so the full set is what this deep-equal compares against.
      // The opposite direction — that they are absent when the flag is off —
      // is asserted below.
      CANVAS_ENABLE_ITEM_BANKS: 'true',
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

const ITEM_BANK_TOOLS = [
  'list-item-banks',
  'get-item-bank',
  'list-item-bank-questions',
  'create-item-bank-question',
  'update-item-bank-question',
  'delete-item-bank-question',
];

test('the item bank tools are absent unless the operator opts in', async () => {
  // Not registered rather than registered-and-erroring. A stock install should
  // never advertise a tool that would reach a private Instructure service, and
  // a tool that is always going to fail is worse for a client than one that was
  // never offered.
  const listWithFlag = async (value) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, 'dist/index.js')],
      cwd: repoRoot,
      env: {
        ...process.env,
        CANVAS_API_TOKEN: 'mcp-compatibility-test-token',
        CANVAS_BASE_URL: 'https://canvas.invalid',
        CANVAS_ENABLE_ITEM_BANKS: value,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'canvas-mcp-flag-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      return new Set(tools.map((tool) => tool.name));
    } finally {
      await client.close();
    }
  };

  const off = await listWithFlag('');
  for (const name of ITEM_BANK_TOOLS) {
    assert.ok(!off.has(name), `${name} is registered with the flag off`);
  }

  const on = await listWithFlag('true');
  for (const name of ITEM_BANK_TOOLS) {
    assert.ok(on.has(name), `${name} is missing with the flag on`);
  }
  assert.equal(on.size - off.size, ITEM_BANK_TOOLS.length, 'the flag should add exactly the item bank tools');

  // A value that is not a recognised truthy spelling must leave them off.
  const bogus = await listWithFlag('maybe');
  assert.equal(bogus.size, off.size, 'an unrecognised flag value should not enable the tools');
});
