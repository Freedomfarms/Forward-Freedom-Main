import { REQUIRED_WORKSPACE_PATHS } from "./constants.js";

export const TRANSCRIPT_LEAK_MARKER = "TRANSCRIPT_MARKER_DO_NOT_LEAK";

const READ_FILES =
  "Read the project files in the memory mount before you answer. The earlier transcript is not in this prompt.";

export function promptFor(phase) {
  switch (phase) {
    case "initial":
      return [
        "We are designing a goat hay feeder for a small herd.",
        "Constraints: keep the goats fed for two days without a refill, use materials we can repair on the farm, and do not assume a barn hoist.",
        "Use the pinned ICM Architect skill. Read its SKILL.md before organizing the workspace.",
        `Write these files and only the folders the work needs: ${REQUIRED_WORKSPACE_PATHS.join(", ")}.`,
        "Record the goal, the constraints, what we decided, what is still open, and the next step.",
        "When those files are saved, call proof_ping once.",
      ].join(" ");
    case "continue_same_store":
    case "confirm":
    case "recover":
      return `Continue the goat hay feeder project. What have we decided, and what do you need from me? ${READ_FILES}`;
    case "correct":
      return `Correct the requirements. The herd is 40 goats, replacing whatever herd size was written before. Update decisions.md so the correction is the current decision. Then call proof_ping once. ${READ_FILES}`;
    case "close":
      return "";
    default:
      return null;
  }
}

export function promptClassFor(phase) {
  return phase === "initial" ? "fresh" : "resumed";
}

export function accessFor(phase, { ownerCanResume, sameSession }) {
  if (phase === "recover" || phase === "initial" || phase === "correct") return "read_write";
  if (phase === "continue_same_store" || phase === "confirm") {
    if (ownerCanResume && !sameSession) return "read_only";
    return "read_write";
  }
  return "read_only";
}

export function assertPromptHasNoTranscript(prompt, transcriptText) {
  if (!prompt) return { ok: true };
  if (transcriptText && prompt.includes(transcriptText))
    return { ok: false, reason: "transcript_in_prompt" };
  if (prompt.includes(TRANSCRIPT_LEAK_MARKER)) return { ok: false, reason: "marker_in_prompt" };
  return { ok: true };
}
