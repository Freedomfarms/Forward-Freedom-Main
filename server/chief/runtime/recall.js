// Conversation recall over ChiefSession.recallDocument.
//
// The checkpoint transcript stays the source of truth and stays encrypted.
// recallDocument is a capped, redacted projection so search can use Postgres
// full text without decrypting journals. Hermes session_search is the idea
// of metadata plus a derived text field. The Hermes database, FTS5, and
// channels are not used. möbius search_history and read_history are not
// registered.

import { countTokens } from "../context/inject.js";
import { resolveUserTimeZone } from "../../platform/timezone.js";
import { fencesOutput, scanInjection } from "../security/injection.js";
import { compactedSummary, isCompactedMessage } from "./compaction.js";

export const RECALL_DOCUMENT_MAX = 2_000;
export const RECALL_SNIPPET_MAX = 240;
export const RECALL_SEARCH_LIMIT = 5;
export const RECALL_LIST_LIMIT = 20;
export const RECALL_OFFSET_MAX = 20;
export const RECALL_CATCH_UP_LIMIT = 20;
export const RECALL_RETRIEVE_TOKENS = 1_200;
export const RECALL_SUMMARY_TOKENS = 600;
export const RECALL_LEXICAL_WEIGHT = 10;
export const RECALL_TITLE_BOOST = 0.5;
export const RECALL_RECENCY_MAX = 0.15;
export const RECALL_RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
export const CONVERSATION_RECALL_TOOLS = Object.freeze([
  "conversation_search",
  "conversation_retrieve",
]);

const HISTORICAL_HEADER = "HISTORICAL CONVERSATION";

