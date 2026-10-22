import { PROOF_PHASES } from "./constants.js";
import { promptClassFor, promptFor } from "./scenario.js";

export async function queueProofRun(
  store,
  { userId, phase, projectId, priorRunId, title, now = new Date() }
) {
  if (!PROOF_PHASES.includes(phase)) {
    const error = new Error("phase is not part of the proof");
    error.status = 400;
    throw error;
  }
  let project = projectId ? await store.getProject(projectId) : null;
  if (phase === "initial") {
    if (project && project.userId !== userId) {
      const error = new Error("project not found");
      error.status = 404;
      throw error;
    }
    if (!project)
      project = await store.createProject({ userId, title: title || "Goat hay feeder", now });
  } else if (!project || project.userId !== userId) {
    const error = new Error("project not found");
    error.status = 404;
    throw error;
  }
  const run = await store.createRun({
    userId,
    projectId: project.id,
    priorRunId: priorRunId || null,
    phase,
    promptClass: promptClassFor(phase),
    prompt: promptFor(phase),
    createdAt: now,
    updatedAt: now,
  });
  await store.createJob({
    userId,
    runId: run.id,
    kind: phase,
    cursor: phase === "close" ? "close" : "setup",
    createdAt: now,
  });
  return { project, run };
}
