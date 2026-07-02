#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const ROOT = process.cwd();
const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434/api/chat";
const BATCH_SIZE = Number(process.env.COMMENT_TRANSLATE_BATCH || 8);
const DRY_RUN = process.argv.includes("--dry-run");
const COUNT_ONLY = process.argv.includes("--count");
const REPAIR_ONLY = process.argv.includes("--repair");
const DUMP_ONLY = process.argv.includes("--dump");
const PY_DOCSTRINGS = process.argv.includes("--py-docstrings");
const FILE_ARGS = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--"));

const TARGET_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".sh",
  ".yaml",
  ".yml",
  ".Dockerfile",
]);

const EXCLUDE_PARTS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "learning-doc",
  ".git",
  ".codegraph",
]);

function isTargetFile(file) {
  const parts = file.split(path.sep);
  if (parts.some((part) => EXCLUDE_PARTS.has(part))) return false;
  const base = path.basename(file);
  if (base === "Dockerfile" || base.startsWith("Dockerfile.")) return true;
  return TARGET_EXTS.has(path.extname(file));
}

function listFiles() {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf-8" })
    .split(/\r?\n/)
    .filter(Boolean);

  if (FILE_ARGS.length > 0) {
    const selected = new Set();
    for (const arg of FILE_ARGS) {
      const rel = path.relative(ROOT, path.resolve(ROOT, arg)).replaceAll(path.sep, "/");
      for (const file of tracked) {
        if (file === rel || file.startsWith(`${rel}/`)) {
          selected.add(file);
        }
      }
    }
    return [...selected].filter(isTargetFile);
  }

  return tracked.filter(isTargetFile);
}

function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(text);
}

function englishSignal(text) {
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  return letters >= 6;
}

function isChineseTranslationLine(line) {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("// 中文：") ||
    trimmed.startsWith("# 中文：") ||
    /^\/\*\*?\s*中文：/.test(trimmed) ||
    /^\*\s*中文：/.test(trimmed) ||
    trimmed.startsWith("中文：")
  );
}

function alreadyHasChineseAfter(lines, end) {
  for (let i = end + 1; i <= Math.min(lines.length - 1, end + 3); i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    return isChineseTranslationLine(lines[i]) || hasChinese(lines[i]);
  }
  return false;
}

function isCommentOnlyLine(line, marker) {
  const trimmed = line.trimStart();
  if (marker === "#") return trimmed.startsWith("#") && !trimmed.startsWith("#!");
  return trimmed.startsWith("//");
}

function findLineCommentIndex(line, marker) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (marker === "//") {
      const beforeMarker = line.slice(Math.max(0, i - 6), i);
      if (beforeMarker.endsWith("http:") || beforeMarker.endsWith("https:")) {
        continue;
      }
      if (line.startsWith("//", i)) return i;
      continue;
    }

    if (ch === "#") {
      const prev = i === 0 ? "" : line[i - 1];
      if (i === 0 || /\s/.test(prev)) return i;
    }
  }
  return -1;
}

function findInlineBlockComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      if (end >= 0) return { start: i, end: end + 2 };
      return null;
    }
  }
  return null;
}

function shouldSkipCommentText(text) {
  const normalized = text.trim();
  if (!normalized) return true;
  if (hasChinese(normalized)) return true;
  if (/^shellcheck\s+disable=/.test(normalized)) return true;
  if (!englishSignal(normalized)) return true;
  return false;
}

function stripLineComment(line, marker) {
  const idx = line.indexOf(marker);
  return idx >= 0 ? line.slice(idx + marker.length).trim() : line.trim();
}

function cleanBlockLine(line) {
  return line
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/^\s*\*\s?/, "")
    .trimEnd();
}

function normalizeCommentText(lines, kind) {
  const raw = kind === "block"
    ? lines.map(cleanBlockLine)
    : lines.map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//")) return stripLineComment(trimmed, "//");
      if (trimmed.startsWith("#")) return stripLineComment(trimmed, "#");
      return trimmed;
    });
  return raw
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^[=\-_*#/\s]+$/.test(line))
    .join("\n")
    .trim();
}

