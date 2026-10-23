// The start route awaits only this acknowledgement. It does not call
// advanceRun. Claude's response and the rest of the experiment run in the
// separate supervisor process after the run id has been returned.

export async function acknowledgeDispatch(dispatch, runId) {
  if (!dispatch) return { accepted: false, reason: "dispatch_not_configured" };
  const result = await dispatch({ runId });
  if (result?.accepted) return { accepted: true, reason: null };
  return { accepted: false, reason: result?.reason || "dispatch_not_acknowledged" };
}