function collapseSpaces(value) {
  return String(value ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

export function redactSensitiveSpans(value) {
  let text = String(value ?? "");
  text = text.replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, " ");
  text = text.replace(
    /\b(?:password|passphrase|secret|token|api[\s_-]*key|credential)s?\b\s*[:=]?\s*\S+/gi,
    " "
  );
  text = text.replace(
    /\b(?:ending|account\s*(?:number|#|no\.?)|routing|acct)\b[^.]{0,40}\d{2,}/gi,
    " "
  );
  text = text.replace(/\b\d{5,}\b/g, " ");
  text = text.replace(/\b\d{4}\b/g, (digits) => (/^(?:19|20)\d{2}$/.test(digits) ? digits : " "));
  return collapseSpaces(text);
}

export function tokenize(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function uniqueTokens(value) {
  return [...new Set(tokenize(value))];
}

// AND match, same shape as plainto_tsquery('simple'). Score is the share of
// document tokens that are query terms, so a dense match outranks a mention.
export function lexicalRank(query, document) {
  const terms = uniqueTokens(query);
  const tokens = tokenize(document);
  if (!terms.length || !tokens.length) return 0;
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  let hits = 0;
  for (const term of terms) {
    const count = counts.get(term) ?? 0;
    if (!count) return 0;
    hits += count;
  }
  return hits / tokens.length;
}

export function recallScore({ lexical, titleMatch, ageMs, useRecency }) {
  const age = Math.max(0, Number(ageMs) || 0);
  const recency = useRecency
    ? RECALL_RECENCY_MAX * Math.exp((-Math.LN2 * age) / RECALL_RECENCY_HALF_LIFE_MS)
    : 0;
  return lexical * RECALL_LEXICAL_WEIGHT + (titleMatch ? RECALL_TITLE_BOOST : 0) + recency;
}

function proseText(message) {
  if (message?.role !== "user" && message?.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type !== "tool-call" && part?.type !== "tool-result")
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isHistoricalEcho(text) {
  return String(text ?? "").includes(HISTORICAL_HEADER);
}

function firstUserText(transcript) {
  for (const message of transcript ?? []) {
    if (message?.role !== "user" || isCompactedMessage(message)) continue;
    const text = proseText(message);
    if (text && !isHistoricalEcho(text)) return text;
  }
  return "";
}

function summaryText(transcript) {
  for (const message of transcript ?? []) {
    const summary = compactedSummary(message);
    if (summary && !isHistoricalEcho(summary)) return summary;
  }
  return "";
}

function proseLines(transcript) {
  const lines = [];
  for (const message of transcript ?? []) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    if (isCompactedMessage(message)) continue;
    const text = redactSensitiveSpans(proseText(message));
    if (!text || isHistoricalEcho(text)) continue;
    lines.push(text);
  }
  return lines;
}

function tailWithin(lines, room) {
  if (room <= 0) return "";
  const kept = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const separator = kept.length ? 1 : 0;
    if (used + separator + line.length <= room) {
      kept.push(line);
      used += separator + line.length;
      continue;
    }
    const sliceRoom = room - used - separator;
    if (sliceRoom > 0) kept.push(line.slice(line.length - sliceRoom).trim());
    break;
  }
  kept.reverse();
  return kept.join("\n");
}

export function buildRecallDocument({ title, transcript } = {}) {
  const safeTitle = redactSensitiveSpans(title ?? "");
  const first = redactSensitiveSpans(firstUserText(transcript));
  const summary = redactSensitiveSpans(summaryText(transcript));
  const head = [safeTitle, first, summary].filter(Boolean).join("\n");
  const recentLines = proseLines(transcript).filter((line) => line !== first);
  const room = RECALL_DOCUMENT_MAX - head.length - (head && recentLines.length ? 1 : 0);
  const recent = tailWithin(recentLines, room);
  let document = [head, recent].filter(Boolean).join("\n").trim();
  if (document.length > RECALL_DOCUMENT_MAX) {
    document = document.slice(0, RECALL_DOCUMENT_MAX).trim();
  }
  return document;
}

export function recallSnippet(document, query, max = RECALL_SNIPPET_MAX) {
  const text = collapseSpaces(document).replace(/\n/g, " ");
  if (!text) return "";
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  let index = -1;
  for (const term of uniqueTokens(query)) {
    const found = lower.indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  const ellipsis = index > 40;
  const start = ellipsis ? Math.max(0, index - 40) : 0;
  const room = max - (ellipsis ? 1 : 0);
  const slice = text.slice(start, start + room).trim();
  const snippet = ellipsis ? `…${slice}` : slice;
  return snippet.length > max ? snippet.slice(0, max).trim() : snippet;
}

function wallClockParts(instant, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const bag = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let year = Number(bag.year);
  let month = Number(bag.month);
  let day = Number(bag.day);
  let hour = Number(bag.hour);
  const minute = Number(bag.minute);
  const second = Number(bag.second);
  if (hour === 24) {
    hour = 0;
    const next = addCalendarDays(year, month, day, 1);
    year = next.year;
    month = next.month;
    day = next.day;
  }
  return { year, month, day, hour, minute, second };
}

function addCalendarDays(year, month, day, delta) {
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + delta);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function isValidYmd(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function timeZoneOffsetMs(instant, timeZone) {
  const parts = wallClockParts(instant, timeZone);
  const millisecond = ((instant.getTime() % 1000) + 1000) % 1000;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    millisecond
  );
  return asUtc - instant.getTime();
}

function zonedDateTimeToUtc(year, month, day, hour, minute, second, millisecond, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  const firstOffset = timeZoneOffsetMs(guess, timeZone);
  let utc = new Date(guess.getTime() - firstOffset);
  const secondOffset = timeZoneOffsetMs(utc, timeZone);
  if (firstOffset !== secondOffset) utc = new Date(guess.getTime() - secondOffset);
  return utc;
}

function startOfLocalDay(year, month, day, timeZone) {
  return zonedDateTimeToUtc(year, month, day, 0, 0, 0, 0, timeZone);
}

function endOfLocalDay(year, month, day, timeZone) {
  const next = addCalendarDays(year, month, day, 1);
  return new Date(startOfLocalDay(next.year, next.month, next.day, timeZone).getTime() - 1);
}

function localToday(now, timeZone) {
  const parts = wallClockParts(now, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function dayWindow(year, month, day, timeZone) {
  return {
    start: startOfLocalDay(year, month, day, timeZone),
    end: endOfLocalDay(year, month, day, timeZone),
  };
}

function isoMonday(year, month, day) {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  return addCalendarDays(year, month, day, delta);
}

function monthWindow(year, month, timeZone) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: startOfLocalDay(year, month, 1, timeZone),
    end: endOfLocalDay(year, month, lastDay, timeZone),
  };
}

function shiftMonth(year, month, delta) {
  const utc = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1 };
}

function wholeDays(value) {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number > 36500) return null;
  return number;
}

function invalidDate(label) {
  return { error: `${label} is not a valid date` };
}

function parseAbsoluteOrCivil(text, label, timeZone) {
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return invalidDate(label);
    return { date };
  }
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!isValidYmd(year, month, day)) return invalidDate(label);
    return {
      date:
        label === "before"
          ? endOfLocalDay(year, month, day, timeZone)
          : startOfLocalDay(year, month, day, timeZone),
    };
  }
  const local = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
  );
  if (!local) return null;
  const year = Number(local[1]);
  const month = Number(local[2]);
  const day = Number(local[3]);
  const hour = Number(local[4]);
  const minute = Number(local[5]);
  const second = Number(local[6] ?? "0");
  const fraction = local[7] ?? "";
  const millisecond = fraction ? Number(fraction.padEnd(3, "0")) : 0;
  if (!isValidYmd(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    return invalidDate(label);
  }
  return {
    date: zonedDateTimeToUtc(year, month, day, hour, minute, second, millisecond, timeZone),
  };
}