function detectBlocks(lines, ext) {
  const blocks = [];
  const lineMarker = ext === ".py" || ext === ".sh" || ext === ".yaml" || ext === ".yml" || ext === ".Dockerfile"
    ? "#"
    : "//";

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (isCommentOnlyLine(line, lineMarker)) {
      const start = i;
      const group = [];
      while (i < lines.length) {
        if (isCommentOnlyLine(lines[i], lineMarker)) {
          group.push(lines[i]);
          i++;
          continue;
        }
        break;
      }
      const text = normalizeCommentText(group, "line");
      if (!shouldSkipCommentText(text) && !alreadyHasChineseAfter(lines, i - 1)) {
        blocks.push({
          start,
          end: i - 1,
          kind: "line",
          marker: lineMarker,
          text,
        });
      }
      continue;
    }

    if (lineMarker === "//" && /^\s*\/\*/.test(line)) {
      const start = i;
      const group = [line];
      const singleLine = line.includes("*/");
      i++;
      while (!singleLine && i < lines.length) {
        group.push(lines[i]);
        if (lines[i].includes("*/")) {
          i++;
          break;
        }
        i++;
      }
      const end = start + group.length - 1;
      const text = normalizeCommentText(group, "block");
      if (!shouldSkipCommentText(text) && !alreadyHasChineseAfter(lines, end)) {
        blocks.push({
          start,
          end,
          kind: "block",
          singleLine,
          marker: "/*",
          text,
        });
      }
      continue;
    }

    const inlineIdx = findLineCommentIndex(line, lineMarker);
    if (inlineIdx > 0) {
      const before = line.slice(0, inlineIdx).trim();
      const text = line.slice(inlineIdx + lineMarker.length).trim();
      if (before && !shouldSkipCommentText(text) && !alreadyHasChineseAfter(lines, i)) {
        blocks.push({
          start: i,
          end: i,
          kind: "inline-line",
          marker: lineMarker,
          text,
        });
      }
    } else if (lineMarker === "//") {
      const inlineBlock = findInlineBlockComment(line);
      if (inlineBlock && inlineBlock.start > 0) {
        const before = line.slice(0, inlineBlock.start).trim();
        const text = normalizeCommentText([line.slice(inlineBlock.start, inlineBlock.end)], "block");
        if (before && !shouldSkipCommentText(text) && !alreadyHasChineseAfter(lines, i)) {
          blocks.push({
            start: i,
            end: i,
            kind: "inline-block",
            marker: "//",
            text,
          });
        }
      }
    }

    i++;
  }

  return blocks;
}

function previousSignificantLine(lines, index) {
  for (let i = index - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    return { index: i, line: lines[i], trimmed };
  }
  return null;
}

function isPythonDocstringStart(lines, index) {
  const trimmed = lines[index].trimStart();
  if (!trimmed.startsWith('"""') && !trimmed.startsWith("'''")) return false;
  if (index === 0) return true;
  const prev = previousSignificantLine(lines, index);
  if (!prev) return true;
  return /:\s*$/.test(prev.trimmed) && /\b(class|def)\b/.test(prev.trimmed);
}

function detectPythonDocstrings(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (!isPythonDocstringStart(lines, i)) {
      i++;
      continue;
    }
    const trimmed = lines[i].trimStart();
    const quote = trimmed.startsWith('"""') ? '"""' : "'''";
    const start = i;
    const group = [lines[i]];
    const firstRest = trimmed.slice(quote.length);
    const singleLine = firstRest.includes(quote);
    i++;
    while (!singleLine && i < lines.length) {
      group.push(lines[i]);
      if (lines[i].includes(quote)) {
        i++;
        break;
      }
      i++;
    }
    const end = start + group.length - 1;
    const content = normalizePythonDocstring(group, quote);
    if (!shouldSkipCommentText(content) && !alreadyHasChineseAfter(lines, end)) {
      blocks.push({
        start,
        end,
        kind: "py-docstring",
        marker: quote,
        singleLine,
        text: content,
      });
    }
  }
  return blocks;
}

