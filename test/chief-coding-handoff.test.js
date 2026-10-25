import test from "node:test";
import assert from "node:assert/strict";

import { createCodingHandoff, taskAgentId } from "../server/chief/agents/codingHandoff.js";
import { createCodingHandoffTools } from "../server/chief/tools/codingHandoff.js";

const KEY = "cursor_test_key_value";
const REPO = "https://github.com/Freedomfarms/Forward-Freedom-Main";

function json(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test("the same requirements submit one Cursor task and a retry does not post again", async () => {
  const calls = [];
  const taskId = taskAgentId("user-a", "Add a comment to the response mode control.");
  let created = false;
  const handoff = createCodingHandoff({
    env: { CURSOR_API_KEY: KEY, CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main" },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body });
      if (init?.method === "POST") {
        const sent = JSON.parse(init.body);
        assert.equal(sent.autoCreatePR, true);
        assert.equal(sent.workOnCurrentBranch, false);
        assert.equal(sent.agentId, taskId);
        assert.equal(sent.repos[0].url, REPO);
        assert.equal(sent.repos[0].startingRef, "main");
        assert.match(sent.prompt.text, /ready for review/);
        assert.match(sent.prompt.text, /Do not merge/);
        assert.match(sent.prompt.text, /Do not deploy/);
        assert.match(sent.prompt.text, /unresolved limitations/);
        created = true;
        return json(200, {
          agent: { id: taskId },
          run: { id: "run-1234567890", status: "CREATING", agentId: taskId },
        });
      }
      if (!created) return json(404, { code: "not_found" });
      return json(200, {
        id: taskId,
        latestRunId: "run-1234567890",
        git: { branches: [{ branch: "cursor/response-mode", prUrl: "" }] },
      });
    },
  });

  const first = await handoff.submit({
    userId: "user-a",
    requirements: "Add a comment to the response mode control.",
  });
  assert.equal(first.available, true);
  assert.equal(first.taskId, taskId);
  assert.equal(first.duplicate, false);
  assert.equal(first.runId, "run-1234567890");
  assert.equal(first.merged, false);
  assert.equal(first.deployed, false);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);

  const second = await handoff.submit({
    userId: "user-a",
    requirements: "Add   a comment to the response mode control.",
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.taskId, taskId);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls.some((call) => String(call.url).includes("merge")), false);
  assert.equal(calls.some((call) => String(call.url).includes("deploy")), false);
});

test("status returns the pull request, diff, and checks, and a missing key does not call Cursor", async () => {
  const taskId = taskAgentId("user-a", "Add a comment to the response mode control.");
  const calls = [];
  const handoff = createCodingHandoff({
    env: {
      CURSOR_API_KEY: KEY,
      CHIEF_CODE_READ_TOKEN: "github_read_token_value",
      CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main",
    },
    fetchImpl: async (url) => {
      calls.push(String(url));
      const href = String(url);
      if (href.includes("api.cursor.com") && href.endsWith(`/v1/agents/${taskId}`)) {
        return json(200, { id: taskId, latestRunId: "run-1234567890" });
      }
      if (href.includes("/runs/run-1234567890")) {
        return json(200, {
          id: "run-1234567890",
          agentId: taskId,
          status: "FINISHED",
          result: "Opened the pull request.",
          git: {
            branches: [
              {
                branch: "cursor/response-mode",
                prUrl: "https://github.com/Freedomfarms/Forward-Freedom-Main/pull/321",
              },
            ],
          },
        });
      }
      if (href.includes("/compare/")) {
        return json(200, {
          ahead_by: 1,
          behind_by: 0,
          files: [
            {
              filename: "src/components/chief/ChiefResponseMode.jsx",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: '+const note = "review";\n',
            },
          ],
        });
      }
      if (href.includes("/check-runs")) {
        return json(200, {
          total_count: 1,
          check_runs: [{ name: "test", status: "completed", conclusion: "success" }],
        });
      }
      return json(404, {});
    },
  });
  const status = await handoff.status({ userId: "user-a", taskId });
  assert.equal(status.available, true);
  assert.equal(status.duplicate, false);
  assert.equal(status.pullRequestUrl, "https://github.com/Freedomfarms/Forward-Freedom-Main/pull/321");
  assert.equal(status.branch, "cursor/response-mode");
  assert.equal(status.diff.files[0].filename, "src/components/chief/ChiefResponseMode.jsx");
  assert.equal(status.checks.runs[0].conclusion, "success");
  assert.equal(status.merged, false);
  assert.equal(JSON.stringify(status).includes("github_read_token_value"), false);

  const callsBefore = calls.length;
  const missing = createCodingHandoff({ env: { CURSOR_API_KEY: "" } });
  const blocked = await missing.submit({ userId: "user-a", requirements: "Add a comment." });
  assert.equal(blocked.available, false);
  assert.equal(blocked.missing, "CURSOR_API_KEY");
  assert.equal(calls.length, callsBefore);

  const [submitTool] = createCodingHandoffTools({ handoff: missing });
  const toolResult = await submitTool.execute(
    { requirements: "Add a comment.", repository: "https://github.com/evil/other" },
    { userId: "user-a" }
  );
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.output, /unsupported coding task argument/);
});