function parseRelativeBound(text, label, { timeZone, now }) {
  const phrase = text
    .trim()
    .toLowerCase()
    .replace(/[.?!]+$/g, "")
    .replace(/\s+/g, " ");
  const today = localToday(now, timeZone);
  if (phrase === "today")
    return edge(dayWindow(today.year, today.month, today.day, timeZone), label);
  if (phrase === "yesterday") {
    const day = addCalendarDays(today.year, today.month, today.day, -1);
    return edge(dayWindow(day.year, day.month, day.day, timeZone), label);
  }
  if (phrase === "last week" || phrase === "this week") {
    const monday = isoMonday(today.year, today.month, today.day);
    const startDay =
      phrase === "last week" ? addCalendarDays(monday.year, monday.month, monday.day, -7) : monday;
    const endDay =
      phrase === "last week"
        ? addCalendarDays(monday.year, monday.month, monday.day, -1)
        : addCalendarDays(monday.year, monday.month, monday.day, 6);
    return edge(
      {
        start: startOfLocalDay(startDay.year, startDay.month, startDay.day, timeZone),
        end: endOfLocalDay(endDay.year, endDay.month, endDay.day, timeZone),
      },
      label
    );
  }
  if (phrase === "last month" || phrase === "this month") {
    const month = phrase === "last month" ? shiftMonth(today.year, today.month, -1) : today;
    return edge(monthWindow(month.year, month.month, timeZone), label);
  }
  const older = phrase.match(/^(?:older than|more than|over) (\d+) days?(?: ago| old)?$/);
  if (older) {
    const days = wholeDays(older[1]);
    if (days == null) return invalidDate(label);
    if (label !== "before") return invalidDate(label);
    const day = addCalendarDays(today.year, today.month, today.day, -days);
    const start = startOfLocalDay(day.year, day.month, day.day, timeZone);
    return { date: new Date(start.getTime() - 1) };
  }
  const ago = phrase.match(/^(\d+) days? ago$/);
  if (ago) {
    const days = wholeDays(ago[1]);
    if (days == null) return invalidDate(label);
    const day = addCalendarDays(today.year, today.month, today.day, -days);
    return edge(dayWindow(day.year, day.month, day.day, timeZone), label);
  }
  const recent = phrase.match(/^(?:last|past) (\d+) days?$/);
  if (recent) {
    const days = wholeDays(recent[1]);
    if (days == null || days < 1) return invalidDate(label);
    const startDay = addCalendarDays(today.year, today.month, today.day, -(days - 1));
    return edge(
      {
        start: startOfLocalDay(startDay.year, startDay.month, startDay.day, timeZone),
        end: endOfLocalDay(today.year, today.month, today.day, timeZone),
      },
      label
    );
  }
  return null;
}

function edge(range, label) {
  return { date: label === "before" ? range.end : range.start };
}

