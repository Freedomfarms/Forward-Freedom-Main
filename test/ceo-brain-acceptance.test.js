import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_TYPE_COMMIT_CONFIDENCE,
  isHighestValueQuestion,
  shouldCommitAgentType,
  sketchMissionFromMessage,
} from "../server/agents/ceoReasoning.js";

/**
 * CEO Brain acceptance suite — behavioral validation of mission sketches.
 * Captures Situation / Mission / Known / Missing / Question for each case.
 * Does not call the LLM; validates the shared reasoning helpers the Brain logs.
 */

const EXISTING_AGENTS = [
  { id: "a1", name: "Supplier Risk Agent", agentType: "research" },
  { id: "a2", name: "Portfolio Watch", agentType: "finance" },
  { id: "a3", name: "Morning Brief", agentType: "research" },
];

const PREFERENCE_RE = /personality|tone|voice|style|escalat|boundar|permission/i;
const INVENTED_FINANCE_COMMIT = (sketch) =>
  sketch.tentativeAgentType === "finance" &&
  shouldCommitAgentType(sketch.agentTypeConfidence, ["forced"]);

/** @typedef {"agent_creation"|"existing_changes"|"ambiguous"|"complete"} Category */

/** @type {Array<{id:string,category:Category,input:string,expect:object}>} */
const CASES = [
  // ── 1. Agent creation ────────────────────────────────────────────────────
  {
    id: "create-01",
    category: "agent_creation",
    input: "Build me something that tracks competitors.",
    expect: {
      missionKinds: ["create"],
      missionMatch: /competitor/i,
      missingMatch: /competitor|industry/i,
      questionMatch: /competitor|industry|who|which/i,
      executable: false,
    },
  },
  {
    id: "create-02",
    category: "agent_creation",
    input: "I need a weekly supplier risk report.",
    expect: {
      missionKinds: ["create"],
      missionMatch: /supplier/i,
      missingMatch: /supplier/i,
      questionMatch: /supplier/i,
      knownMatch: /weekly|supplier/i,
      executable: false,
    },
  },
  {
    id: "create-03",
    category: "agent_creation",
    input: "Monitor my investments.",
    expect: {
      missionKinds: ["create"],
      missionMatch: /invest/i,
      missingMatch: /account|ticker|portfolio|scope/i,
      questionMatch: /account|ticker|portfolio|scope|which/i,
      mustNotCommitType: true,
      executable: false,
    },
  },
  {
    id: "create-04",
    category: "agent_creation",
    input: "I want an agent that emails me social media reports on a couple people.",
    expect: {
      missionKinds: ["create"],
      missionMatch: /social media/i,
      missingMatch: /people/i,
      questionMatch: /people|who/i,
      knownMatch: /email/i,
      mustNotCommitType: true,
      executable: false,
    },
  },
  {
    id: "create-05",
    category: "agent_creation",
    input: "Create a research agent for AI chip news.",
    expect: {
      missionKinds: ["create"],
      missingMatch: /outcome|done/i,
      questionMatch: /outcome|done|what/i,
      executable: false,
    },
  },
  {
    id: "create-06",
    category: "agent_creation",
    input: "Set up something that watches Tesla and NVIDIA on X.",
    expect: {
      missionKinds: ["create", "execute"],
      // Proper names + platform present; may still need schedule/delivery
      knownMatch: /Tesla|NVIDIA|X/i,
      questionMustNotMatch: PREFERENCE_RE,
      mustNotCommitType: true,
    },
  },
  {
    id: "create-07",
    category: "agent_creation",
    input: "I need daily alerts when my competitors raise prices.",
    expect: {
      missionKinds: ["create"],
      missionMatch: /competitor/i,
      missingMatch: /competitor|industry/i,
      knownMatch: /Schedule|daily|Report|watch/i,
      questionMatch: /competitor|industry|who|which/i,
      executable: false,
    },
  },
  {
    id: "create-08",
    category: "agent_creation",
    input: "Build an agent to email me a Friday summary of supplier delays.",
    expect: {
      missionKinds: ["create"],
      missionMatch: /supplier/i,
      missingMatch: /supplier/i,
      knownMatch: /email|weekly|Friday|Schedule|Risk|supplier/i,
      questionMatch: /supplier/i,
      executable: false,
    },
  },
  {
    id: "create-09",
    category: "agent_creation",
    input: "Track my portfolio and ping me on big moves.",
    expect: {
      missionKinds: ["create"],
      missionMatch: /portfolio|invest/i,
      missingMatch: /account|ticker|portfolio|scope/i,
      mustNotCommitType: true,
      executable: false,
    },
  },
  {
    id: "create-10",
    category: "agent_creation",
    input: "I want LinkedIn monitoring for hiring moves at rival firms.",
    expect: {
      missionKinds: ["create"],
      knownMatch: /LinkedIn|social/i,
      missingMatch: /people|competitor|firms|who/i,
      questionMustNotMatch: PREFERENCE_RE,
      executable: false,
    },
  },
  {
    id: "create-11",
    category: "agent_creation",
    input: "Stand up a reminders agent for my board meeting prep.",
    expect: {
      missionKinds: ["create"],
      missingMatch: /outcome|done/i,
      questionMustNotMatch: PREFERENCE_RE,
      executable: false,
    },
  },
  {
    id: "create-12",
    category: "agent_creation",
    input: "Watch competitors in the EV charging space and report weekly.",
    expect: {
      missionKinds: ["create"],
      missionMatch: /competitor/i,
      // Industry hint present — still may ask what to watch for as top gap after competitors known?
      // "EV charging" gives industry — sketch may still list competitors OR what to watch
      missingMatch: /watch|signal|deliver|competitor/i,
      knownMatch: /Schedule|weekly|Report/i,
      questionMustNotMatch: PREFERENCE_RE,
      executable: false,
    },
  },

  // ── 2. Existing agent changes ────────────────────────────────────────────
  {
    id: "modify-01",
    category: "existing_changes",
    input: "Make my supplier agent send reports earlier.",
    expect: {
      missionKinds: ["modify"],
      recognizesExisting: true,
      mustNotCreate: true,
      missingMatch: /time|send/i,
      questionMatch: /time|when|send/i,
      questionMustNotMatch: PREFERENCE_RE,
    },
  },
  {
    id: "modify-02",
    category: "existing_changes",
    input: "Change the report format.",
    expect: {
      missionKinds: ["modify"],
      mustNotCreate: true,
      missingMatch: /which existing agent|format/i,
      questionMustNotMatch: PREFERENCE_RE,
    },
  },
  {
    id: "modify-03",
    category: "existing_changes",
    input: "Change my supplier agent report format to bullets.",
    expect: {
      missionKinds: ["modify"],
      recognizesExisting: true,
      mustNotCreate: true,
      knownMatch: /format|Supplier/i,
      // Concrete format given → may be executable
      questionMustNotMatch: PREFERENCE_RE,
    },
  },
  {
    id: "modify-04",
    category: "existing_changes",
    input: "Pause Portfolio Watch.",
    expect: {
      missionKinds: ["modify"],
      recognizesExisting: true,
      mustNotCreate: true,
      existingAgents: EXISTING_AGENTS,
    },
  },
  {
    id: "modify-05",
    category: "existing_changes",
    input: "Update the Morning Brief to go out at 6am.",
    expect: {
      missionKinds: ["modify"],
      recognizesExisting: true,
      mustNotCreate: true,
      existingAgents: EXISTING_AGENTS,
      knownMatch: /schedule|Morning|6/i,
    },
  },
  {
    id: "modify-06",
    category: "existing_changes",
    input: "Rename my supplier agent to Vendor Radar.",
    expect: {
      missionKinds: ["modify"],
      recognizesExisting: true,
      mustNotCreate: true,
    },
  },
  {
    id: "modify-07",
    category: "existing_changes",
    input: "Make that research agent shorter in its emails.",
    expect: {
      missionKinds: ["modify"],
      recognizesExisting: true,
      mustNotCreate: true,
      questionMustNotMatch: PREFERENCE_RE,
    },
  },
  {
    id: "modify-08",
    category: "existing_changes",
    input: "Have my supplier agent email me daily instead of weekly.",
    expect: {
      missionKinds: ["modify"],
      recognizesExisting: true,
      mustNotCreate: true,
      knownMatch: /schedule|Supplier/i,
    },
  },

  // ── 3. Ambiguous requests ────────────────────────────────────────────────
  {
    id: "ambig-01",
    category: "ambiguous",
    input: "Watch my company.",
    expect: {
      missionKinds: ["clarify", "create"],
      missingMatch: /company|what|news|ops|finance/i,
      questionMatch: /company|what|watch/i,
      questionMustNotMatch: PREFERENCE_RE,
      mustNotCommitType: true,
      executable: false,
    },
  },
  {
    id: "ambig-02",
    category: "ambiguous",
    input: "Help me with customers.",
    expect: {
      missionKinds: ["clarify", "create"],
      missingMatch: /customer|outcome|support|churn/i,
      questionMatch: /customer|outcome|what/i,
      questionMustNotMatch: PREFERENCE_RE,
      mustNotCommitType: true,
      executable: false,
    },
  },
  {
    id: "ambig-03",
    category: "ambiguous",
    input: "Keep an eye on things.",
    expect: {
      missionKinds: ["clarify", "create"],
      missingMatch: /outcome|done/i,
      questionMustNotMatch: PREFERENCE_RE,
      executable: false,
    },
  },
  {
    id: "ambig-04",
    category: "ambiguous",
    input: "I need something for ops.",
    expect: {
      missionKinds: ["create", "clarify"],
      missingMatch: /outcome|done/i,
      questionMustNotMatch: PREFERENCE_RE,
      mustNotCommitType: true,
      executable: false,
    },
  },
  {
    id: "ambig-05",
    category: "ambiguous",
    input: "Can you handle my inbox?",
    expect: {
      missionKinds: ["create", "clarify", "answer"],
      questionMustNotMatch: PREFERENCE_RE,
      mustNotCommitType: true,
      executable: false,
    },
  },
  {
    id: "ambig-06",
    category: "ambiguous",
    input: "Do the usual briefing.",
    expect: {
      missionKinds: ["clarify", "modify", "answer", "create"],
      questionMustNotMatch: PREFERENCE_RE,
      executable: false,
    },
  },
  {
    id: "ambig-07",
    category: "ambiguous",
    input: "Watch the market for me.",
    expect: {
      missionKinds: ["create", "clarify"],
      missingMatch: /account|ticker|portfolio|scope|outcome|market/i,
      questionMustNotMatch: PREFERENCE_RE,
      mustNotCommitType: true,
      executable: false,
    },
  },
  {
    id: "ambig-08",
    category: "ambiguous",
    input: "Help with hiring.",
    expect: {
      missionKinds: ["clarify", "create", "answer"],
      questionMustNotMatch: PREFERENCE_RE,
      mustNotCommitType: true,
      executable: false,
    },
  },

  // ── 4. Complete missions ─────────────────────────────────────────────────
  {
    id: "complete-01",
    category: "complete",
    input:
      "Every morning email me a summary of Elon Musk and Jensen Huang posts from X and LinkedIn.",
    expect: {
      missionKinds: ["execute", "create"],
      executable: true,
      knownMatch: /Elon Musk|Jensen Huang/i,
      mustNotAskPeopleOrPlatforms: true,
      questionMustNotMatch: PREFERENCE_RE,
    },
  },
  {
    id: "complete-02",
    category: "complete",
    input:
      "Every Monday email me a competitor pricing report using public web and SEC filings.",
    expect: {
      missionKinds: ["execute", "create"],
      // May still ask which competitors — that's a valid remaining blocker
      questionMustNotMatch: PREFERENCE_RE,
      mustNotOverInterviewPreferences: true,
    },
  },
  {
    id: "complete-03",
    category: "complete",
    input:
      "Every Monday at 8am email me an EV competitor digest using Reuters and company blogs for Tesla, Rivian, and Lucid.",
    expect: {
      missionKinds: ["execute", "create"],
      executable: true,
      knownMatch: /Tesla|Rivian|Lucid|Schedule|email/i,
      questionMustNotMatch: PREFERENCE_RE,
    },
  },
  {
    id: "complete-04",
    category: "complete",
    input: "Daily at 7am email me X posts from Satya Nadella.",
    expect: {
      missionKinds: ["execute", "create"],
      executable: true,
      knownMatch: /Satya Nadella|X|email|Schedule/i,
      mustNotAskPeopleOrPlatforms: true,
    },
  },
  {
    id: "complete-05",
    category: "complete",
    input:
      "Each Friday email me a weekly supplier risk summary for Acme Parts and Globex Components covering delay and financial risk.",
    expect: {
      missionKinds: ["execute", "create"],
      // Named suppliers + cadence + risk focus → should not ask personality
      questionMustNotMatch: PREFERENCE_RE,
      knownMatch: /supplier|weekly|Risk|email|Acme|Globex/i,
    },
  },
  {
    id: "complete-06",
    category: "complete",
    input: "Change my supplier agent report format to bullets.",
    expect: {
      missionKinds: ["modify"],
      recognizesExisting: true,
      mustNotCreate: true,
      executable: true,
    },
  },
  {
    id: "complete-07",
    category: "complete",
    input: "Update Morning Brief to send at 6am.",
    expect: {
      missionKinds: ["modify"],
      recognizesExisting: true,
      mustNotCreate: true,
      existingAgents: EXISTING_AGENTS,
      executable: true,
    },
  },
  {
    id: "complete-08",
    category: "complete",
    input:
      "Every weekday morning email me LinkedIn and X highlights for Fiona Green and Jensen Huang.",
    expect: {
      missionKinds: ["execute", "create"],
      executable: true,
      mustNotAskPeopleOrPlatforms: true,
      questionMustNotMatch: PREFERENCE_RE,
    },
  },
];

