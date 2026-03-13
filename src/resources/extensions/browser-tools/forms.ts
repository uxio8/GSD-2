import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Frame, Page } from "playwright";

interface FormFieldInfo {
  type: string;
  name: string;
  id: string;
  label: string;
  required: boolean;
  value: string;
  checked?: boolean;
  options?: Array<{ value: string; label: string; selected: boolean }>;
  validation: { valid: boolean; message: string };
  hidden: boolean;
  disabled: boolean;
  group?: string;
}

interface FormSubmitButton {
  tag: string;
  type: string;
  text: string;
  name: string;
  disabled: boolean;
}

interface FormAnalysisResult {
  formSelector: string;
  fields: FormFieldInfo[];
  submitButtons: FormSubmitButton[];
  fieldCount: number;
  visibleFieldCount: number;
}

interface BrowserToolDeps {
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
  verificationFromChecks(checks: Array<Record<string, unknown>>, retryHint?: string): { verificationSummary: string; [key: string]: unknown };
  verificationLine(verification: { verificationSummary: string; [key: string]: unknown }): string;
  captureErrorScreenshot(page: Page | null): Promise<any>;
}

function escapeCssAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function buildFormAnalysisScript(selector?: string): string {
  return `(() => {
    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
      return true;
    }

    function humanizeName(name) {
      if (!name) return "";
      return name
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_\\-]+/g, " ")
        .replace(/\\bid\\b/i, "ID")
        .trim()
        .replace(/^./, c => c.toUpperCase());
    }

    function getTextContent(el) {
      if (!el) return "";
      return (el.textContent || "").trim().replace(/\\s+/g, " ");
    }

    function resolveLabel(field) {
      const labelledBy = field.getAttribute("aria-labelledby");
      if (labelledBy) {
        const parts = labelledBy.split(/\\s+/).map(id => {
          const el = document.getElementById(id);
          return el ? getTextContent(el) : "";
        }).filter(Boolean);
        if (parts.length) return parts.join(" ");
      }

      const ariaLabel = field.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

      if (field.id) {
        const labelFor = document.querySelector('label[for="' + CSS.escape(field.id) + '"]');
        if (labelFor) {
          const text = getTextContent(labelFor);
          if (text) return text;
        }
      }

      const wrappingLabel = field.closest("label");
      if (wrappingLabel) {
        const clone = wrappingLabel.cloneNode(true);
        const inputs = clone.querySelectorAll("input, select, textarea");
        inputs.forEach(inp => inp.remove());
        const text = (clone.textContent || "").trim().replace(/\\s+/g, " ");
        if (text) return text;
      }

      const placeholder = field.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return placeholder.trim();

      const title = field.getAttribute("title");
      if (title && title.trim()) return title.trim();

      const name = field.getAttribute("name");
      if (name) return humanizeName(name);

      return "";
    }

    let form;
    const selectorArg = ${JSON.stringify(selector ?? null)};
    if (selectorArg) {
      form = document.querySelector(selectorArg);
      if (!form) return { error: "Form not found for selector: " + selectorArg };
    } else {
      const forms = Array.from(document.querySelectorAll("form"));
      if (forms.length === 1) {
        form = forms[0];
      } else if (forms.length > 1) {
        let best = null;
        let bestCount = -1;
        for (const f of forms) {
          const inputs = f.querySelectorAll("input, select, textarea");
          let visibleCount = 0;
          inputs.forEach(inp => { if (isVisible(inp)) visibleCount++; });
          if (visibleCount > bestCount) {
            bestCount = visibleCount;
            best = f;
          }
        }
        form = best;
      } else {
        form = document.body;
      }
    }

    let formSelector = "body";
    if (form !== document.body) {
      if (form.id) {
        formSelector = "#" + CSS.escape(form.id);
      } else if (form.getAttribute("name")) {
        formSelector = 'form[name="' + form.getAttribute("name") + '"]';
      } else if (form.getAttribute("action")) {
        formSelector = 'form[action="' + form.getAttribute("action") + '"]';
      } else {
        const allForms = Array.from(document.querySelectorAll("form"));
        const index = allForms.indexOf(form);
        formSelector = index >= 0 ? "form:nth-of-type(" + (index + 1) + ")" : "form";
      }
    }

    const fieldElements = form.querySelectorAll("input, select, textarea");
    const fields = [];
    fieldElements.forEach(field => {
      const tag = field.tagName.toLowerCase();
      const type = tag === "select"
        ? "select"
        : tag === "textarea"
          ? "textarea"
          : (field.getAttribute("type") || "text").toLowerCase();

      if (tag === "input" && ["submit", "button", "reset", "image"].includes(type)) return;

      const info = {
        type,
        name: field.getAttribute("name") || "",
        id: field.id || "",
        label: resolveLabel(field),
        required: field.required || field.getAttribute("aria-required") === "true",
        value: tag === "select"
          ? ((field.querySelector("option:checked") || {}).value || "")
          : (field.value || ""),
        hidden: type === "hidden" || !isVisible(field),
        disabled: field.disabled,
        validation: {
          valid: field.validity ? field.validity.valid : true,
          message: field.validationMessage || "",
        },
      };

      if (type === "checkbox" || type === "radio") {
        info.checked = field.checked;
      }

      if (tag === "select") {
        info.options = Array.from(field.querySelectorAll("option")).map(opt => ({
          value: opt.value,
          label: (opt.textContent || "").trim(),
          selected: opt.selected,
        }));
      }

      const fieldset = field.closest("fieldset");
      if (fieldset) {
        const legend = fieldset.querySelector("legend");
        if (legend) info.group = getTextContent(legend);
      }

      fields.push(info);
    });

    const submitButtons = Array.from(form.querySelectorAll('button, input[type="submit"]')).map(btn => ({
      tag: btn.tagName.toLowerCase(),
      type: (btn.getAttribute("type") || "").toLowerCase(),
      text: (btn.textContent || btn.getAttribute("value") || "").trim().replace(/\\s+/g, " "),
      name: btn.getAttribute("name") || "",
      disabled: btn.disabled,
    }));

    return {
      formSelector,
      fields,
      submitButtons,
      fieldCount: fields.length,
      visibleFieldCount: fields.filter(field => !field.hidden).length,
    };
  })()`;
}

