// CHIEF bundled skill documents.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Source files: src/openjarvis/skills/types.py (SkillManifest fields),
//     src/openjarvis/skills/parser.py (strict name/description limits),
//     src/openjarvis/skills/loader.py (load_skill_markdown, discover_skills)
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//
// And of Hermes Agent (MIT)
//   Upstream: https://github.com/NousResearch/hermes-agent
//   Source files: tools/skill_manager_tool.py (_validate_frontmatter,
//     _validate_content_size), tools/skills_tool.py (SKILL.md is the document)
//   Commit: 8c30ef318d1ed6c88597239081f5749268efdca8
//
// Preserved:
//   - a skill is SKILL.md: YAML frontmatter plus a markdown body
//   - name is lowercase, 1-64 characters, alphanumerics and single hyphens
//   - description is a string of 1-1024 characters
//   - the body after the closing fence is required
//   - the whole file is capped at 100_000 characters
// Adaptations:
//   - The frontmatter subset is name, description, requires_tools, and
//     required_capabilities. OpenJarvis keeps unknown fields. CHIEF rejects
//     them, so a document cannot declare steps or an executor.
//   - The parser accepts only scalars and hyphen lists. It is not a YAML
//     implementation and does not load anchors or tags.
//   - Hermes warns and still loads a scanned file. CHIEF throws. A fenced
//     body or description never enters the catalog.
//   - There is no SkillStep, no on-disk hub, and no per-user skill store.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { isCapability } from "../core/capabilities.js";
import { fencesOutput, scanInjection } from "../security/injection.js";

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_CONTENT_CHARS = 100_000;

const ALLOWED_FIELDS = new Set(["name", "description", "requires_tools", "required_capabilities"]);

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

export class SkillParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "SkillParseError";
  }
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFrontmatterSubset(block) {
  const fields = {};
  const lines = block.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      throw new SkillParseError(`invalid frontmatter line: ${line.trim()}`);
    }
    const key = match[1];
    if (Object.hasOwn(fields, key)) {
      throw new SkillParseError(`duplicate frontmatter field '${key}'`);
    }
    if (!ALLOWED_FIELDS.has(key)) {
      throw new SkillParseError(`frontmatter field '${key}' is not allowed`);
    }
    const rest = match[2].trim();
    if (rest === "") {
      const items = [];
      index += 1;
      while (index < lines.length && /^\s+-\s+\S/.test(lines[index])) {
        items.push(unquote(lines[index].replace(/^\s+-\s+/, "").trim()));
        index += 1;
      }
      if (index < lines.length && /^\s+-\s*$/.test(lines[index])) {
        throw new SkillParseError(`frontmatter field '${key}' has an empty list item`);
      }
      fields[key] = items;
      continue;
    }
    fields[key] = unquote(rest);
    index += 1;
  }
  return fields;
}

function validateName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new SkillParseError(`field 'name' must be 1-${MAX_NAME_LENGTH} characters`);
  }
  if (name !== name.toLowerCase()) {
    throw new SkillParseError(`skill name '${name}' must be lowercase`);
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    throw new SkillParseError(`skill name '${name}' must not start or end with a hyphen`);
  }
  if (name.includes("--")) {
    throw new SkillParseError(`skill name '${name}' must not contain consecutive hyphens`);
  }
  for (const char of name) {
    const code = char.charCodeAt(0);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 122;
    if (!digit && !lower && char !== "-") {
      throw new SkillParseError(`skill name '${name}' contains invalid character '${char}'`);
    }
  }
}

function stringList(value, field, validateItem) {
  if (!Array.isArray(value)) {
    throw new SkillParseError(`frontmatter field '${field}' must be a list`);
  }
  const items = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new SkillParseError(`frontmatter field '${field}' must list strings`);
    }
    validateItem(item);
    items.push(item);
  }
  return items;
}

function refuseFenced(text, label) {
  const scan = scanInjection(text);
  if (fencesOutput(scan.threatLevel)) {
    throw new SkillParseError(`${label} failed the injection scan`);
  }
}

export function parseSkillMarkdown(raw, { source = "SKILL.md" } = {}) {
  if (typeof raw !== "string") {
    throw new SkillParseError(`${source} must be text`);
  }
  const content = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    throw new SkillParseError(
      `${source} is ${content.length} characters (limit ${MAX_SKILL_CONTENT_CHARS})`
    );
  }
  if (!content.startsWith("---\n") && content !== "---") {
    throw new SkillParseError(`${source} must start with YAML frontmatter (---)`);
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    throw new SkillParseError(`${source} frontmatter is not closed`);
  }
  const after = content.slice(end + 4);
  if (after.length > 0 && !after.startsWith("\n")) {
    throw new SkillParseError(`${source} frontmatter is not closed`);
  }
  const body = after.replace(/^\n/, "");
  if (!body.trim()) {
    throw new SkillParseError(`${source} must have content after the frontmatter`);
  }
  let fields;
  try {
    fields = parseFrontmatterSubset(content.slice(4, end));
  } catch (error) {
    if (error instanceof SkillParseError) throw error;
    throw new SkillParseError(`${source} frontmatter could not be parsed`);
  }
  if (typeof fields.name !== "string") {
    throw new SkillParseError("frontmatter must include 'name'");
  }
  if (typeof fields.description !== "string") {
    throw new SkillParseError("frontmatter must include 'description'");
  }
  validateName(fields.name);
  if (fields.description.length === 0 || fields.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new SkillParseError(`field 'description' must be 1-${MAX_DESCRIPTION_LENGTH} characters`);
  }
  const requiresTools = stringList(fields.requires_tools ?? [], "requires_tools", (item) => {
    if (!TOOL_NAME.test(item)) {
      throw new SkillParseError(`requires_tools entry '${item}' is not a tool name`);
    }
  });
  const requiredCapabilities = stringList(
    fields.required_capabilities ?? [],
    "required_capabilities",
    (item) => {
      if (!isCapability(item)) {
        throw new SkillParseError(`required_capabilities entry '${item}' is not a capability`);
      }
    }
  );
  refuseFenced(fields.description, "skill description");
  refuseFenced(body, "skill body");
  return Object.freeze({
    name: fields.name,
    description: fields.description,
    requiresTools: Object.freeze(requiresTools),
    requiredCapabilities: Object.freeze(requiredCapabilities),
    markdownContent: body,
  });
}

function walkSkillFiles(directory, root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new SkillParseError(`skill directory refuses symlinks (${entry.name})`);
    }
    const full = path.join(directory, entry.name);
    const resolved = path.resolve(full);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new SkillParseError(`skill path escapes the skill directory (${entry.name})`);
    }
    if (entry.isDirectory()) {
      files.push(...walkSkillFiles(full, root));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(resolved);
    }
  }
  return files;
}

export function loadSkillDirectory(directory) {
  const root = path.resolve(directory);
  let info;
  try {
    info = statSync(root);
  } catch {
    throw new SkillParseError(`skill directory not found: ${directory}`);
  }
  if (!info.isDirectory()) {
    throw new SkillParseError(`skill directory not found: ${directory}`);
  }
  const skills = [];
  const seen = new Set();
  for (const file of walkSkillFiles(root, root).sort()) {
    const skill = parseSkillMarkdown(readFileSync(file, "utf8"), { source: file });
    if (seen.has(skill.name)) {
      throw new SkillParseError(`duplicate skill name '${skill.name}'`);
    }
    seen.add(skill.name);
    skills.push(skill);
  }
  return Object.freeze(skills);
}
