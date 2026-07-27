import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildIdentityNamespaces,
  CEO_AGENT_CAPABILITIES,
  CEO_AGENT_ENTITY_TYPE,
  filterAssistantIdentityOps,
  isAssistantIdentityAttributedToUser,
  renderIdentitySituationBrief,
  selectOwnedUserMemories,
  validateIdentityConsistency,
} from "../server/brain/identity.js";
import { BRAIN_SYSTEM_PROMPT } from "../server/brain/prompts.js";

/** Fixture display names only — never production identity keys. */
const DISPLAY_NAME = "Harry";
const USER = "Kyle";
const CEO_ID = "ceo-config-1";

function identities(displayName = DISPLAY_NAME) {
  return buildIdentityNamespaces({
    ceoConfig: { id: CEO_ID, name: displayName },
    user: { displayName: USER, timezone: "America/New_York" },
    teamAgents: [{ id: "a1", name: "Research" }],
    profile: {
      categories: {
        financialGoals: [],
        knownAccountsRelationships: [],
        statedPreferences: [{ id: "p1", text: "Prefers concise updates", source: "user_edit" }],
        recurringConcerns: [],
        lifeContext: [
          { id: "l1", text: "User's name is Kyle", source: "onboarding" },
          // Leak: CEO display label wrongly stored as a user fact — must be filtered.
          { id: "l2", text: `Name: ${displayName}`, source: "brain_chat" },
        ],
      },
      tombstones: [],
    },
  });
}

test("assistant identity is entity-typed (CEO_AGENT), displayName is only a label", () => {
  const id = identities();
  assert.equal(id.assistantIdentity.entityType, CEO_AGENT_ENTITY_TYPE);
  assert.equal(id.assistantIdentity.id, CEO_ID);
  assert.equal(id.assistantIdentity.displayName, DISPLAY_NAME);
  assert.equal(id.assistantIdentity.capabilities, CEO_AGENT_CAPABILITIES);
  assert.equal(id.userIdentity.name, USER);
  assert.ok(!id.userIdentity.personalFacts.some((f) => new RegExp(DISPLAY_NAME, "i").test(f)));
});

test("renaming CEO displayName does not change type, id, or capabilities", () => {
  const before = identities("Harry");
  const after = identities("Morgan");
  assert.equal(before.assistantIdentity.entityType, after.assistantIdentity.entityType);
  assert.equal(before.assistantIdentity.id, after.assistantIdentity.id);
  assert.equal(before.assistantIdentity.capabilities, after.assistantIdentity.capabilities);
  assert.equal(before.assistantIdentity.role, after.assistantIdentity.role);
  assert.notEqual(before.assistantIdentity.displayName, after.assistantIdentity.displayName);
});

test("Situation Brief uses entityType/id/displayName + CEO Agent selfDescription", () => {
  const sections = renderIdentitySituationBrief({
    identities: identities(),
    activeMission: {
      mission: "Answer the user",
      missionKind: "answer",
      missionExecutable: true,
      known: [],
      missing: [],
    },
    relevantMemories: [
      {
        owner: "user",
        type: "preference",
        key: "preference",
        value: "Prefers concise updates",
        id: "p1",
        annotation: {
          reason: "core user-confirmed context",
          confidence: 0.9,
          source: "user confirmed (profile edit)",
          lastConfirmed: "2026-07-01",
        },
      },
    ],
  }).join("\n\n");

  assert.match(sections, /ASSISTANT IDENTITY/);
  assert.match(sections, /entityType: CEO_AGENT/);
  assert.match(sections, new RegExp(`id: ${CEO_ID}`));
  assert.match(sections, /displayName: Harry/);
  assert.match(sections, /selfDescription: I am the CEO Agent named Harry\./);
  assert.match(sections, /user-configurable label only/);
  assert.match(sections, /USER IDENTITY/);
  assert.match(sections, /name: Kyle/);
  assert.doesNotMatch(sections, /owner: user; type: identity; key: name; value:.*Harry/i);
});

test("owned memories drop CEO displayName leaks from user profile", () => {
  const selected = [
    {
      category: "lifeContext",
      entry: { id: "l2", text: "Name: Harry", source: "brain_chat" },
      annotation: {
        reason: "background",
        confidence: 0.5,
        source: "extracted",
        lastConfirmed: "2026-07-01",
      },
    },
    {
      category: "lifeContext",
      entry: { id: "l1", text: "User's name is Kyle", source: "onboarding" },
      annotation: {
        reason: "core",
        confidence: 0.9,
        source: "onboarding",
        lastConfirmed: "2026-07-01",
      },
    },
  ];
  const owned = selectOwnedUserMemories(selected, { assistantDisplayName: DISPLAY_NAME });
  assert.equal(owned.length, 1);
  assert.equal(owned[0].value, "User's name is Kyle");
  assert.ok(isAssistantIdentityAttributedToUser("Name: Harry", DISPLAY_NAME));
  assert.equal(isAssistantIdentityAttributedToUser("User's name is Kyle", DISPLAY_NAME), false);
});

