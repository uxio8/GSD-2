import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { Frame, Page } from "playwright";

const INTENTS = [
  "submit_form",
  "close_dialog",
  "primary_cta",
  "search_field",
  "next_step",
  "dismiss",
  "auth_action",
  "back_navigation",
] as const;

interface IntentCandidate {
  score: number;
  selector: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  reason: string;
}

interface IntentScoringResult {
  intent: string;
  normalized: string;
  count: number;
  candidates: IntentCandidate[];
  error?: string;
}

interface BrowserIntentDeps {
  ensureBrowser(): Promise<{ page: Page }>;
  getActiveTarget(): Page | Frame;
  getActivePageOrNull(): Page | null;
  captureCompactPageState(page: Page, options: Record<string, unknown>): Promise<any>;
  beginTrackedAction(tool: string, params: unknown, beforeUrl: string): { id: number };
  finishTrackedAction(actionId: number, details: Record<string, unknown>): void;
  settleAfterActionAdaptive(page: Page): Promise<Record<string, unknown>>;
  postActionSummary(page: Page, target?: Page | Frame): Promise<string>;
  getRecentErrors(pageUrl: string): string;
  diffCompactStates(beforeState: any, afterState: any): { summary: string; changed: boolean; [key: string]: unknown };
  formatDiffText(diff: { summary: string; changed: boolean; [key: string]: unknown }): string;
  captureErrorScreenshot(page: Page | null): Promise<any>;
}

