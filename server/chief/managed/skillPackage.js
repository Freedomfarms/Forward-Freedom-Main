import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

import { ICM_ARCHITECT_PIN } from "./constants.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../third_party/icm-architect"
);

export function icmArchitectRoot() {
  return ROOT;
}

export function assertPinnedSkillTree() {
  const skill = fs.readFileSync(path.join(ROOT, "SKILL.md"), "utf8");
  const license = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  if (!skill.startsWith("---\nname: icm-architect\n")) {
    throw new Error("Vendored SKILL.md is not the pinned icm-architect skill.");
  }
  if (!license.includes("MIT License")) {
    throw new Error("Vendored ICM Architect LICENSE is missing.");
  }
  return {
    pin: ICM_ARCHITECT_PIN,
    skillSha256: crypto.createHash("sha256").update(skill).digest("hex"),
    bytes: Buffer.byteLength(skill),
  };
}

export async function buildIcmArchitectZip() {
  const pinned = assertPinnedSkillTree();
  const zip = new JSZip();
  for (const relative of walk(ROOT)) {
    if (relative === "VENDORED.md") continue;
    const absolute = path.join(ROOT, relative);
    zip.file(relative.split(path.sep).join("/"), fs.readFileSync(absolute));
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  return { ...pinned, bytes, filename: `icm-architect-${ICM_ARCHITECT_PIN}.zip` };
}

function walk(directory, prefix = "") {
  const entries = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const relative = prefix ? path.join(prefix, name) : name;
    const absolute = path.join(directory, name);
    if (fs.statSync(absolute).isDirectory()) entries.push(...walk(absolute, relative));
    else entries.push(relative);
  }
  return entries;
}
