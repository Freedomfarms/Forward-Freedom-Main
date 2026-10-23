// proof_ping is at-least-once delivery of an idempotent insert.
// The row is inserted before the provider result is posted. The tool call
// becomes completed only after that post succeeds. A crash between the two
// retries the post and does not insert a second row.

export async function deliverProofPing({ toolEventId, runId, userId, store, postResult, now }) {
  const ping = await store.insertPing({ toolEventId, runId, userId, now });
  const tool = await store.getToolCall(toolEventId);
  if (tool?.status === "completed") {
    return { ping: ping.row, posted: false, completed: true, created: ping.created };
  }
  await store.saveToolCall({
    ...(tool || {}),
    userId,
    runId,
    providerToolEventId: toolEventId,
    name: "proof_ping",
    status: "running",
    result: { pingId: ping.row.id, created: ping.created },
  });
  const posted = await postResult({ pingId: ping.row.id, toolEventId });
  if (!posted?.ok) {
    return {
      ping: ping.row,
      posted: false,
      completed: false,
      created: ping.created,
      error: posted?.error || "post_failed",
    };
  }
  await store.saveToolCall({
    userId,
    runId,
    providerToolEventId: toolEventId,
    name: "proof_ping",
    status: "completed",
    result: { pingId: ping.row.id, created: ping.created },
    postedAt: now,
    completedAt: now,
  });
  return { ping: ping.row, posted: true, completed: true, created: ping.created };
}
