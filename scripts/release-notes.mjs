#!/usr/bin/env node
// Composes the release body from the commit log.
//
// GitHub's own generated notes are built from merged pull requests, and this
// repo commits straight to a branch — so left to itself the generator produces
// little more than a compare link. The commit bodies here are the actual
// changelog: what was probed, what Canvas did, what is still a guess. This
// lifts them into the release and lets GitHub append its section underneath.
//
// Usage: node scripts/release-notes.mjs --version 1.20.3 [--since v1.3.0]
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = name => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? '' : (args[at + 1] ?? '');
};

const version = flag('version');
const since = flag('since');
if (!version) {
  console.error('usage: node scripts/release-notes.mjs --version <v> [--since <tag>]');
  process.exit(2);
}

// Bodies are quoted in full for the most recent commits and reduced to subjects
// beyond that. A first release cut from a long-lived branch can carry seventy
// commits of prose, which would blow past what GitHub accepts for a release body.
const FULL_BODIES = 25;
const MAX_CHARS = 100_000;

const UNIT = '\x1f';
const RECORD = '\x1e';

const range = since ? `${since}..HEAD` : 'HEAD';
const raw = execFileSync('git', [
  'log', '--no-merges', `--format=%H${UNIT}%s${UNIT}%b${RECORD}`, range,
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const commits = raw
  .split(RECORD)
  .map(record => record.trim())
  .filter(Boolean)
  .map(record => {
    const [sha, subject, body = ''] = record.split(UNIT);
    return { sha: sha.trim(), subject: subject.trim(), body: cleanBody(body) };
  });

// Trailers are bookkeeping, not release notes.
function cleanBody(body) {
  return body
    .split('\n')
    .filter(line => !/^(Co-Authored-By|Signed-off-by|Co-authored-by):/i.test(line.trim()))
    .join('\n')
    .trim();
}

const lines = [];
lines.push(
  `Install: download \`canvas-mcp-${version}.mcpb\` from the assets below and open it with Claude Desktop.`,
  ''
);

if (commits.length === 0) {
  // A release with no commits behind it means the version moved on its own.
  // Say that plainly rather than emitting an empty section.
  lines.push(since
    ? `No commits between \`${since}\` and this release.`
    : 'No commit history available for these notes.');
} else {
  lines.push(since
    ? `## Changes since ${since}`
    : '## Changes');
  lines.push('');

  const detailed = commits.slice(0, FULL_BODIES);
  const remainder = commits.slice(FULL_BODIES);

  for (const commit of detailed) {
    lines.push(`### ${commit.subject}`, '');
    if (commit.body) lines.push(commit.body, '');
  }

  if (remainder.length) {
    lines.push(`### ${remainder.length} earlier commit${remainder.length === 1 ? '' : 's'} in this release`, '');
    for (const commit of remainder) lines.push(`- ${commit.subject}`);
    lines.push('');
  }
}

let notes = lines.join('\n');
if (notes.length > MAX_CHARS) {
  // Cut at a heading so the truncation never lands mid-sentence.
  const cut = notes.lastIndexOf('\n### ', MAX_CHARS);
  notes = `${notes.slice(0, cut > 0 ? cut : MAX_CHARS)}\n\n_Notes truncated here; run \`git log ${range}\` for the rest._\n`;
}
process.stdout.write(notes);