test("memory extraction ops cannot store CEO displayName as user facts", () => {
  const ops = filterAssistantIdentityOps(
    [
      { op: "add", category: "lifeContext", text: "Name: Harry" },
      { op: "add", category: "lifeContext", text: "User's name is Kyle" },
      { op: "add", category: "statedPreferences", text: "Prefers email digests" },
    ],
    DISPLAY_NAME
  );
  assert.equal(ops.length, 2);
  assert.ok(ops.every((op) => !/Harry/i.test(op.text)));
});

test("regression: why do you call me <displayName>? — must not claim it is in user profile", () => {
  const id = identities();
  const bad = validateIdentityConsistency(
    "I see Harry listed in your profile context, so I used that name.",
    id,
    { userMessage: "why you call me harry?" }
  );
  assert.equal(bad.ok, false);

  const good = validateIdentityConsistency(
    "I am the CEO Agent named Harry — that is my display name, not yours. I made a mistake.",
    id,
    { userMessage: "why you call me harry?" }
  );
  assert.equal(good.ok, true, JSON.stringify(good));
});

test("regression: greeting must not address the user as the CEO displayName", () => {
  const id = identities();
  const bad = validateIdentityConsistency("Hey Harry! Doing well, thanks for asking.", id, {
    userMessage: "how ya doingg",
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.includes("addressed_user_as_assistant"));

  const good = validateIdentityConsistency("Hey Kyle! Doing well, thanks for asking.", id, {
    userMessage: "how ya doingg",
  });
  assert.equal(good.ok, true, JSON.stringify(good));
});

test("who are you / what is your name / what is my name boundaries", () => {
  const id = identities();

  const who = validateIdentityConsistency(
    "I am the CEO Agent named Harry, your Freedom Brain inside Freedom OS.",
    id,
    { userMessage: "Who are you?" }
  );
  assert.equal(who.ok, true, JSON.stringify(who));

  const yourName = validateIdentityConsistency(
    "I am the CEO Agent named Harry.",
    id,
    { userMessage: "What is your name?" }
  );
  assert.equal(yourName.ok, true, JSON.stringify(yourName));

  const myNameBad = validateIdentityConsistency("Your name is Harry.", id, {
    userMessage: "What is my name?",
  });
  assert.equal(myNameBad.ok, false);

  const myNameGood = validateIdentityConsistency("Your name is Kyle.", id, {
    userMessage: "What is my name?",
  });
  assert.equal(myNameGood.ok, true, JSON.stringify(myNameGood));
});

test("remember your name is Kyle must not rewrite CEO entity identity", () => {
  const id = identities();
  const bad = validateIdentityConsistency("Got it — my name is Kyle from now on.", id, {
    userMessage: "Remember your name is Kyle.",
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.includes("accepted_user_name_as_assistant_identity"));

  const good = validateIdentityConsistency(
    "I remain the CEO Agent named Harry — entity type CEO_AGENT. Your name is Kyle.",
    id,
    { userMessage: "Remember your name is Kyle." }
  );
  assert.equal(good.ok, true, JSON.stringify(good));
});

test("Brain system prompt uses entity type, not hardcoded display names", () => {
  assert.match(BRAIN_SYSTEM_PROMPT, /CEO_AGENT/);
  assert.match(BRAIN_SYSTEM_PROMPT, /displayName/);
  assert.match(BRAIN_SYSTEM_PROMPT, /selfDescription|CEO Agent named/i);
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /\bHarry\b/);
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /\bKyle\b/);
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /never call the user/i);
});

test("no hardcoded Harry in production server modules", () => {
  const roots = [
    path.resolve("server/brain"),
    path.resolve("server/agents"),
    path.resolve("server/memory"),
  ];
  const offenders = [];
  for (const root of roots) {
    walkJs(root, (file) => {
      const text = fs.readFileSync(file, "utf8");
      if (/\bHarry\b/.test(text)) offenders.push(path.relative(process.cwd(), file));
    });
  }
  assert.deepEqual(offenders, [], `hardcoded Harry in: ${offenders.join(", ")}`);
});

function walkJs(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, visit);
    else if (entry.isFile() && entry.name.endsWith(".js")) visit(full);
  }
}
