import test from "node:test";
import assert from "node:assert/strict";
import { registerFormTools } from "../resources/extensions/browser-tools/forms.ts";
import { registerIntentTools } from "../resources/extensions/browser-tools/intent.ts";

function makeStubApi() {
  const tools: string[] = [];
  return {
    tools,
    api: {
      registerTool(definition: { name: string }) {
        tools.push(definition.name);
      },
    },
  };
}

const stubDeps = {
  ensureBrowser: async () => ({ page: {} }),
  getActiveTarget: () => ({}),
  getActivePageOrNull: () => null,
  captureCompactPageState: async () => ({}),
  beginTrackedAction: () => ({ id: 1 }),
  finishTrackedAction: () => {},
  settleAfterActionAdaptive: async () => ({}),
  postActionSummary: async () => "",
  getRecentErrors: () => "",
  diffCompactStates: () => ({ summary: "", changed: false }),
  formatDiffText: () => "",
  verificationFromChecks: () => ({ verificationSummary: "" }),
  verificationLine: () => "",
  captureErrorScreenshot: async () => null,
};

test("browser tools register form and intent helpers", () => {
  const { api, tools } = makeStubApi();
  registerFormTools(api as any, stubDeps as any);
  registerIntentTools(api as any, stubDeps as any);
  assert.deepEqual(tools, [
    "browser_analyze_form",
    "browser_fill_form",
    "browser_find_best",
    "browser_act",
  ]);
});
