// Barrel export for old .planning migration module

export { handleMigrate } from './command.ts';
export { parsePlanningDirectory } from './parser.ts';
export { validatePlanningDirectory } from './validator.ts';
export { transformToGSD } from './transformer.ts';
export { writeGSDDirectory } from './writer.ts';
export type { WrittenFiles, MigrationPreview } from './writer.ts';
export { generatePreview } from './preview.ts';
export type {
  // Input types (old .planning format)
  PlanningProject,
  PlanningPhase,
  PlanningPlan,
  PlanningPlanFrontmatter,
  PlanningPlanMustHaves,
  PlanningSummary,
  PlanningSummaryFrontmatter,
  PlanningSummaryRequires,
  PlanningRoadmap,
  PlanningRoadmapMilestone,
  PlanningRoadmapEntry,
  PlanningRequirement,
  PlanningResearch,
  PlanningConfig,
  PlanningQuickTask,
  PlanningMilestone,
  PlanningState,
  PlanningPhaseFile,
  ValidationResult,
  ValidationIssue,
  ValidationSeverity,
  // Output types (GSD-2 format)
  GSDProject,
  GSDMilestone,
  GSDSlice,
  GSDTask,
  GSDRequirement,
  GSDSliceSummaryData,
  GSDTaskSummaryData,
  GSDBoundaryEntry,
} from './types.ts';