test("a restart reuses the unfinished task, and a new attempt waits until it finishes", async () => {
  const requirements = "Add a comment to the response mode control.";
  const agents = new Map();
  const runs = new Map();
  let posts = 0;
  const fetchImpl = async (url, init) => {
    const href = String(url);
    if (init?.method === "POST") {
      const sent = JSON.parse(init.body);
      assert.equal(sent.autoCreatePR, true);
      assert.equal(sent.workOnCurrentBranch, false);
      if (agents.has(sent.agentId)) return json(409, { code: "agent_id_conflict" });
      posts += 1;
      const runId = `run-${posts}234567890`;
      agents.set(sent.agentId, { id: sent.agentId, latestRunId: runId });
      runs.set(runId, {
        id: runId,
        agentId: sent.agentId,
        status: "RUNNING",
        git: { branches: [] },
      });
      return json(200, {
        agent: { id: sent.agentId, latestRunId: runId },
        run: runs.get(runId),
      });
    }
    const runMatch = href.match(/\/runs\/([^/?]+)/);
    if (runMatch) {
      const run = runs.get(decodeURIComponent(runMatch[1]));
      return run ? json(200, run) : json(404, {});
    }
    const agentMatch = href.match(/\/v1\/agents\/([^/?]+)/);
    const agent = agentMatch ? agents.get(decodeURIComponent(agentMatch[1])) : null;
    return agent ? json(200, agent) : json(404, {});
  };
  const env = {
    CURSOR_API_KEY: KEY,
    CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main",
  };
  const first = createCodingHandoff({ env, fetchImpl });
  const second = createCodingHandoff({ env, fetchImpl });
  const [left, right] = await Promise.all([
    first.submit({ userId: "user-a", requirements }),
    second.submit({ userId: "user-a", requirements }),
  ]);
  assert.equal(left.available, true);
  assert.equal(right.available, true);
  assert.equal(left.taskId, right.taskId);
  assert.equal(agents.size, 1);
  assert.equal(posts, 1);

  const restarted = createCodingHandoff({ env, fetchImpl });
  const again = await restarted.submit({ userId: "user-a", requirements });
  assert.equal(again.duplicate, true);
  assert.equal(again.taskId, left.taskId);
  assert.equal(posts, 1);

  const blocked = await restarted.submit({
    userId: "user-a",
    requirements,
    newAttempt: true,
  });
  assert.equal(blocked.taskId, left.taskId);
  assert.equal(posts, 1);
  assert.match(blocked.limitations.join(" "), /still running/);

  const run = runs.values().next().value;
  run.status = "ERROR";
  const held = await restarted.submit({ userId: "user-a", requirements });
  assert.equal(held.duplicate, true);
  assert.equal(held.taskId, left.taskId);
  assert.equal(posts, 1);

  const [retryA, retryB] = await Promise.all([
    createCodingHandoff({ env, fetchImpl }).submit({
      userId: "user-a",
      requirements,
      newAttempt: true,
    }),
    createCodingHandoff({ env, fetchImpl }).submit({
      userId: "user-a",
      requirements,
      newAttempt: true,
    }),
  ]);
  assert.equal(retryA.available, true);
  assert.equal(retryB.available, true);
  assert.equal(retryA.taskId, retryB.taskId);
  assert.notEqual(retryA.taskId, left.taskId);
  assert.equal(agents.size, 2);
  assert.equal(posts, 2);
  assert.equal(retryA.merged, false);
  assert.equal(retryA.deployed, false);
});
