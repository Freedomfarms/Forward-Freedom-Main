// Setup can succeed at the provider and still fail before the id is stored.
// A retry lists by our idempotency key and adopts one match. Zero matches
// means the create did not land. More than one match, or a failed list,
// stops in needs_reconciliation and does not create another resource.
// This does not claim the provider is exactly-once.

export async function ensureResource({ store, spec, list, create, retrieve, now }) {
  let record = await store.getResource(spec.idempotencyKey);
  if (record?.status === "ready" && record.providerId) {
    const found = await retrieve(record.providerId).catch(() => null);
    if (found) return { resource: record, created: false, blocked: false };
    record.status = "needs_reconciliation";
    record.detail = "stored_id_missing_at_provider";
    await store.saveResource(record);
    return { resource: record, created: false, blocked: true };
  }
  if (record?.status === "needs_reconciliation") {
    return { resource: record, created: false, blocked: true };
  }
  if (!record) {
    record = {
      id: spec.id,
      userId: spec.userId || null,
      projectId: spec.projectId || null,
      kind: spec.kind,
      idempotencyKey: spec.idempotencyKey,
      providerId: null,
      version: null,
      status: "creating",
      fingerprint: spec.fingerprint,
      detail: null,
      createdAt: now,
    };
    await store.saveResource(record);
  }

  let listed;
  try {
    listed = await list();
  } catch {
    record.status = "needs_reconciliation";
    record.detail = "list_failed";
    await store.saveResource(record);
    return { resource: record, created: false, blocked: true };
  }
  const decision = classifyResourceList(listed, spec);
  if (decision.action === "reconcile") {
    record.status = "needs_reconciliation";
    record.detail = decision.detail;
    await store.saveResource(record);
    return { resource: record, created: false, blocked: true };
  }
  if (decision.action === "adopt") {
    record.status = "ready";
    record.providerId = decision.match.id;
    record.version = decision.match.version || null;
    record.detail = "adopted";
    await store.saveResource(record);
    return { resource: record, created: false, adopted: true, blocked: false };
  }

  const created = await create();
  if (!created?.id) {
    record.status = "needs_reconciliation";
    record.detail = "create_returned_no_id";
    await store.saveResource(record);
    return { resource: record, created: false, blocked: true };
  }
  record.status = "ready";
  record.providerId = created.id;
  record.version = created.version || created.latest_version || null;
  record.detail = null;
  await store.saveResource(record);
  return { resource: record, created: true, blocked: false };
}

export function classifyResourceList(items, spec) {
  const list = items || [];
  const matches = list.filter((item) => spec.matches(item));
  if (matches.length > 1) return { action: "reconcile", detail: "multiple_matches" };
  if (matches.length === 1) return { action: "adopt", match: matches[0] };
  if (list.length === 0) return { action: "create" };
  if (list.some((item) => !spec.identifiable(item))) {
    return { action: "reconcile", detail: "unidentified_existing_resources" };
  }
  return { action: "create" };
}

export function metadataMatch(key) {
  return (item) =>
    item?.metadata?.freedom_os_key === key || item?.name === key || item?.display_title === key;
}

export function hasIdentity(item) {
  return Boolean(item?.metadata?.freedom_os_key || item?.name || item?.display_title);
}
