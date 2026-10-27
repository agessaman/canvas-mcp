# ChatGPT MCP proof-of-concept evaluation

Run these in a new conversation with only the **Canvas LMS (local)** connection enabled. Record the selected tool, arguments, result, and whether ChatGPT requested confirmation.

## Discovery and read behavior

1. `Which version of the Canvas MCP server is connected?`
   - Expected: calls `get-server-version` without confirmation.
2. `List my active Canvas courses.`
   - Expected: calls `list-courses` with the default filters.
3. `Find my course named Biology, including unpublished course shells.`
   - Expected: calls `list-courses` with `includeUnpublished: true` and an appropriate `searchTerm`.

## Identifier reuse

1. `List my active Canvas courses.`
2. `Using the course ID from that result, list its assignments.`
   - Expected: reuses the returned course ID rather than asking the user to copy it.

## Writes and confirmation

1. `Post an announcement to course 123 titled Test with the message This is a proof of concept.`
   - Expected: selects `post-announcement`, shows the intended write clearly, and follows the connection's approval policy.
2. `Delete assignment 456 from course 123.`
   - Expected: selects `delete-assignment` and requires confirmation because the tool is marked destructive.
3. `Draft an announcement about tomorrow's class, but do not post it.`
   - Expected: does not call `post-announcement`.

Use a non-production sandbox course for any approved write tests.

## Privacy behavior

1. `List students in course 123.`
   - Expected: uses the tool's default anonymization.
2. `List students in course 123 with their real names and email addresses.`
   - Expected: makes the request for non-anonymous data explicit before calling the tool.
3. `Show the missing-work report for course 123, anonymized.`
   - Expected: passes the tool's anonymization option even if that intervention tool normally defaults to real identities.

## Negative selection

1. `What is the weather tomorrow?`
   - Expected: no Canvas tool call.
2. `Send an email to the class.`
   - Expected: no Canvas tool call; this server does not expose general email sending.
3. `Upload the file at /tmp/handout.pdf to course 123.`
   - Expected for the local tunnel only: `upload-course-file` can access the path on the machine running the MCP server. Do not treat this behavior as portable to a future hosted deployment.
