import { z } from "zod";

/**
 * Schema for a tool parameter that Canvas expects as a JSON object.
 *
 * `z.any()` is the obvious choice and the wrong one: it advertises `{}` in the
 * tool listing, with no `type`, so a client has nothing to coerce against and
 * may hand the value over as a JSON *string*. That string then goes to Canvas
 * verbatim — `"entry": "{\"title\":...}"` where an object was required — and
 * Canvas answers with a bare 500 that names nothing. Every raw-payload escape
 * hatch in this server was unusable for that reason.
 *
 * So: declare the object type for clients that honor it, and parse the string
 * for clients that don't.
 */
export function jsonObjectParam(description: string) {
  return z
    .union([z.record(z.string(), z.any()), z.string()])
    .transform((value, ctx) => {
      if (typeof value !== "string") return value;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Expected a JSON object, or a string containing one; this string is not valid JSON.",
        });
        return z.NEVER;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expected a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}.`,
        });
        return z.NEVER;
      }
      return parsed as Record<string, any>;
    })
    .describe(description);
}