function buildPostFillValidationScript(formSelector: string): string {
  return `(() => {
    const form = ${JSON.stringify(formSelector)} === "body"
      ? document.body
      : document.querySelector(${JSON.stringify(formSelector)});
    if (!form) return { valid: false, validCount: 0, invalidCount: 0, invalidFields: [] };

    const fieldEls = form.querySelectorAll("input, select, textarea");
    const invalidFields = [];
    let validCount = 0;

    fieldEls.forEach(field => {
      const tag = field.tagName.toLowerCase();
      const type = tag === "select" ? "select" : (field.getAttribute("type") || "text").toLowerCase();
      if (tag === "input" && ["submit", "button", "reset", "image", "hidden"].includes(type)) return;
      if (field.validity && !field.validity.valid) {
        invalidFields.push({
          name: field.getAttribute("name") || field.id || type,
          message: field.validationMessage || "Invalid field",
        });
      } else {
        validCount++;
      }
    });

    return {
      valid: invalidFields.length === 0,
      validCount,
      invalidCount: invalidFields.length,
      invalidFields,
    };
  })()`;
}

export function registerFormTools(pi: ExtensionAPI, deps: BrowserToolDeps): void {
  pi.registerTool({
    name: "browser_analyze_form",
    label: "Analyze Form",
    description:
      "Analyze a form on the current page and return a structured field inventory. Auto-detects the primary form when no selector is provided.",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({
        description: "CSS selector targeting the form element to analyze. If omitted, auto-detects the primary form on the page.",
      })),
    }),
    async execute(_toolCallId, params) {
      let actionId: number | null = null;
      let beforeState: any = null;
      try {
        const { page } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        beforeState = await deps.captureCompactPageState(page, { includeBodyText: true, target });
        actionId = deps.beginTrackedAction("browser_analyze_form", params, beforeState.url).id;
        const result = await target.evaluate(buildFormAnalysisScript(params.selector)) as FormAnalysisResult & { error?: string };
        if (result.error) throw new Error(result.error);
        deps.finishTrackedAction(actionId, {
          status: "success",
          afterUrl: beforeState.url,
          beforeState,
          afterState: beforeState,
          verificationSummary: `Found ${result.fieldCount} fields`,
        });

        const lines = [
          `Form: ${result.formSelector}`,
          `Fields: ${result.fieldCount} total, ${result.visibleFieldCount} visible`,
          "",
        ];

        for (const field of result.fields) {
          const bits = [
            field.type,
            field.required ? "required" : "optional",
            field.hidden ? "hidden" : "visible",
            field.disabled ? "disabled" : "enabled",
          ];
          lines.push(`- ${field.label || field.name || field.id || "(unnamed)"} [${bits.join(", ")}]`);
          if (field.validation.message) lines.push(`  validation: ${field.validation.message}`);
        }

        if (result.submitButtons.length > 0) {
          lines.push("", "Submit buttons:");
          for (const button of result.submitButtons) {
            lines.push(`- ${button.text || "(unnamed)"} [${button.type || button.tag}]${button.disabled ? " disabled" : ""}`);
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { formAnalysis: result, actionId },
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
        const content: any[] = [{ type: "text", text: `browser_analyze_form failed: ${err.message}` }];
        if (errorShot) content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        return { content, details: { error: err.message }, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "browser_fill_form",
    label: "Fill Form",
    description:
      "Fill a form using a values mapping. Keys can match label text, name, placeholder, or aria-label. Optionally submits the form after filling.",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({
        description: "CSS selector targeting the form element. If omitted, auto-detects the primary form.",
      })),
      values: Type.Record(Type.String(), Type.String(), {
        description: "Mapping of field identifier -> value. Identifiers resolve by label, name, placeholder, or aria-label.",
      }),
      submit: Type.Optional(Type.Boolean({
        description: "If true, clicks the form's submit button after filling all fields.",
      })),
    }),
    async execute(_toolCallId, params) {
      let actionId: number | null = null;
      let beforeState: any = null;
      try {
        const { page } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        beforeState = await deps.captureCompactPageState(page, { includeBodyText: true, target });
        actionId = deps.beginTrackedAction("browser_fill_form", params, beforeState.url).id;

        const formSelector = params.selector ?? await target.evaluate(`(() => {
          const forms = Array.from(document.querySelectorAll("form"));
          if (forms.length === 1) {
            const form = forms[0];
            if (form.id) return "#" + CSS.escape(form.id);
            if (form.getAttribute("name")) return 'form[name="' + form.getAttribute("name") + '"]';
            return "form";
          }
          if (forms.length > 1) {
            let best = forms[0];
            let bestIndex = 0;
            let bestCount = -1;
            for (let i = 0; i < forms.length; i++) {
              const inputs = forms[i].querySelectorAll("input, select, textarea");
              let visible = 0;
              inputs.forEach((input) => {
                const style = window.getComputedStyle(input);
                if (style.display !== "none" && style.visibility !== "hidden" && (input.offsetWidth || input.offsetHeight)) visible++;
              });
              if (visible > bestCount) {
                best = forms[i];
                bestIndex = i;
                bestCount = visible;
              }
            }
            if (best.id) return "#" + CSS.escape(best.id);
            if (best.getAttribute("name")) return 'form[name="' + best.getAttribute("name") + '"]';
            return "form:nth-of-type(" + (bestIndex + 1) + ")";
          }
          return "body";
        })()`);

        const formLocator = formSelector === "body" ? target.locator("body") : target.locator(formSelector);

        interface MatchedField {
          key: string;
          value: string;
          resolvedBy: string;
          fieldType: string;
        }
        interface UnmatchedField {
          key: string;
        }
        interface SkippedField {
          key: string;
          reason: string;
        }

        const matched: MatchedField[] = [];
        const unmatched: UnmatchedField[] = [];
        const skipped: SkippedField[] = [];

        for (const [key, value] of Object.entries(params.values)) {
          let resolvedLocator: ReturnType<typeof formLocator.locator> | null = null;
          let resolvedBy = "";

          try {
            const loc = formLocator.getByLabel(key, { exact: true });
            const count = await loc.count();
            if (count === 1) {
              resolvedLocator = loc;
              resolvedBy = "label (exact)";
            } else if (count > 1) {
              skipped.push({ key, reason: `Ambiguous: ${count} fields match label "${key}"` });
              continue;
            }
          } catch {}

          if (!resolvedLocator) {
            try {
              const loc = formLocator.getByLabel(key);
              const count = await loc.count();
              if (count === 1) {
                resolvedLocator = loc;
                resolvedBy = "label";
              } else if (count > 1) {
                skipped.push({ key, reason: `Ambiguous: ${count} fields match label "${key}"` });
                continue;
              }
            } catch {}
          }

          if (!resolvedLocator) {
            const loc = formLocator.locator(`[name="${escapeCssAttributeValue(key)}"]`);
            const count = await loc.count();
            if (count === 1) {
              resolvedLocator = loc;
              resolvedBy = "name";
            } else if (count > 1) {
              skipped.push({ key, reason: `Ambiguous: ${count} fields match name="${key}"` });
              continue;
            }
          }

          if (!resolvedLocator) {
            const loc = formLocator.locator(`[placeholder="${escapeCssAttributeValue(key)}" i]`);
            const count = await loc.count();
            if (count === 1) {
              resolvedLocator = loc;
              resolvedBy = "placeholder";
            } else if (count > 1) {
              skipped.push({ key, reason: `Ambiguous: ${count} fields match placeholder="${key}"` });
              continue;
            }
          }

          if (!resolvedLocator) {
            const loc = formLocator.locator(`[aria-label="${escapeCssAttributeValue(key)}" i]`);
            const count = await loc.count();
            if (count === 1) {
              resolvedLocator = loc;
              resolvedBy = "aria-label";
            } else if (count > 1) {
              skipped.push({ key, reason: `Ambiguous: ${count} fields match aria-label="${key}"` });
              continue;
            }
          }

          if (!resolvedLocator) {
            unmatched.push({ key });
            continue;
          }

          const fieldType = await resolvedLocator.first().evaluate((element) => {
            const tag = element.tagName.toLowerCase();
            if (tag === "select") return "select";
            if (tag === "textarea") return "textarea";
            return (element.getAttribute("type") || "text").toLowerCase();
          });

          if (fieldType === "hidden" || fieldType === "file") {
            skipped.push({ key, reason: `Unsupported field type: ${fieldType}` });
            continue;
          }

          try {
            if (fieldType === "select") {
              try {
                await resolvedLocator.first().selectOption({ label: value }, { timeout: 5000 });
              } catch {
                await resolvedLocator.first().selectOption({ value }, { timeout: 5000 });
              }
            } else if (fieldType === "checkbox" || fieldType === "radio") {
              await resolvedLocator.first().setChecked(["true", "1", "yes", "on"].includes(value.toLowerCase()), { timeout: 5000 });
            } else {
              await resolvedLocator.first().fill(value, { timeout: 5000 });
            }
            matched.push({ key, value, resolvedBy, fieldType });
          } catch (fillErr: any) {
            skipped.push({ key, reason: `Fill failed: ${String(fillErr?.message ?? fillErr).split("\n")[0]}` });
          }
        }

        const settle = await deps.settleAfterActionAdaptive(page);

        let submitted = false;
        if (params.submit) {
          const submitLoc = formLocator.locator('[type="submit"], button:not([type]), button[type="submit"]').first();
          if (await submitLoc.count()) {
            await submitLoc.click({ timeout: 5000 });
            submitted = true;
          } else {
            skipped.push({ key: "_submit", reason: "No submit button found in form" });
          }
        }

        const validation = await target.evaluate(buildPostFillValidationScript(formSelector)) as {
          valid: boolean;
          validCount: number;
          invalidCount: number;
          invalidFields: Array<{ name: string; message: string }>;
        };

        const summary = await deps.postActionSummary(page, target);
        const jsErrors = deps.getRecentErrors(page.url());
        const afterState = await deps.captureCompactPageState(page, { includeBodyText: true, target });
        const diff = deps.diffCompactStates(beforeState, afterState);
        const verification = deps.verificationFromChecks(
          [
            { name: "matched_any_fields", passed: matched.length > 0, value: matched.length, expected: "> 0" },
            { name: "validation_after_fill", passed: validation.valid || validation.invalidCount === 0, value: validation.invalidCount, expected: 0 },
          ],
          "Inspect unmatched or skipped fields and retry with exact labels or names.",
        );

        deps.finishTrackedAction(actionId, {
          status: "success",
          afterUrl: afterState.url,
          verificationSummary: verification.verificationSummary,
          warningSummary: jsErrors.trim() || undefined,
          diffSummary: diff.summary,
          changed: diff.changed,
          beforeState,
          afterState,
        });

        const lines = [
          `Form: ${formSelector}`,
          `Filled: ${matched.length} | Unmatched: ${unmatched.length} | Skipped: ${skipped.length}${submitted ? " | Submitted: yes" : ""}`,
          deps.verificationLine(verification),
        ];
        if (unmatched.length > 0) {
          lines.push("", "Unmatched fields:");
          for (const field of unmatched) lines.push(`- ${field.key}`);
        }
        if (skipped.length > 0) {
          lines.push("", "Skipped fields:");
          for (const field of skipped) lines.push(`- ${field.key}: ${field.reason}`);
        }
        if (validation.invalidFields.length > 0) {
          lines.push("", "Validation errors:");
          for (const field of validation.invalidFields) lines.push(`- ${field.name}: ${field.message}`);
        }
        if (jsErrors) lines.push("", jsErrors);
        lines.push("", "Diff:", deps.formatDiffText(diff), "", "Page summary:", summary);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { fillResult: { matched, unmatched, skipped, submitted, validation, formSelector }, actionId, diff, ...settle, ...verification },
          isError: matched.length === 0,
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
        const content: any[] = [{ type: "text", text: `browser_fill_form failed: ${err.message}` }];
        if (errorShot) content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        return { content, details: { error: err.message }, isError: true };
      }
    },
  });
}
