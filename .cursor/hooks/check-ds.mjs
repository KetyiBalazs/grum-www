#!/usr/bin/env node
/**
 * Gruum design-system checker.
 *
 * CLI:  node .cursor/hooks/check-ds.mjs path/to/file.css
 * Hook: reads Cursor hook JSON on stdin, writes JSON on stdout.
 *
 * Fail-open: always exit 0 for hook mode so a crash does not block the agent.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SKIP_FILES = new Set(["tokens.css"]);

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_RE = new RegExp(String.raw`\brgba?\([^)]*\)`, "gi");
const HSL_RE = new RegExp(String.raw`\bhsla?\([^)]*\)`, "gi");
const VAR_DEF_RE = /(?:^|[\s{;])(--[a-z0-9-]+)\s*:/gi;
const NAMED_COLOR_RE =
  /(?<![\w-])(red|blue|navy|green|yellow|orange|purple|pink|black|gray|grey|silver|maroon|teal|olive|lime|aqua|fuchsia|white)(?![\w-])/gi;
const INVENTED_BUTTON_RE =
  /class\s*=\s*["'][^"']*\bbutton\b[^"']*["']/gi;

function rel(filePath) {
  return path.relative(ROOT, path.resolve(filePath)).replaceAll("\\", "/");
}

function shouldSkip(filePath, includeExamples = false) {
  const relative = rel(filePath);
  const base = path.basename(filePath);
  if (SKIP_FILES.has(base)) return true;
  if (!includeExamples && relative.startsWith(".cursor/hooks/examples/")) {
    return true;
  }
  return false;
}

function isUiFile(filePath) {
  return /\.(html?|css)$/i.test(filePath);
}

function blankKeepNewlines(block) {
  return block.replace(/[^\n]/g, " ");
}

function applyMask(source, regex, replacer) {
  return source.replace(regex, (match) => replacer(match));
}

function maskComments(source, filePath) {
  let text = applyMask(source, /\/\*[\s\S]*?\*\//g, blankKeepNewlines);
  if (/\.html?$/i.test(filePath)) {
    text = applyMask(text, /<!--[\s\S]*?-->/g, blankKeepNewlines);
    text = applyMask(
      text,
      /<meta[^>]*name=["']theme-color["'][^>]*>/gi,
      blankKeepNewlines
    );
  }
  return text;
}

function cssContext(source, filePath) {
  const text = maskComments(source, filePath);
  if (/\.css$/i.test(filePath)) return text;

  const chars = blankKeepNewlines(text).split("");
  const keep = (start, value) => {
    for (let i = 0; i < value.length; i += 1) chars[start + i] = value[i];
  };
  for (const match of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    keep(match.index + match[0].indexOf(match[1]), match[1]);
  }
  for (const match of text.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    keep(match.index + match[0].indexOf(match[2]), match[2]);
  }
  return chars.join("");
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function loadAllowedVars() {
  const tokensPath = path.join(ROOT, "tokens.css");
  const css = fs.readFileSync(tokensPath, "utf8");
  return new Set(
    [...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((m) => `--${m[1]}`)
  );
}

function scanSource(filePath, source) {
  const failures = [];
  const relative = rel(filePath);
  const css = cssContext(source, filePath);
  const markup = maskComments(source, filePath);
  const allowedVars = loadAllowedVars();

  const push = (kind, match, index) => {
    failures.push({
      file: relative,
      line: lineOf(source, index),
      kind,
      snippet: match.trim(),
    });
  };

  for (const match of css.matchAll(HEX_RE)) {
    push("raw hex color — use a token from tokens.css (var(--...))", match[0], match.index);
  }
  for (const match of css.matchAll(RGB_RE)) {
    push("raw rgb() — use a token from tokens.css", match[0], match.index);
  }
  for (const match of css.matchAll(HSL_RE)) {
    push("raw hsl() — use a token from tokens.css", match[0], match.index);
  }
  for (const match of css.matchAll(NAMED_COLOR_RE)) {
    push("named CSS color — use a token from tokens.css", match[1], match.index);
  }
  for (const match of css.matchAll(VAR_DEF_RE)) {
    const name = match[1];
    if (!allowedVars.has(name)) {
      push(
        "new CSS variable — add it to tokens.css from Figma first",
        name,
        match.index
      );
    }
  }
  if (/\.html?$/i.test(filePath)) {
    for (const match of markup.matchAll(INVENTED_BUTTON_RE)) {
      if (/\bbtn\b/.test(match[0])) continue;
      push(
        "invented button class — use .btn / .btn-primary / .btn-secondary / .btn-white / .btn-tertiary",
        match[0],
        match.index
      );
    }
  }

  return failures;
}

function scanFile(filePath, includeExamples = false) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || shouldSkip(resolved, includeExamples) || !isUiFile(resolved)) {
    return [];
  }
  return scanSource(resolved, fs.readFileSync(resolved, "utf8"));
}

function formatReport(failures) {
  if (!failures.length) {
    return "PASS: Gruum design-system check — no raw colors or invented button classes.";
  }
  const lines = [
    "FAIL: Gruum design-system check. Fix these before finishing:",
    ...failures.slice(0, 20).map(
      (item) =>
        `- ${item.file}:${item.line}  ${item.kind}  (${item.snippet})`
    ),
  ];
  if (failures.length > 20) {
    lines.push(`- …and ${failures.length - 20} more`);
  }
  lines.push(
    "Use tokens.css variables and existing components (.btn, .chip, .headline-main, …). See .cursor/hooks/examples/bad-button.css for a failing sample."
  );
  return lines.join("\n");
}

function collectPathsFromPayload(payload) {
  const found = new Set();
  const visit = (value, key) => {
    if (!value) return;
    if (typeof value === "string") {
      if (
        isUiFile(value) &&
        !value.includes("\n") &&
        /path|file|uri/i.test(key || "path")
      ) {
        found.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }
    if (typeof value === "object") {
      for (const [nextKey, nextValue] of Object.entries(value)) {
        visit(nextValue, nextKey);
      }
    }
  };
  visit(payload, "");
  return [...found];
}

function changedUiFiles() {
  try {
    const names = execFileSync(
      "git",
      ["status", "--porcelain", "-u", "--", "*.html", "*.css"],
      { cwd: ROOT, encoding: "utf8" }
    )
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    return names.filter((name) => isUiFile(name) && !shouldSkip(path.join(ROOT, name)));
  } catch {
    return [];
  }
}

function hookEventName(payload) {
  return String(
    payload.hook_event_name || payload.event_name || payload.event || ""
  );
}

function respond(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function runCli(files) {
  const failures = files.flatMap((file) => scanFile(file, true));
  process.stdout.write(`${formatReport(failures)}\n`);
  process.exitCode = failures.length ? 1 : 0;
}

function runPostToolUse(payload) {
  const paths = collectPathsFromPayload(payload);
  const failures = paths.flatMap(scanFile);
  if (!failures.length) {
    respond({});
    return;
  }
  respond({ additional_context: formatReport(failures) });
}

function runStop(payload) {
  const status = payload.status || payload.stop_status;
  if (status === "aborted" || status === "error") {
    respond({});
    return;
  }
  const files = changedUiFiles();
  const failures = files.flatMap(scanFile);
  if (!failures.length) {
    respond({});
    return;
  }
  respond({
    followup_message: `${formatReport(failures)}\nFix every FAIL, then stop. Do not invent new colors or components.`,
  });
}

const EXAMPLE_FILES = [
  ".cursor/hooks/examples/bad-button.css",
  ".cursor/hooks/examples/bad-button.html",
];

function runHook() {
  let payload = {};
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw) payload = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`check-ds: invalid stdin JSON (${error.message})\n`);
    respond({});
    return;
  }

  const event = hookEventName(payload);
  process.stderr.write(`check-ds: event=${event || "unknown"}\n`);

  if (event === "stop") {
    runStop(payload);
  } else {
    runPostToolUse(payload);
  }
}

const argv = process.argv.slice(2);
const cliFiles = argv.filter((arg) => !arg.startsWith("--"));
const wantExamples = argv.includes("--examples");
if (cliFiles.length) {
  runCli(cliFiles);
} else if (wantExamples || process.stdin.isTTY) {
  if (!wantExamples) {
    process.stdout.write(
      "No files given — scanning the FAIL example. Pass HTML/CSS paths, or pipe hook JSON on stdin.\n\n"
    );
  }
  runCli(EXAMPLE_FILES);
} else {
  try {
    runHook();
  } catch (error) {
    process.stderr.write(`check-ds: hook error (${error.message})\n`);
    respond({});
  }
}
