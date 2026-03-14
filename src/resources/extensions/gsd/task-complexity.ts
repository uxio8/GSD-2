import type { RiskLevel } from './types.ts'

import { extractSection, loadFile, parseRoadmap } from './files.ts'
import { resolveMilestoneFile, resolveTaskFile } from './paths.js'

export type TaskComplexity = 'simple' | 'media' | 'alta'
export type TaskComplexitySliceRisk = RiskLevel | 'unknown'

interface ClassifyTaskComplexityInput {
  taskTitle: string
  taskPlanContent: string | null | undefined
  sliceRisk: TaskComplexitySliceRisk
}

export function classifyTaskComplexity({
  taskTitle,
  taskPlanContent,
  sliceRisk,
}: ClassifyTaskComplexityInput): TaskComplexity {
  const content = taskPlanContent ?? ''
  const estimatedSteps = parseFrontmatterNumber(content, 'estimated_steps')
  const estimatedFiles = parseFrontmatterNumber(content, 'estimated_files')
  let score = 0

  if (sliceRisk === 'high') score += 1.5
  else if (sliceRisk === 'medium') score += 0.5

  if ((estimatedSteps ?? 0) >= 10 || (estimatedFiles ?? 0) >= 12) score += 2
  else if ((estimatedSteps ?? 0) >= 7 || (estimatedFiles ?? 0) >= 8) score += 1

  if (hasSection(content, 'Observability Impact')) score += 1
  if (textSuggestsHigherReasoning(`${taskTitle}\n${content}`)) score += 1

  if (score >= 3) return 'alta'
  if (score >= 1.5) return 'media'
  return 'simple'
}

export async function resolveSliceRisk(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): Promise<TaskComplexitySliceRisk> {
  const roadmapFile = resolveMilestoneFile(basePath, milestoneId, 'ROADMAP')
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null
  if (!roadmapContent) return 'unknown'

  const roadmap = parseRoadmap(roadmapContent)
  return roadmap.slices.find((slice) => slice.id === sliceId)?.risk ?? 'unknown'
}

export async function resolveTaskComplexity(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
  taskTitle: string,
): Promise<TaskComplexity> {
  const [sliceRisk, taskPlanContent] = await Promise.all([
    resolveSliceRisk(basePath, milestoneId, sliceId),
    loadTaskPlanContent(basePath, milestoneId, sliceId, taskId),
  ])

  return classifyTaskComplexity({
    taskTitle,
    taskPlanContent,
    sliceRisk,
  })
}

function parseFrontmatterNumber(content: string, key: string): number | null {
  const match = content.match(new RegExp(`^${key}:\\s*(\\d+)\\s*$`, 'm'))
  return match ? Number.parseInt(match[1], 10) : null
}

function hasSection(content: string, heading: string): boolean {
  return extractSection(content, heading, 2) !== null
}

function textSuggestsHigherReasoning(text: string): boolean {
  return /(browser|playwright|runtime|async|session|cross-host|integration|route|api|error path|webhook|stream|state|studio|preview|published|authority|observability|diagnostic)/i.test(text)
}

async function loadTaskPlanContent(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): Promise<string | null> {
  const taskPlanPath = resolveTaskFile(basePath, milestoneId, sliceId, taskId, 'PLAN')
  return taskPlanPath ? loadFile(taskPlanPath) : null
}