function buildIntentScoringScript(intent: string, scope?: string): string {
  const scopeSelector = JSON.stringify(scope ?? null);
  return `(() => {
    var pi = window.__pi;
    if (!pi) return { error: "window.__pi not available — browser helpers not injected" };

    var intentRaw = ${JSON.stringify(intent)};
    var normalized = intentRaw.toLowerCase().replace(/[\\s_\\-]+/g, "");
    var scopeSel = ${scopeSelector};
    var root = scopeSel ? document.querySelector(scopeSel) : document.body;
    if (!root) return { error: "Scope selector not found: " + scopeSel };

    function textOf(el) {
      return (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120).toLowerCase();
    }
    function clamp01(value) { return Math.max(0, Math.min(1, value)); }
    function qsa(sel) { return Array.from(root.querySelectorAll(sel)); }
    function visibleEnabled(el) { return pi.isVisible(el) && pi.isEnabled(el); }
    function textMatches(el, patterns) {
      var text = textOf(el);
      var name = (pi.accessibleName(el) || "").toLowerCase();
      var combined = text + " " + name;
      return patterns.some(function(pattern) { return combined.indexOf(pattern) !== -1; });
    }
    function textMatchStrength(el, patterns) {
      var text = textOf(el);
      var name = (pi.accessibleName(el) || "").toLowerCase();
      var combined = text + " " + name;
      var count = 0;
      for (var i = 0; i < patterns.length; i++) if (combined.indexOf(patterns[i]) !== -1) count++;
      return Math.min(count / Math.max(patterns.length, 1), 1);
    }
    function makeCandidate(el, score, reason) {
      return {
        score: Math.round(clamp01(score) * 100) / 100,
        selector: pi.cssPath(el),
        tag: el.tagName.toLowerCase(),
        role: pi.inferRole(el) || "",
        name: pi.accessibleName(el) || "",
        text: textOf(el).slice(0, 80),
        reason: reason,
      };
    }

    var candidates = [];

    if (normalized === "submitform") {
      var submitEls = qsa('button[type="submit"], input[type="submit"], button:not([type]), button[type="button"]');
      for (var i = 0; i < submitEls.length; i++) {
        var el = submitEls[i];
        if (!visibleEnabled(el)) continue;
        var d1 = el.type === "submit" || el.getAttribute("type") === "submit" ? 0.35 : 0;
        var d2 = el.closest("form") ? 0.3 : 0;
        var d3 = textMatches(el, ["submit", "send", "save", "create", "add", "post", "confirm", "ok", "done", "register", "sign up", "log in"]) ? 0.2 : 0;
        candidates.push(makeCandidate(el, d1 + d2 + d3 + 0.15, "submit-form"));
      }
    } else if (normalized === "closedialog") {
      var containers = qsa('[role="dialog"], dialog, [aria-modal="true"], [role="alertdialog"]');
      for (var ci = 0; ci < containers.length; ci++) {
        var btns = containers[ci].querySelectorAll("button, a, [role='button']");
        for (var bi = 0; bi < btns.length; bi++) {
          var el = btns[bi];
          if (!visibleEnabled(el)) continue;
          var ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
          var rect = el.getBoundingClientRect();
          var parentRect = containers[ci].getBoundingClientRect();
          var score = (textMatches(el, ["close", "cancel", "dismiss", "×", "✕", "x", "got it", "ok", "done"]) ? 0.35 : 0)
            + ((ariaLabel.indexOf("close") !== -1 || ariaLabel.indexOf("dismiss") !== -1) ? 0.25 : 0)
            + 0.2
            + ((rect.top - parentRect.top < 60 && parentRect.right - rect.right < 60) ? 0.2 : 0);
          candidates.push(makeCandidate(el, score, "close-dialog"));
        }
      }
    } else if (normalized === "primarycta") {
      var primaryEls = qsa("button, a, [role='button'], input[type='submit'], input[type='button']");
      for (var pii = 0; pii < primaryEls.length; pii++) {
        var el = primaryEls[pii];
        if (!visibleEnabled(el)) continue;
        var rect = el.getBoundingClientRect();
        var area = rect.width * rect.height;
        var isNegative = textMatches(el, ["cancel", "dismiss", "close", "skip", "no thanks", "maybe later"]);
        var score = clamp01(area / 12000) + (pi.inferRole(el) === "button" ? 0.25 : 0.15) + (isNegative ? 0 : 0.2) + (el.closest("main, [role='main'], article, section, .hero, .content") ? 0.15 : 0);
        candidates.push(makeCandidate(el, score, "primary-cta"));
      }
    } else if (normalized === "searchfield") {
      var searchEls = qsa("input, textarea, [role='searchbox'], [role='combobox'], [contenteditable='true']");
      for (var si = 0; si < searchEls.length; si++) {
        var el = searchEls[si];
        if (!pi.isVisible(el)) continue;
        var type = (el.getAttribute("type") || "text").toLowerCase();
        if (el.tagName.toLowerCase() === "input" && ["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "file"].indexOf(type) !== -1) continue;
        var combined = ((el.getAttribute("placeholder") || "") + " " + (el.getAttribute("name") || "") + " " + (el.getAttribute("aria-label") || "")).toLowerCase();
        var score = (type === "search" || pi.inferRole(el) === "searchbox" ? 0.4 : 0)
          + ((combined.indexOf("search") !== -1 || combined.indexOf("query") !== -1 || combined.indexOf("find") !== -1) ? 0.3 : 0)
          + (pi.isEnabled(el) ? 0.15 : 0)
          + (el.closest("header, nav, [role='banner'], [role='navigation'], [role='search']") ? 0.15 : 0);
        if (score >= 0.1) candidates.push(makeCandidate(el, score, "search-field"));
      }
    } else if (normalized === "nextstep") {
      var nextEls = qsa("button, a, [role='button'], input[type='submit'], input[type='button']");
      var nextPatterns = ["next", "continue", "proceed", "forward", "go", "step"];
      for (var ni = 0; ni < nextEls.length; ni++) {
        var el = nextEls[ni];
        if (!visibleEnabled(el)) continue;
        var score = textMatchStrength(el, nextPatterns) * 0.4 + (pi.inferRole(el) === "button" ? 0.25 : 0.1) + 0.35;
        if (score > 0.4) candidates.push(makeCandidate(el, score, "next-step"));
      }
    } else if (normalized === "dismiss") {
      var dismissEls = qsa("button, a, [role='button'], [role='link']");
      var dismissPatterns = ["close", "cancel", "dismiss", "skip", "no thanks", "maybe later", "not now", "×", "✕"];
      for (var di = 0; di < dismissEls.length; di++) {
        var el = dismissEls[di];
        if (!visibleEnabled(el)) continue;
        var overlay = el.closest('[role="dialog"], dialog, [aria-modal="true"], [role="alertdialog"], .modal, .overlay, .popup, .popover, .toast, .banner');
        var score = textMatchStrength(el, dismissPatterns) * 0.35 + (overlay ? 0.3 : 0.05) + 0.3;
        if (score > 0.35) candidates.push(makeCandidate(el, score, "dismiss-action"));
      }
    } else if (normalized === "authaction") {
      var authEls = qsa("button, a, [role='button'], [role='link'], input[type='submit']");
      var authPatterns = ["log in", "login", "sign in", "signin", "sign up", "signup", "register", "create account", "join", "get started"];
      for (var ai = 0; ai < authEls.length; ai++) {
        var el = authEls[ai];
        if (!visibleEnabled(el)) continue;
        var rect = el.getBoundingClientRect();
        var score = textMatchStrength(el, authPatterns) * 0.4 + 0.25 + ((el.closest("header, nav, [role='banner'], [role='navigation']") || rect.top < 200) ? 0.2 : 0.05) + 0.15;
        if (score > 0.4) candidates.push(makeCandidate(el, score, "auth-action"));
      }
    } else if (normalized === "backnavigation") {
      var backEls = qsa("button, a, [role='button'], [role='link']");
      var backPatterns = ["back", "previous", "go back", "return"];
      for (var bi2 = 0; bi2 < backEls.length; bi2++) {
        var el = backEls[bi2];
        if (!visibleEnabled(el)) continue;
        var score = textMatchStrength(el, backPatterns) * 0.5 + 0.3;
        if (score > 0.35) candidates.push(makeCandidate(el, score, "back-navigation"));
      }
    } else {
      return { error: "Unknown intent: " + intentRaw + ". Valid: submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation" };
    }

    candidates.sort(function(a, b) { return b.score - a.score; });
    candidates = candidates.slice(0, 5);
    return { intent: intentRaw, normalized: normalized, count: candidates.length, candidates: candidates };
  })()`;
}