function parseDateBound(value, label, { timeZone, now }) {
  if (value == null || value === "") return { date: null };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return invalidDate(label);
    return { date: value };
  }
  if (typeof value === "number") {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return invalidDate(label);
    return { date };
  }
  if (typeof value !== "string") return invalidDate(label);
  const text = value.trim();
  if (!text) return { date: null };
  const absolute = parseAbsoluteOrCivil(text, label, timeZone);
  if (absolute) return absolute;
  const relative = parseRelativeBound(text, label, { timeZone, now });
  if (relative) return relative;
  return invalidDate(label);
}

function clampLimit(value, cap) {
  if (value == null || value === "") return cap;
  const number = Number(value);
  if (!Number.isFinite(number)) return cap;
  return Math.min(cap, Math.max(1, Math.floor(number)));
}

function clampOffset(value) {
  if (value == null || value === "") return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(RECALL_OFFSET_MAX, Math.floor(number));
}

export function parseSearchOptions(options = {}) {
  if (options.query != null && typeof options.query !== "string") {
    return { error: "query is required" };
  }
  const query = typeof options.query === "string" ? options.query.trim() : "";
  const list = query.length === 0;
  if (!list && uniqueTokens(query).length === 0) return { error: "query is required" };
  const timeZone = resolveUserTimeZone(options.timeZone ?? options.timezone);
  const now =
    options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date();
  const after = parseDateBound(options.after, "after", { timeZone, now });
  if (after.error) return after;
  const before = parseDateBound(options.before, "before", { timeZone, now });
  if (before.error) return before;
  if (after.date && before.date && after.date.getTime() > before.date.getTime()) {
    return { error: "after must be earlier than or equal to before" };
  }
  if (options.includeArchived != null && typeof options.includeArchived !== "boolean") {
    return { error: "include_archived must be a boolean" };
  }
  return {
    query,
    list,
    after: after.date,
    before: before.date,
    includeArchived: options.includeArchived !== false,
    limit: clampLimit(options.limit, list ? RECALL_LIST_LIMIT : RECALL_SEARCH_LIMIT),
    offset: clampOffset(options.offset),
    excludeSessionId:
      typeof options.excludeSessionId === "string" && options.excludeSessionId
        ? options.excludeSessionId
        : null,
    useRecency: !list && !after.date && !before.date,
  };
}

function isoTimestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function projectConversation(row, query) {
  return {
    session_id: row.id,
    sessionId: row.id,
    title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : null,
    createdAt: isoTimestamp(row.createdAt),
    updatedAt: isoTimestamp(row.updatedAt),
    archived: Boolean(row.archivedAt),
    snippet: recallSnippet(row.recallDocument, query),
  };
}

export function rankRecallRows(rows, parsed, now = new Date()) {
  const matched = [];
  for (const row of rows ?? []) {
    if (!row?.id) continue;
    if (row.origin === "schedule") continue;
    if (parsed.excludeSessionId && row.id === parsed.excludeSessionId) continue;
    if (!parsed.includeArchived && row.archivedAt) continue;
    const updated = new Date(row.updatedAt ?? 0);
    if (parsed.after && updated < parsed.after) continue;
    if (parsed.before && updated > parsed.before) continue;
    const list = parsed.list === true;
    const lexical = list ? 0 : lexicalRank(parsed.query, row.recallDocument ?? "");
    if (!list && lexical <= 0) continue;
    const titleMatch = list ? false : lexicalRank(parsed.query, row.title ?? "") > 0;
    const ageMs = Math.max(0, now.getTime() - updated.getTime());
    matched.push({
      row,
      score: recallScore({ lexical, titleMatch, ageMs, useRecency: parsed.useRecency }),
      updated: updated.getTime(),
    });
  }
  matched.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.updated !== right.updated) return right.updated - left.updated;
    if (left.row.id === right.row.id) return 0;
    return left.row.id < right.row.id ? -1 : 1;
  });
  return matched
    .slice(parsed.offset, parsed.offset + parsed.limit)
    .map((hit) => projectConversation(hit.row, parsed.query));
}

export async function catchUpRecallDocuments(store, userId, limit = RECALL_CATCH_UP_LIMIT) {
  if (!userId || typeof store?.listStaleRecallSessionIds !== "function") return 0;
  const ids = (await store.listStaleRecallSessionIds(userId, limit)).slice(0, limit);
  for (const id of ids) {
    const record = await store.load(userId, id);
    if (!record || record.checkpoint?.context?.origin === "schedule") continue;
    if (typeof store.setRecallDocument !== "function") continue;
    await store.setRecallDocument(userId, id, record.checkpoint?.transcript);
  }
  return ids.length;
}