function normalizePythonDocstring(lines, quote) {
  if (lines.length === 1) {
    return lines[0]
      .trim()
      .replace(new RegExp(`^${quote}`), "")
      .replace(new RegExp(`${quote}$`), "")
      .trim();
  }
  const body = [...lines];
  body[0] = body[0].slice(body[0].indexOf(quote) + quote.length);
  const lastIdx = body.length - 1;
  const closeIdx = body[lastIdx].lastIndexOf(quote);
  if (closeIdx >= 0) body[lastIdx] = body[lastIdx].slice(0, closeIdx);
  return body
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

async function translateBatch(items) {
  const prompt = [
    "Translate these code comments into Simplified Chinese.",
    "Return ONLY valid JSON with shape {\"translations\":[\"...\"]}.",
    "Keep identifiers, file paths, API names, numbers, hook names, and code tokens unchanged.",
    "Do not add explanations. Keep each translation concise but complete.",
    "Input comments:",
    JSON.stringify(items.map((item) => item.text), null, 2),
  ].join("\n");

  const body = JSON.stringify({
    model: MODEL,
    stream: false,
    format: "json",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    options: {
      temperature: 0,
    },
  });

  const content = await new Promise((resolve, reject) => {
    const req = http.request(OLLAMA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Ollama HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.message?.content ?? parsed.response ?? "");
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  const parsed = JSON.parse(String(content));
  if (!Array.isArray(parsed.translations)) {
    throw new Error(`Invalid translation payload: ${content}`);
  }
  return parsed.translations.slice(0, items.length).map((text) => String(text).trim());
}

async function translateItems(items) {
  if (items.length === 0) return [];
  try {
    const translations = await translateBatch(items);
    if (translations.length === items.length) return translations;
    throw new Error(`Expected ${items.length} translations, got ${translations.length}`);
  } catch (err) {
    if (items.length === 1) {
      throw err;
    }
    const midpoint = Math.ceil(items.length / 2);
    const left = await translateItems(items.slice(0, midpoint));
    const right = await translateItems(items.slice(midpoint));
    return [...left, ...right];
  }
}

function formatChineseLines(block, translation, originalLine) {
  const indent = originalLine.match(/^\s*/)?.[0] ?? "";
  const lines = translation
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/^\/\/\s*/, ""))
    .filter(Boolean);
  if (lines.length === 0) return [];

  if (block.kind === "py-docstring") {
    if (lines.length === 1) {
      return [`${indent}中文：${lines[0]}`];
    }
    return [
      `${indent}中文：${lines[0]}`,
      ...lines.slice(1).map((line) => `${indent}${line}`),
    ];
  }

  if (block.kind === "block") {
    if (block.singleLine) {
      if (lines.length === 1) {
        return [`${indent}/** 中文：${lines[0]} */`];
      }
      return [
        `${indent}/**`,
        ...lines.map((line, idx) => `${indent} * ${idx === 0 ? "中文：" : ""}${line}`),
        `${indent} */`,
      ];
    }
    return lines.map((line, idx) => `${indent} * ${idx === 0 ? "中文：" : ""}${line}`);
  }

  return lines.map((line, idx) => `${indent}${block.marker} ${idx === 0 ? "中文：" : ""}${line}`);
}

function formatSingleLinePythonDocstring(originalLine, translation) {
  const indent = originalLine.match(/^\s*/)?.[0] ?? "";
  const trimmed = originalLine.trim();
  const quote = trimmed.startsWith('"""') ? '"""' : "'''";
  const body = trimmed.slice(quote.length, trimmed.length - quote.length).trim();
  const translatedLines = translation
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return [
    `${indent}${quote}${body}`,
    "",
    ...translatedLines.map((line, idx) => `${indent}${idx === 0 ? "中文：" : ""}${line}`),
    `${indent}${quote}`,
  ];
}

function repairBareChineseJSDoc(lines) {
  const out = [...lines];
  let inBlock = false;

  for (let i = 0; i < out.length; i++) {
    let line = out[i];
    line = line.replace(/中文：\/\/\s*/g, "中文：");
    out[i] = line;
    const trimmed = line.trimStart();

    if (!inBlock && /^\*\s*中文：/.test(trimmed)) {
      const prev = out[i - 1] ?? "";
      const prevIndent = prev.match(/^(\s*)\/\*/)?.[1];
      const fallbackIndent = line.match(/^(\s*)\*/)?.[1] ?? "";
      const indent = prevIndent ?? fallbackIndent.replace(/\s$/, "");
      const content = trimmed.replace(/^\*\s*/, "").trim();
      out[i] = `${indent}/** ${content} */`;
    }

    const startsBlock = /\/\*/.test(line);
    const endsBlock = /\*\//.test(line);
    if (!inBlock && startsBlock && !endsBlock) {
      inBlock = true;
    } else if (inBlock && endsBlock) {
      inBlock = false;
    }
  }

  return out;
}

function repairBareChinesePythonDocstrings(lines) {
  const out = [...lines];
  for (let i = 0; i < out.length - 1; i++) {
    const line = out[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith("中文：")) continue;

    const next = out[i + 1];
    const nextTrimmed = next.trim();
    const quote = nextTrimmed.startsWith('"""') ? '"""' : nextTrimmed.startsWith("'''") ? "'''" : null;
    if (!quote || !nextTrimmed.endsWith(quote) || nextTrimmed.length <= quote.length * 2) {
      continue;
    }

    const indent = next.match(/^\s*/)?.[0] ?? "";
    const english = nextTrimmed.slice(quote.length, nextTrimmed.length - quote.length).trim();
    out.splice(
      i,
      2,
      `${indent}${quote}${english}`,
      "",
      `${indent}${trimmed}`,
      `${indent}${quote}`,
    );
    i += 3;
  }
  return out;
}

function applyTranslations(lines, blocks, translations) {
  const out = [...lines];
  for (let idx = blocks.length - 1; idx >= 0; idx--) {
    const block = blocks[idx];
    const translated = translations[idx];
    const chineseLines = formatChineseLines(block, translated, lines[block.start]);
    if (chineseLines.length === 0) continue;

    if (block.kind === "py-docstring") {
      if (block.singleLine) {
        out.splice(block.start, 1, ...formatSingleLinePythonDocstring(lines[block.start], translated));
      } else {
        out.splice(block.end, 0, ...chineseLines);
      }
    } else if (block.kind === "block" && block.end > block.start) {
      out.splice(block.end, 0, ...chineseLines);
    } else {
      out.splice(block.end + 1, 0, ...chineseLines);
    }
  }
  return out;
}

async function processFile(file) {
  const abs = path.join(ROOT, file);
  const text = await fs.readFile(abs, "utf-8");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const hasFinalNewline = text.endsWith("\n");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (hasFinalNewline) lines.pop();

  const base = path.basename(file);
  const ext = base === "Dockerfile" || base.startsWith("Dockerfile.") ? ".Dockerfile" : path.extname(file);
  if (REPAIR_ONLY) {
    const repairedLines = ext === ".py"
      ? repairBareChinesePythonDocstrings(repairBareChineseJSDoc(lines))
      : repairBareChineseJSDoc(lines);
    const repaired = repairedLines.join(newline) + (hasFinalNewline ? newline : "");
    if (repaired !== text) {
      await fs.writeFile(abs, repaired, "utf-8");
      return { file, blocks: 0, changed: true };
    }
    return { file, blocks: 0, changed: false };
  }

  const blocks = PY_DOCSTRINGS && ext === ".py"
    ? detectPythonDocstrings(lines)
    : detectBlocks(lines, ext);
  if (DUMP_ONLY) {
    for (const block of blocks) {
      console.log(`${file}:${block.start + 1}-${block.end + 1}\n${block.text}\n---`);
    }
    return { file, blocks: blocks.length, changed: false };
  }
  if (COUNT_ONLY || DRY_RUN) {
    return { file, blocks: blocks.length, changed: false };
  }
  if (blocks.length === 0) {
    return { file, blocks: 0, changed: false };
  }

  const translations = [];
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    const result = await translateItems(batch);
    translations.push(...result);
  }

  const updatedLines = applyTranslations(lines, blocks, translations);
  const updated = updatedLines.join(newline) + (hasFinalNewline ? newline : "");
  if (updated !== text) {
    await fs.writeFile(abs, updated, "utf-8");
    return { file, blocks: blocks.length, changed: true };
  }
  return { file, blocks: blocks.length, changed: false };
}

async function main() {
  const files = listFiles();
  let totalBlocks = 0;
  let changedFiles = 0;
  for (const file of files) {
    const result = await processFile(file);
    totalBlocks += result.blocks;
    if (result.changed) changedFiles++;
    if (result.blocks > 0) {
      const action = COUNT_ONLY ? "count" : DUMP_ONLY ? "dump" : DRY_RUN ? "dry" : result.changed ? "changed" : "skip";
      console.log(`${action}\t${result.blocks}\t${file}`);
    }
  }
  console.log(`summary\tfiles=${files.length}\tcommentBlocks=${totalBlocks}\tchangedFiles=${changedFiles}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
