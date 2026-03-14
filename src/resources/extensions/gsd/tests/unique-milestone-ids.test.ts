import {
  MILESTONE_ID_RE,
  extractMilestoneSeq,
  generateMilestonePrefix,
  maxMilestoneNum,
  milestoneIdSort,
  nextMilestoneId,
  normalizeMilestoneId,
  parseMilestoneId,
  stripMilestoneTitlePrefix,
} from "../milestone-ids.ts";
import { parseContextDependsOn } from "../files.ts";
import { renderPreferencesForSystemPrompt } from "../preferences.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  console.log("\n=== milestone ID primitives ===");
  assert(MILESTONE_ID_RE.test("M001"), "classic milestone ID matches");
  assert(MILESTONE_ID_RE.test("M001-abc123"), "unique milestone ID matches");
  assert(!MILESTONE_ID_RE.test("M1"), "short milestone ID rejected");
  assert(!MILESTONE_ID_RE.test("M001-ABC123"), "uppercase unique suffix rejected");

  assertEq(normalizeMilestoneId("m001"), "M001", "normalize classic milestone ID");
  assertEq(normalizeMilestoneId("m001-AbC123"), "M001-abc123", "normalize unique milestone ID");
  assertEq(normalizeMilestoneId("notes"), "notes", "leave non-milestone strings untouched");

  assertEq(extractMilestoneSeq("M042"), 42, "extract sequence from classic ID");
  assertEq(extractMilestoneSeq("M042-abc123"), 42, "extract sequence from unique ID");
  assertEq(parseMilestoneId("M042"), { num: 42 }, "parse classic milestone ID");
  assertEq(parseMilestoneId("M042-abc123"), { prefix: "abc123", num: 42 }, "parse unique milestone ID");
  assertEq(parseMilestoneId("notes"), { num: 0 }, "invalid IDs parse to num 0");

  const prefixA = generateMilestonePrefix();
  const prefixB = generateMilestonePrefix();
  assert(/^[a-z0-9]{6}$/.test(prefixA), "generated prefix format is correct");
  assert(prefixA !== prefixB, "generated prefixes are not repeated back-to-back");

  assertEq(maxMilestoneNum([]), 0, "empty milestone list has max 0");
  assertEq(maxMilestoneNum(["M001", "M010-abc123", "notes"]), 10, "max milestone number ignores non-matches");
  assertEq(nextMilestoneId(["M001", "M010-abc123"]), "M011", "next classic milestone ID uses numeric max");
  assert(/^M011-[a-z0-9]{6}$/.test(nextMilestoneId(["M001", "M010-abc123"], true)), "next unique milestone ID adds suffix");

  assertEq(
    ["M010-bbbbbb", "M002", "M010-aaaaaa", "M001"].sort(milestoneIdSort),
    ["M001", "M002", "M010-aaaaaa", "M010-bbbbbb"],
    "milestone sort is stable across mixed classic/unique IDs",
  );
  assertEq(stripMilestoneTitlePrefix("M010-abc123: Demo"), "Demo", "strip unique milestone prefix from title");

  console.log("\n=== depends_on normalization ===");
  assertEq(
    parseContextDependsOn("---\ndepends_on:\n  - m001\n  - m002-AbC123\n---\n"),
    ["M001", "M002-abc123"],
    "depends_on normalization preserves unique milestone suffixes",
  );

  console.log("\n=== preferences validation ===");
  const rendered = renderPreferencesForSystemPrompt({ version: 1, unique_milestone_ids: true });
  assert(!rendered.includes("some preference values were ignored"), "unique_milestone_ids validates cleanly");

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
