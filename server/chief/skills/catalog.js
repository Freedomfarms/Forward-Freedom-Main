// Bundled CHIEF procedures. Loaded once from this package. There is no
// database registry and no per-user skill directory.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSkillDirectory } from "./loader.js";

const bundledDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "bundled");

export const bundledSkills = loadSkillDirectory(bundledDir);

export function skillByName(name, skills = bundledSkills) {
  return skills.find((skill) => skill.name === name) ?? null;
}