function capture(caseDef, sketch) {
  return {
    id: caseDef.id,
    category: caseDef.category,
    Input: caseDef.input,
    Situation: sketch.situation,
    Mission: sketch.mission,
    MissionKind: sketch.missionKind,
    Known: sketch.known,
    Missing: sketch.missing,
    Assumptions: sketch.assumptions,
    "Question chosen": sketch.selectedQuestion,
    "Was this the highest-value question?": isHighestValueQuestion(
      sketch.selectedQuestion,
      sketch.missing,
      { known: sketch.known }
    ),
    missionExecutable: sketch.missionExecutable,
  };
}

function runCase(caseDef) {
  const existingAgents = caseDef.expect.existingAgents || EXISTING_AGENTS;
  const sketch = sketchMissionFromMessage(caseDef.input, { existingAgents });
  const report = capture(caseDef, sketch);
  const exp = caseDef.expect;

  // Always: never preference-first / invent committed finance / over-interview prefs
  assert.doesNotMatch(
    sketch.selectedQuestion || "",
    PREFERENCE_RE,
    `${caseDef.id}: preference question before blockers\n${JSON.stringify(report, null, 2)}`
  );
  assert.ok(
    !sketch.missing.some((gap) => PREFERENCE_RE.test(gap)),
    `${caseDef.id}: preference gaps in missing\n${JSON.stringify(report, null, 2)}`
  );
  assert.equal(
    INVENTED_FINANCE_COMMIT(sketch),
    false,
    `${caseDef.id}: invented committed finance type\n${JSON.stringify(report, null, 2)}`
  );
  assert.ok(
    sketch.agentTypeConfidence < AGENT_TYPE_COMMIT_CONFIDENCE ||
      sketch.missionExecutable ||
      sketch.missionKind === "modify",
    `${caseDef.id}: agent type committed too early\n${JSON.stringify(report, null, 2)}`
  );
  assert.equal(
    report["Was this the highest-value question?"],
    true,
    `${caseDef.id}: not highest-value question\n${JSON.stringify(report, null, 2)}`
  );

  if (exp.missionKinds) {
    assert.ok(
      exp.missionKinds.includes(sketch.missionKind),
      `${caseDef.id}: missionKind ${sketch.missionKind} not in ${exp.missionKinds}\n${JSON.stringify(report, null, 2)}`
    );
  }
  if (exp.missionMatch) {
    assert.match(
      sketch.mission || "",
      exp.missionMatch,
      `${caseDef.id}: mission mismatch\n${JSON.stringify(report, null, 2)}`
    );
  }
  if (exp.knownMatch) {
    assert.ok(
      sketch.known.some((fact) => exp.knownMatch.test(fact)) ||
        exp.knownMatch.test(sketch.known.join(" ")),
      `${caseDef.id}: known mismatch\n${JSON.stringify(report, null, 2)}`
    );
  }
  if (exp.missingMatch) {
    assert.ok(
      sketch.missing.some((gap) => exp.missingMatch.test(gap)),
      `${caseDef.id}: missing mismatch\n${JSON.stringify(report, null, 2)}`
    );
  }
  if (exp.questionMatch) {
    assert.match(
      sketch.selectedQuestion || "",
      exp.questionMatch,
      `${caseDef.id}: question mismatch\n${JSON.stringify(report, null, 2)}`
    );
  }
  if (exp.questionMustNotMatch) {
    assert.doesNotMatch(
      sketch.selectedQuestion || "",
      exp.questionMustNotMatch,
      `${caseDef.id}: forbidden question\n${JSON.stringify(report, null, 2)}`
    );
  }
  if (exp.mustNotCommitType) {
    assert.equal(
      shouldCommitAgentType(sketch.agentTypeConfidence, []),
      false,
      `${caseDef.id}: should not commit type\n${JSON.stringify(report, null, 2)}`
    );
  }
  if (exp.mustNotCreate) {
    assert.equal(
      sketch.createsNewCapability,
      false,
      `${caseDef.id}: should not create new capability\n${JSON.stringify(report, null, 2)}`
    );
    assert.equal(sketch.modifiesExisting, true);
  }
  if (exp.recognizesExisting) {
    assert.ok(
      sketch.existingAgentReferenced,
      `${caseDef.id}: did not recognize existing agent\n${JSON.stringify(report, null, 2)}`
    );
  }
  if (exp.executable === true) {
    assert.equal(
      sketch.missionExecutable,
      true,
      `${caseDef.id}: expected executable\n${JSON.stringify(report, null, 2)}`
    );
    assert.equal(
      sketch.selectedQuestion,
      null,
      `${caseDef.id}: should stop asking when executable\n${JSON.stringify(report, null, 2)}`
    );
  }
  if (exp.executable === false) {
    assert.equal(
      sketch.missionExecutable,
      false,
      `${caseDef.id}: expected not executable\n${JSON.stringify(report, null, 2)}`
    );
    assert.ok(
      sketch.selectedQuestion,
      `${caseDef.id}: expected a clarifying question\n${JSON.stringify(report, null, 2)}`
    );
  }
  if (exp.mustNotAskPeopleOrPlatforms) {
    assert.ok(!sketch.missing.includes("people to monitor"));
    assert.ok(!sketch.missing.includes("platforms to monitor"));
  }
  if (exp.mustNotOverInterviewPreferences) {
    assert.ok(!sketch.missing.some((gap) => PREFERENCE_RE.test(gap)));
  }

  // Emit capture for CI logs / manual review
  console.info(`[ceo-acceptance] ${caseDef.id}\n${JSON.stringify(report, null, 2)}`);
  return report;
}

test("CEO acceptance suite size is in range (25–50)", () => {
  assert.ok(CASES.length >= 25, `expected >= 25 cases, got ${CASES.length}`);
  assert.ok(CASES.length <= 50, `expected <= 50 cases, got ${CASES.length}`);
  const categories = new Set(CASES.map((c) => c.category));
  for (const required of ["agent_creation", "existing_changes", "ambiguous", "complete"]) {
    assert.ok(categories.has(required), `missing category ${required}`);
  }
});

for (const caseDef of CASES) {
  test(`CEO acceptance ${caseDef.id} [${caseDef.category}]`, () => {
    runCase(caseDef);
  });
}