export function registerIntentTools(pi: ExtensionAPI, deps: BrowserIntentDeps): void {
  pi.registerTool({
    name: "browser_find_best",
    label: "Browser Find Best",
    description:
      "Find the best matching element for a semantic intent. Returns up to 5 scored candidates ranked by role, text signals, structure, and visibility.",
    parameters: Type.Object({
      intent: StringEnum(INTENTS, {
        description: "Semantic intent: submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation",
      }),
      scope: Type.Optional(Type.String({
        description: "Optional CSS selector limiting the search scope.",
      })),
    }),
    async execute(_toolCallId, params) {
      try {
        await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const result = await target.evaluate(buildIntentScoringScript(params.intent, params.scope)) as IntentScoringResult;
        if (result.error) throw new Error(result.error);
        const lines = [`Intent: ${params.intent} -> ${result.count} candidate(s)`];
        if (result.count === 0) {
          lines.push("", "No candidates found for this intent on the current page.");
        } else {
          for (const candidate of result.candidates) {
            lines.push(`- ${candidate.selector} | score=${candidate.score} | ${candidate.role || candidate.tag} | ${candidate.name || candidate.text || "(unnamed)"} | ${candidate.reason}`);
          }
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { intentResult: result },
          isError: result.count === 0,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `browser_find_best failed: ${err.message}` }],
          details: { error: err.message },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "browser_act",
    label: "Browser Act",
    description:
      "Execute a semantic browser action in one call. Resolves the best candidate for the intent, acts on it, settles the page, and returns a before/after diff.",
    parameters: Type.Object({
      intent: StringEnum(INTENTS, {
        description: "Semantic intent: submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation",
      }),
      scope: Type.Optional(Type.String({
        description: "Optional CSS selector limiting candidate discovery.",
      })),
    }),
    async execute(_toolCallId, params) {
      let actionId: number | null = null;
      let beforeState: any = null;
      try {
        const { page } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        beforeState = await deps.captureCompactPageState(page, { includeBodyText: true, target });
        actionId = deps.beginTrackedAction("browser_act", params, beforeState.url).id;

        const result = await target.evaluate(buildIntentScoringScript(params.intent, params.scope)) as IntentScoringResult;
        if (result.error) throw new Error(result.error);
        const top = result.candidates[0];
        if (!top) {
          return {
            content: [{ type: "text", text: `browser_act: No candidates found for intent "${params.intent}" on the current page.` }],
            details: { intentResult: result },
            isError: true,
          };
        }

        const normalizedIntent = params.intent.toLowerCase().replace(/[\s_-]+/g, "");
        const locator = target.locator(top.selector).first();
        if (normalizedIntent === "searchfield") {
          await locator.focus({ timeout: 5000 });
        } else {
          await locator.click({ timeout: 5000 });
        }

        const settle = await deps.settleAfterActionAdaptive(page);
        const afterState = await deps.captureCompactPageState(page, { includeBodyText: true, target });
        const diff = deps.diffCompactStates(beforeState, afterState);
        const summary = await deps.postActionSummary(page, target);
        const jsErrors = deps.getRecentErrors(page.url());

        deps.finishTrackedAction(actionId, {
          status: "success",
          afterUrl: afterState.url,
          verificationSummary: `${normalizedIntent === "searchfield" ? "Focused" : "Clicked"} ${top.selector}`,
          warningSummary: jsErrors.trim() || undefined,
          diffSummary: diff.summary,
          changed: diff.changed,
          beforeState,
          afterState,
        });

        return {
          content: [{
            type: "text",
            text: `Intent: ${params.intent}\nAction: ${normalizedIntent === "searchfield" ? "focused" : "clicked"} top candidate (score: ${top.score})\nTarget: ${top.selector}${jsErrors ? `\n${jsErrors}` : ""}\n\nDiff:\n${deps.formatDiffText(diff)}\n\nPage summary:\n${summary}`,
          }],
          details: { intentResult: result, topCandidate: top, actionId, diff, ...settle },
        };
      } catch (err: any) {
        if (actionId !== null) {
          deps.finishTrackedAction(actionId, {
            status: "error",
            afterUrl: deps.getActivePageOrNull()?.url() ?? "",
            error: err.message,
            beforeState: beforeState ?? undefined,
          });
        }
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content: any[] = [{ type: "text", text: `browser_act failed: ${err.message}` }];
        if (errorShot) content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        return { content, details: { error: err.message }, isError: true };
      }
    },
  });
}
