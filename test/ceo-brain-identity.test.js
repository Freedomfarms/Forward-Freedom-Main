import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIdentityNamespaces,
  filterAssistantIdentityOps,
  isAssistantIdentityAttributedToUser,
  renderIdentitySituationBrief,
  selectOwnedUserMemories,
  validateIdentityConsistency,
} from "../server/brain/identity.js";
import { BRAIN_SYSTEM_PROMPT } from "../server/brain/prompts.js";

const ASSISTANT = "Harry";
const USER = "Kyle";

function identities() {
  return buildIdentityNamespaces({
    ceoConfig: { name: ASSISTANT },
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
          // Leak: assistant name wrongly stored as a user fact — must be filtered.
          { id: "l2", text: "Name: Harry", source: "brain_chat" },
        ],
      },
      tombstones: [],
    },
  });
}

test("identity namespaces keep assistant and user names separate", () => {
  const id = identities();
  assert.equal(id.assistantIdentity.name, ASSISTANT);
  assert.equal(id.userIdentity.name, USER);
  assert.equal(id.workspaceIdentity.product, "Freedom OS");
  assert.ok(id.userIdentity.preferences.some((p) => /concise/i.test(p)));
  assert.ok(!id.userIdentity.personalFacts.some((f) => /Harry/i.test(f)));
});

test("Situation Brief renders separated identity sections (never merged)", () => {
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
  assert.match(sections, /USER IDENTITY/);
  assert.match(sections, /WORKSPACE/);
  assert.match(sections, /ACTIVE MISSION/);
  assert.match(sections, /RELEVANT MEMORIES/);
  assert.match(sections, /owner: assistant/);
  assert.match(sections, /owner: user/);
  assert.match(sections, /name: Harry/);
  assert.match(sections, /name: Kyle/);
  // Assistant name must not appear as an unattributed user memory value.
  assert.doesNotMatch(sections, /owner: user; type: identity; key: name; value:.*Harry/i);
  assert.match(sections, /owner: user; type: preference/);
});

test("owned memories drop assistant-identity leaks from user profile", () => {
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
  const owned = selectOwnedUserMemories(selected, { assistantName: ASSISTANT });
  assert.equal(owned.length, 1);
  assert.equal(owned[0].value, "User's name is Kyle");
  assert.equal(owned[0].owner, "user");
  assert.ok(isAssistantIdentityAttributedToUser("Name: Harry", ASSISTANT));
  assert.equal(isAssistantIdentityAttributedToUser("User's name is Kyle", ASSISTANT), false);
});

test("memory extraction ops cannot store assistant identity as user facts", () => {
  const ops = filterAssistantIdentityOps(
    [
      { op: "add", category: "lifeContext", text: "Name: Harry" },
      { op: "add", category: "lifeContext", text: "User's name is Kyle" },
      { op: "add", category: "statedPreferences", text: "Prefers email digests" },
    ],
    ASSISTANT
  );
  assert.equal(ops.length, 2);
  assert.ok(ops.every((op) => !/Harry/i.test(op.text)));
});

test("regression: why do you call me Harry? — must not claim Harry is in user profile", () => {
  const id = identities();
  const bad = validateIdentityConsistency(
    "I see Harry listed in your profile context, so I used that name.",
    id,
    { userMessage: "why you call me harry?" }
  );
  assert.equal(bad.ok, false);
  assert.ok(
    bad.failures.includes("assistant_name_attributed_to_user") ||
      bad.failures.includes("failed_identity_correction")
  );

  const good = validateIdentityConsistency(
    "Harry is my name, not yours. I made a mistake.",
    id,
    { userMessage: "why you call me harry?" }
  );
  assert.equal(good.ok, true, JSON.stringify(good));
});

test("regression: greeting must not address the user as the assistant", () => {
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
    "I'm Harry, your Freedom Brain CEO Agent inside Freedom OS.",
    id,
    { userMessage: "Who are you?" }
  );
  assert.equal(who.ok, true, JSON.stringify(who));

  const yourName = validateIdentityConsistency("My name is Harry.", id, {
    userMessage: "What is your name?",
  });
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

test("remember your name is Kyle must not rewrite assistant identity", () => {
  const id = identities();
  const bad = validateIdentityConsistency("Got it — my name is Kyle from now on.", id, {
    userMessage: "Remember your name is Kyle.",
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.includes("accepted_user_name_as_assistant_identity"));

  const good = validateIdentityConsistency(
    "I stay Harry — that's my assistant identity. Your name is Kyle.",
    id,
    { userMessage: "Remember your name is Kyle." }
  );
  assert.equal(good.ok, true, JSON.stringify(good));
});

test("Brain system prompt points at structured identity sections, not name patches", () => {
  assert.match(BRAIN_SYSTEM_PROMPT, /ASSISTANT IDENTITY/);
  assert.match(BRAIN_SYSTEM_PROMPT, /USER IDENTITY/);
  assert.match(BRAIN_SYSTEM_PROMPT, /RELEVANT MEMORIES/);
  assert.match(BRAIN_SYSTEM_PROMPT, /owner-attributed|owner namespace/i);
  // No hardcoded Harry/Kyle exception lists.
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /\bHarry\b/);
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /\bKyle\b/);
  assert.doesNotMatch(BRAIN_SYSTEM_PROMPT, /never call the user/i);
});