function fenced(text) {
  return fencesOutput(scanInjection(text).threatLevel);
}

function takeTokens(text, budget) {
  const tokens = countTokens(text);
  if (tokens <= budget) return { text: String(text ?? "").trim(), tokens, truncated: false };
  const words = String(text ?? "")
    .trim()
    .split(/\s+/);
  const taken = words.slice(0, Math.max(0, budget)).join(" ");
  return { text: taken, tokens: countTokens(taken), truncated: true };
}

function messageMatches(text, query) {
  const terms = uniqueTokens(query).filter((term) => term.length > 2);
  if (!terms.length) return false;
  const haystack = text.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function formatDay(value) {
  const iso = isoTimestamp(value);
  return iso ? iso.slice(0, 10) : "";
}

export function buildHistoricalBlock({ record, query = "" } = {}) {
  const transcript = record?.checkpoint?.transcript ?? [];
  const summaryRaw = summaryText(transcript);
  const summary = summaryRaw && !fenced(summaryRaw) ? summaryRaw : "";
  const prose = [];
  for (const message of transcript) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    if (isCompactedMessage(message)) continue;
    const text = proseText(message);
    if (!text || fenced(text)) continue;
    prose.push({ role: message.role, text });
  }

  const archived = Boolean(record?.archivedAt);
  const title =
    typeof record?.title === "string" && record.title.trim() ? record.title.trim() : "Untitled";
  const header = [
    HISTORICAL_HEADER,
    `Title: ${title}`,
    `Updated: ${formatDay(record?.updatedAt)}`,
    `Archived: ${archived ? "yes" : "no"}`,
    "Relevant discussion:",
  ].join("\n");
  let budget = Math.max(0, RECALL_RETRIEVE_TOKENS - countTokens(header));
  let truncated = false;
  const parts = [];

  if (summary) {
    const cap = Math.min(RECALL_SUMMARY_TOKENS, budget);
    const taken = takeTokens(summary, cap);
    if (taken.text && budget > 0) {
      parts.push(taken.text);
      budget -= taken.tokens;
    }
    if (taken.truncated || countTokens(summary) > RECALL_SUMMARY_TOKENS) truncated = true;
  }

  const needle = typeof query === "string" ? query.trim() : "";
  const preferred = [];
  const rest = [];
  for (const message of prose) {
    if (needle && messageMatches(message.text, needle)) preferred.push(message);
    else rest.push(message);
  }

  const appendLines = (messages, { fromEnd = false } = {}) => {
    const source = fromEnd ? [...messages].reverse() : messages;
    const chosen = [];
    for (const message of source) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const line = `${message.role}: ${message.text}`;
      const tokens = countTokens(line);
      if (tokens > budget) {
        const taken = takeTokens(line, budget);
        if (taken.text) chosen.push(taken.text);
        budget = 0;
        truncated = true;
        break;
      }
      chosen.push(line);
      budget -= tokens;
    }
    if (chosen.length < source.length) truncated = true;
    return fromEnd ? chosen.reverse() : chosen;
  };

  parts.push(...appendLines(preferred));
  parts.push(...appendLines(rest, { fromEnd: true }));

  const historical = `${header}\n${parts.filter(Boolean).join("\n")}`.trimEnd();
  return {
    sessionId: record?.id ?? null,
    title: typeof record?.title === "string" && record.title.trim() ? record.title.trim() : null,
    updatedAt: isoTimestamp(record?.updatedAt),
    archived,
    truncated,
    historical,
  };
}

export async function retrieveOwnedConversation(store, userId, { sessionId, query } = {}) {
  if (!userId || typeof sessionId !== "string" || !sessionId.trim()) {
    return { error: "session not found" };
  }
  const record = await store.load(userId, sessionId.trim());
  if (!record?.id || !record.checkpoint) return { error: "session not found" };
  if (record.checkpoint.context?.origin === "schedule") return { error: "session not found" };
  return buildHistoricalBlock({ record, query });
}
