// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fixtures are source text, not templates
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard for the error-log sweep: a logger call in backend/src must never receive a raw
// error object (its message and stack can quote Stripe customer data, SQL parameters, recipient
// addresses or response bodies). Errors go through lib/safe-error-log.ts instead.

const SRC = path.resolve(__dirname, "../..");
// Logger calls and the logProblemOnce wrappers (their last arguments are logged).
const LOGGER_CALL =
  /\b(?:(?:\w+\.)*(?:log|logger)\??\.(?:error|warn|info|debug|fatal|trace)|logProblemOnce)\(/g;
const ERR_NAME = "(?:err|error|e|cause|fastifyError|\\w+Err|\\w+Error)";
const RULES: { name: string; pattern: RegExp }[] = [
  { name: "raw error as the log object", pattern: new RegExp(`^\\(\\s*${ERR_NAME}\\s*[,)]`) },
  { name: "raw error in the log fields", pattern: new RegExp(`[{,]\\s*${ERR_NAME}\\s*[:,}]`) },
  {
    name: "error message or stack",
    pattern: new RegExp(`\\b${ERR_NAME}\\??\\.(?:message|stack)\\b`),
  },
  { name: "raw promise rejection reason", pattern: /\b(?:result|outcome|settled)\.reason\b/ },
  { name: "interpolated error", pattern: new RegExp(`\\$\\{\\s*${ERR_NAME}\\s*\\}`) },
  { name: "stringified error", pattern: new RegExp(`String\\(\\s*${ERR_NAME}\\s*\\)`) },
];

// Blanks string literals. Template literals lose their text but keep their `${...}` expressions,
// so `${err.message}` inside a log message is still scanned.
function stripStrings(code: string): string {
  let out = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      out += '""';
      i = j;
    } else if (c === "`") {
      let j = i + 1;
      out += '""';
      while (j < code.length && code[j] !== "`") {
        if (code[j] === "\\") j += 2;
        else if (code[j] === "$" && code[j + 1] === "{") {
          let depth = 1;
          const start = j + 2;
          j = start;
          for (; j < code.length && depth > 0; j++) {
            if (code[j] === "{") depth++;
            else if (code[j] === "}") depth--;
          }
          out += ` \${${stripStrings(code.slice(start, j - 1))}} `;
        } else j++;
      }
      i = j;
    } else out += c;
  }
  return out;
}

// Argument text of every logger call in `code`, parentheses balanced across lines.
function loggerCalls(code: string): { line: number; args: string }[] {
  const calls: { line: number; args: string }[] = [];
  for (const match of code.matchAll(LOGGER_CALL)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < code.length; end++) {
      if (code[end] === "(") depth++;
      else if (code[end] === ")" && --depth === 0) break;
    }
    calls.push({
      line: code.slice(0, open).split("\n").length,
      args: stripStrings(code.slice(open, end + 1)),
    });
  }
  return calls;
}

// `errorLogFields(err)` and friends are the sanctioned way to log an error: drop their arguments.
const HELPER_CALL = /\b\w*(?:ErrorFields|errorLogFields)\((?:[^()]|\([^()]*\))*\)/g;

function violations(code: string): string[] {
  return loggerCalls(code).flatMap(({ line, args }) => {
    const checked = args.replace(HELPER_CALL, '""');
    return RULES.filter((r) => r.pattern.test(checked)).map((r) => `line ${line}: ${r.name}`);
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("logger calls never receive a raw error", () => {
  it("backend/src has no violations", () => {
    const found = sourceFiles(SRC)
      .filter((file) => !file.endsWith(path.join("lib", "safe-error-log.ts")))
      .flatMap((file) =>
        violations(readFileSync(file, "utf8")).map((v) => `${path.relative(SRC, file)} ${v}`)
      );
    expect(found).toEqual([]);
  });

  it("flags raw errors in every shape the sweep removed", () => {
    for (const bad of [
      'log.error(err, "x");',
      'request.log.error(error, "x");',
      'log.error({ err }, "x");',
      'log.error({ error, id }, "x");',
      'log.error({ err: result.reason, id }, "x");',
      'logger.warn({ id, cause: e }, "x");',
      "log.error({ id }, error.message);",
      'logger.error({ msg: err?.stack }, "x");',
      "log.error(`failed: ${err}`);",
      "log.error(`failed: ${error}`);",
      "log.error({ id }, `failed: ${err.message}`);",
      "log.error({ id }, `failed: ${String(err)}`);",
      "log.error({ id }, `failed: ${error?.message}`);",
      "log.warn({ id }, `a ${`b ${err.stack}`}`);",
      "logProblemOnce(logger, key, { detail }, error.message);",
      "logProblemOnce(logger, `config:${error.message}`, {}, 'x');",
      "log.warn({ id, detail: String(err) }, 'x');",
      'fastify.log.error(\n  { error: cleanupErr, clientId },\n  "x"\n);',
    ]) {
      expect(violations(bad), bad).not.toEqual([]);
    }
  });

  it("allows helper calls, identifiers and names that merely contain 'error'", () => {
    for (const ok of [
      'log.error(errorLogFields(err), "x");',
      'log.error({ ...errorLogFields(outcome.reason), id }, "x");',
      'log.error({ ...transportErrorFields(result.reason), id }, "x");',
      'log.error({ ...retryErrorFields(error), eventId }, "x");',
      'log.error(safeErrorFields(err), "Failed to verify error.message");',
      'logger.warn({ errorName: (error as Error)?.name }, "x");',
      'logger.error({ ...ids, errorCode: code, attempts }, "x");',
      'request.log.error({ clientId, stripeCode: (err as { code?: unknown })?.code }, "x");',
      'log.info({ token_id: record.id }, "Updating onboarding token status");',
      "log.error({ id }, `failed: ${err.code}`);",
      "log.error({ id }, `failed: ${errorName} ${error instanceof Foo ? error.status : 0}`);",
      "log.error({ id }, 'err.message is only text here');",
      'logProblemOnce(logger, `config:${error.code}`, { detail: error.detail }, "Misconfigured.");',
      "const error = new Error(`x`); throw error;",
    ]) {
      expect(violations(ok), ok).toEqual([]);
    }
  });
});
