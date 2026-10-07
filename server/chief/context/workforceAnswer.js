// Selects observed workforce facts for the question that was asked.
// The runtime picture stays provider-neutral. This module only reads the
// lines the context reader already produced. It does not grant a write.

const ASKS = [
  [
    "attention",
    /\b(?:needs?(?: my| your)? attention|which one needs(?: me)?|who needs(?: me)?|needs me)\b/i,
  ],
  ["concern", /\b(?:should i be concerned|be concerned)\b/i],
  ["stuck", /\bstuck\b/i],
  ["problem", /\b(?:problem|fail(?:ed|ure)?|error)\b/i],
  ["gaps", /\b(?:don'?t we know|do we not know|what(?:'s| is) unknown|missing telemetry)\b/i],
  ["finding", /\bfind(?:ing)?\b/i],
  ["finish", /\b(?:did (?:it|they|that) (?:finish|complete)|accomplish(?:ed)?|is it done)\b/i],
  ["idle", /\bidle\b/i],
  ["changed", /\b(?:what(?:'s| is| has) changed|anything new)\b/i],
  ["happened", /\bwhat happened\b/i],
  ["focus", /\bwhat about\b/i],
  ["roster", /\b(?:working on|what did|what are|what(?:'s| is) .+ doing|agents? doing)\b/i],
];

function clean(value) {
  return String(value ?? "")
    .replace(/\.$/, "")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseWorkforceFact(item) {
  const text = String(item?.text ?? "");
  const name = text.match(/^(.+?)(?: \(reported name, untrusted\))?\./)?.[1]?.trim();
  if (!name) return null;
  if (!/\b(?:Liveness (?:active|idle|stale|unknown)|Binding revoked)\b/i.test(text)) return null;
  const status = text.match(/\bObserved status ([a-z]+)/i)?.[1]?.toLowerCase() ?? null;
  return {
    name,
    role: text.match(/\bRole ([^.]+)\./)?.[1]?.trim() ?? null,
    liveness: text.match(/\bLiveness (active|idle|stale|unknown)\b/i)?.[1]?.toLowerCase() ?? null,
    revoked: /\bBinding revoked\b/i.test(text),
    status,
    detail: clean(text.match(/\bObserved status [a-z]+: ([^.]+)\./i)?.[1] ?? ""),
    completed: /\bObserved status (?:completed|finished|done)\b/i.test(text),
    failed: /\bObserved failure\b/i.test(text),
    finding: clean(text.match(/\bObserved finding: ([^.]+)\./i)?.[1] ?? ""),
    attention: /\bObserved attention:/i.test(text),
    attentionDetail: clean(text.match(/\bObserved attention: ([^.]+)\./i)?.[1] ?? ""),
    raw: text,
  };
}

function mentions(text, fact) {
  const source = String(text ?? "");
  if (fact.name && new RegExp(`\\b${escapeRegExp(fact.name)}\\b`, "i").test(source)) return true;
  if (fact.role && new RegExp(`\\b${escapeRegExp(fact.role)}\\b`, "i").test(source)) return true;
  return false;
}

function namedIn(text, facts) {
  return facts.filter((fact) => mentions(text, fact));
}

function assistantTexts(transcript) {
  const messages = Array.isArray(transcript) ? transcript : [];
  const texts = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "assistant") continue;
    texts.push(String(messages[index].content ?? messages[index].text ?? ""));
  }
  return texts;
}

function priorUserText(transcript) {
  const messages = Array.isArray(transcript) ? transcript : [];
  const texts = [];
  for (let index = messages.length - 1; index >= 0 && texts.length < 4; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    texts.push(String(messages[index].content ?? messages[index].text ?? ""));
  }
  return texts.slice(1).join(" ");
}

function focus(question, facts, transcript, { pronoun = false } = {}) {
  const named = namedIn(question, facts);
  if (named.length) return named;
  if (pronoun && /\b(?:it|that|they|them)\b/i.test(question)) {
    for (const text of assistantTexts(transcript)) {
      const hits = namedIn(text, facts);
      if (hits.length === 1) return hits;
    }
    const fromUser = namedIn(priorUserText(transcript), facts);
    if (fromUser.length === 1) return fromUser;
  }
  return facts;
}

function listNames(facts) {
  const labels = facts.map((fact) => fact.name);
  if (labels.length <= 1) return labels[0] ?? "No agent";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function rank(fact) {
  if (fact.revoked) return 5;
  if (fact.liveness === "stale") return 4;
  if ((fact.status === "working" || fact.status === "started") && fact.liveness === "active") {
    return 0;
  }
  if (fact.completed) return 1;
  if (fact.failed || fact.attention) return 2;
  return 3;
}

export function riskClause(fact) {
  const detail = clean(fact.detail);
  const failure = detail
    ? `${fact.name} reported a failure: ${detail}`
    : `${fact.name} reported a failure`;
  if (!fact.attention) return `${failure}.`;
  const ask = fact.attentionDetail ? `: ${clean(fact.attentionDetail)}` : "";
  return `${failure}, and requested attention${ask}.`;
}

export function stateClause(fact) {
  const detail = clean(fact.detail);
  if (fact.revoked) {
    const last = detail ? ` Last historical report: ${detail}.` : "";
    return `${fact.name}'s binding is revoked. Not currently active.${last}`;
  }
  if (fact.liveness === "stale") {
    const last = detail ? ` Last report: ${detail}.` : "";
    return `${fact.name} is stale, not currently active.${last} No completion was observed.`;
  }
  if (fact.failed) return riskClause(fact);
  if (fact.completed) {
    const work = detail.replace(/^completed\s+/i, "");
    return `${fact.name} completed ${work}.`;
  }
  if (fact.attention) {
    const ask = fact.attentionDetail ? `: ${clean(fact.attentionDetail)}` : "";
    return `${fact.name} requested attention${ask}.`;
  }
  if (fact.status === "working") {
    const target = detail.replace(/^still working on\s+/i, "").replace(/^working on\s+/i, "");
    const adverb = fact.liveness === "active" ? "currently " : "";
    return `${fact.name} is ${adverb}reported as working on ${target}. No completion was observed.`;
  }
  if (fact.status === "started") {
    const last = detail ? ` (${detail})` : "";
    return `${fact.name} has a start report${last}. A start is not completion. No completion was observed.`;
  }
  if (fact.liveness === "active") {
    return `${fact.name} is active by last-event time. No work status was observed. No completion was observed.`;
  }
  if (fact.liveness === "idle") return `${fact.name} is idle. No current work status was observed.`;
  return `${fact.name} has no current workforce status. That is unknown, not success.`;
}

function rosterAnswer(facts) {
  return [...facts]
    .sort((left, right) => rank(left) - rank(right))
    .map(stateClause)
    .join(" ");
}

function attentionAnswer(facts) {
  const current = facts.filter(
    (fact) => fact.attention && !fact.revoked && fact.liveness !== "stale"
  );
  if (!current.length) return "No attention request was observed.";
  return current.map((fact) => (fact.failed ? riskClause(fact) : stateClause(fact))).join(" ");
}

function concernAnswer(facts) {
  const current = facts.filter(
    (fact) => !fact.revoked && fact.liveness !== "stale" && (fact.failed || fact.attention)
  );
  if (!current.length)
    return `No failure or attention request was observed. ${rosterAnswer(facts)}`.trim();
  const calm = facts.filter(
    (fact) =>
      fact.liveness === "active" && fact.status === "working" && !fact.failed && !fact.attention
  );
  const rest = calm.length
    ? ` ${calm.map((fact) => `${fact.name} is working and is not the concern.`).join(" ")}`
    : "";
  return `${current.map(riskClause).join(" ")}${rest}`;
}

function stuckAnswer(facts) {
  const explicit = facts.filter((fact) =>
    /\bstuck\b/i.test(`${fact.status} ${fact.detail} ${fact.attentionDetail} ${fact.finding}`)
  );
  if (explicit.length) {
    return explicit
      .map(
        (fact) =>
          `${fact.name} is reported as stuck${fact.detail ? `: ${clean(fact.detail)}` : ""}.`
      )
      .join(" ");
  }
  const adjacent = facts.filter(
    (fact) => !fact.revoked && fact.liveness !== "stale" && (fact.failed || fact.attention)
  );
  const extra = adjacent.length ? ` ${adjacent.map(riskClause).join(" ")}` : "";
  return `Nothing is explicitly reported as stuck.${extra}`;
}

function problemAnswer(question, facts) {
  const named = namedIn(question, facts);
  if (named.length) {
    return named
      .map((fact) =>
        fact.failed ? riskClause(fact) : `${stateClause(fact)} No failure was observed.`
      )
      .join(" ");
  }
  const failed = facts.filter((fact) => fact.failed && !fact.revoked);
  if (!failed.length) return "No failure was observed.";
  return failed.map(riskClause).join(" ");
}

function gapsAnswer(facts) {
  const open = facts.filter((fact) => !fact.completed && !fact.revoked);
  const missing = open.length
    ? `${listNames(open)} ${open.length === 1 ? "has" : "have"} no completion event.`
    : "";
  const stale = facts.filter((fact) => fact.liveness === "stale");
  const staleLine = stale.length
    ? `${listNames(stale)} ${stale.length === 1 ? "is" : "are"} stale, so current activity is unknown.`
    : "";
  return [
    "No tool use was observed.",
    "No code change was observed.",
    "No deployment was observed.",
    missing,
    staleLine,
    "Missing telemetry is unknown, not success.",
  ]
    .filter(Boolean)
    .join(" ");
}

function finishAnswer(question, facts, transcript) {
  const targets = focus(question, facts, transcript, { pronoun: true });
  return targets
    .map((fact) => {
      const line = stateClause(fact);
      if (fact.completed || /No completion was observed/.test(line)) return line;
      return `${line} No completion was observed.`;
    })
    .join(" ");
}

function findingAnswer(question, facts, transcript) {
  const targets = focus(question, facts, transcript, { pronoun: true });
  return targets
    .map((fact) =>
      fact.finding
        ? `${fact.name} reported a finding: ${clean(fact.finding)}.`
        : `No finding was observed for ${fact.name}.`
    )
    .join(" ");
}

function idleAnswer(facts) {
  const open = facts.filter((fact) => !fact.revoked);
  const idle = open.filter((fact) => fact.liveness === "idle");
  const active = open.filter((fact) => fact.liveness === "active");
  const stale = open.filter((fact) => fact.liveness === "stale");
  const revoked = facts.filter((fact) => fact.revoked);
  const parts = [
    idle.length
      ? `${listNames(idle)} ${idle.length === 1 ? "is" : "are"} idle.`
      : "No agent is idle.",
  ];
  if (active.length)
    parts.push(`${listNames(active)} ${active.length === 1 ? "is" : "are"} active.`);
  if (stale.length) {
    parts.push(
      `${listNames(stale)} ${stale.length === 1 ? "is" : "are"} stale, not idle and not currently active.`
    );
  }
  if (revoked.length) {
    parts.push(
      `${listNames(revoked)} ${revoked.length === 1 ? "has a revoked binding and is" : "have revoked bindings and are"} not currently active.`
    );
  }
  const risks = idle.filter((fact) => fact.failed || fact.attention);
  if (risks.length) parts.push(risks.map(riskClause).join(" "));
  return parts.join(" ");
}

function happenedAnswer(facts) {
  return [...facts]
    .sort((left, right) => rank(left) - rank(right))
    .map((fact) => {
      const line = stateClause(fact);
      if (!fact.finding || line.includes(fact.finding)) return line;
      return `${line} Observed finding: ${clean(fact.finding)}.`;
    })
    .join(" ");
}

function changedAnswer(facts) {
  return `There is no earlier workforce snapshot to compare against. Current observations: ${rosterAnswer(facts)} No deployment was observed.`;
}

function askKind(question) {
  const text = String(question ?? "");
  for (const [kind, pattern] of ASKS) {
    if (pattern.test(text)) return kind;
  }
  return null;
}

function renderAsk(kind, question, facts, transcript) {
  if (kind === "attention") return attentionAnswer(facts);
  if (kind === "concern") return concernAnswer(facts);
  if (kind === "stuck") return stuckAnswer(facts);
  if (kind === "problem") return problemAnswer(question, facts);
  if (kind === "gaps") return gapsAnswer(facts);
  if (kind === "finding") return findingAnswer(question, facts, transcript);
  if (kind === "finish") return finishAnswer(question, facts, transcript);
  if (kind === "idle") return idleAnswer(facts);
  if (kind === "changed") return changedAnswer(facts);
  if (kind === "happened") return happenedAnswer(facts);
  if (kind === "focus") return rosterAnswer(focus(question, facts, transcript, { pronoun: true }));
  return rosterAnswer(focus(question, facts, transcript));
}

export function answerFromWorkforce({
  question = "",
  modelText = "",
  facts = [],
  transcript = [],
} = {}) {
  if (!facts.length) return null;
  const kind = askKind(question);
  if (!kind) return null;
  const body = renderAsk(kind, question, facts, transcript).replace(/\s+/g, " ").trim();
  const universal =
    /\b(?:everyone|every agent|all agents|all of them)\b/i.test(modelText) &&
    /\b(?:finished|completed|done)\b/i.test(modelText);
  if (universal) return `That's not what the workforce observations show. ${body}`;
  return body;
}

function scopedFacts(sentence, facts, transcript) {
  if (/\b(?:everyone|every agent|all agents|all of them)\b/i.test(sentence)) return facts;
  if (/\b(?:it|that|they)\b/i.test(sentence))
    return focus(sentence, facts, transcript, { pronoun: true });
  const named = namedIn(sentence, facts);
  return named.length ? named : facts;
}

function affirms(sentence, pattern) {
  if (!pattern.test(sentence)) return false;
  const match = sentence.match(pattern);
  if (!match || match.index == null) return true;
  const before = sentence
    .slice(Math.max(0, match.index - 32), match.index)
    .replace(/\bnever\s*mind\b/gi, "");
  return !/\b(?:no|not|never|unknown|without|missing|wasn't|weren't|didn't|cannot|can't|don't|dont|nothing|nobody|no one)\b/i.test(
    before
  );
}

export function correctWorkforceSentence(sentence, facts, transcript = []) {
  if (!facts.length) return null;
  const scope = scopedFacts(sentence, facts, transcript);
  const allFailed = facts.some((fact) => fact.failed);
  if (
    /\b(?:nothing failed|no failures|nobody failed|no agent failed)\b/i.test(sentence) &&
    allFailed
  ) {
    return facts
      .filter((fact) => fact.failed)
      .map(riskClause)
      .join(" ");
  }
  if (
    /\b(?:no agent needs(?: my)? attention|nobody needs(?: my)? attention|no attention)\b/i.test(
      sentence
    ) &&
    facts.some((fact) => fact.attention && !fact.revoked)
  ) {
    return attentionAnswer(facts);
  }
  if (
    /\b(?:everyone|every agent|all agents|all of them)\b/i.test(sentence) &&
    affirms(sentence, /\b(?:finished|completed|done)\b/i)
  ) {
    if (!scope.every((fact) => fact.completed)) {
      return `That's not what the workforce observations show. ${rosterAnswer(facts)}`;
    }
  }
  const claim = [
    [
      /\b(?:completed|finished|accomplished)\b/i,
      (fact) => fact.completed,
      "No completion was observed.",
    ],
    [
      /\b(?:failed|failure|stuck|error)\b/i,
      (fact) => fact.failed || /\bstuck\b/i.test(`${fact.detail} ${fact.status}`),
      "No failure was observed.",
    ],
    [
      /\b(?:needs? (?:my |your )?attention|attention request)\b/i,
      (fact) => fact.attention,
      "No attention request was observed.",
    ],
    [/\b(?:found|finding)\b/i, (fact) => Boolean(fact.finding), "No finding was observed."],
    [
      /\b(?:changed (?:the )?code|committed|edited (?:a |the )?files?)\b/i,
      () => false,
      "No code change was observed.",
    ],
    [
      /\b(?:ran (?:the )?tests|used (?:a |the )?(?:shell|terminal)|npm test)\b/i,
      () => false,
      "No tool use was observed.",
    ],
    [/\b(?:deploy(?:ing|ed)?)\b/i, () => false, "No deployment was observed."],
  ].find(([pattern]) => affirms(sentence, pattern));
  if (claim && !scope.every((fact) => claim[1](fact))) {
    const [pattern, , unknown] = claim;
    if (
      pattern.test(sentence) &&
      /\bstuck\b/i.test(sentence) &&
      !scope.some((fact) => /\bstuck\b/i.test(`${fact.detail} ${fact.status}`))
    ) {
      return stuckAnswer(scope);
    }
    const positive = scope
      .map((fact) => {
        const line = stateClause(fact);
        return line.includes(unknown.replace(/\.$/, "")) ? line : `${line} ${unknown}`;
      })
      .join(" ");
    return positive;
  }
  if (
    affirms(sentence, /\b(?:currently active|is active)\b/i) &&
    !scope.every((fact) => fact.liveness === "active" && !fact.revoked)
  ) {
    return scope.map(stateClause).join(" ");
  }
  if (affirms(sentence, /\b(?:working on|working right now|still working)\b/i)) {
    if (scope.some((fact) => fact.completed) && scope.every((fact) => fact.status !== "working")) {
      return scope.map(stateClause).join(" ");
    }
    if (scope.some((fact) => fact.failed) && scope.every((fact) => fact.status !== "working")) {
      return scope.map(riskClause).join(" ");
    }
  }
  return null;
}
