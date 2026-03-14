import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { MemoryStorage } from "./storage.js";

const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024;

const SECRET_PATTERNS = [
  /(?:sk|pk|api[_-]?key|token|secret|password|credential|auth)[_-]?\w*[\s:=]+['"]?[\w\-./+=]{20,}['"]?/gi,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9_]{36,}/g,
  /[rsp]k_(?:live|test)_[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  /(?:Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
  /npm_[A-Za-z0-9]{36,}/g,
  /sk-ant-[A-Za-z0-9\-_]{20,}/g,
  /sk-[A-Za-z0-9]{40,}/g,
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

export type LLMCallFn = (
  system: string,
  user: string,
  options?: { maxTokens?: number },
) => Promise<string>;

export interface PipelineConfig {
  sessionsDir: string;
  memoryDir: string;
  cwd: string;
  maxRolloutsPerStartup: number;
  maxRolloutAgeDays: number;
  minRolloutIdleHours: number;
  stage1Concurrency: number;
}

interface SessionFileInfo {
  threadId: string;
  filePath: string;
  fileSize: number;
  fileMtime: number;
}

async function readFirstLine(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    let settled = false;
    rl.on("line", (line) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(line);
    });
    rl.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    rl.on("close", () => {
      if (!settled) {
        settled = true;
        resolve("");
      }
    });
  });
}

async function scanSessionFiles(sessionsDir: string, cwd: string): Promise<SessionFileInfo[]> {
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const results: SessionFileInfo[] = [];
  const entries = readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    const dirPath = join(sessionsDir, entry.name);
    let files: string[] = [];
    try {
      files = readdirSync(dirPath).filter((file) => file.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(dirPath, file);
      try {
        const headerLine = await readFirstLine(filePath);
        if (!headerLine) continue;
        const header = JSON.parse(headerLine);
        if (header.type !== "session" || header.cwd !== cwd) {
          continue;
        }
        const stat = statSync(filePath);
        results.push({
          threadId: header.id,
          filePath,
          fileSize: stat.size,
          fileMtime: Math.floor(stat.mtimeMs),
        });
      } catch {
        // Skip malformed sessions.
      }
    }
  }

  return results;
}

function filterSessionContent(filePath: string): string {
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_SESSION_FILE_SIZE) {
      return "[]";
    }

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    const filtered: Array<{ role: string; content: string }> = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message") continue;
        const message = entry.message;
        if (!message) continue;
        const role = message.role;
        if (role !== "user" && role !== "assistant") continue;

        let text = "";
        if (typeof message.content === "string") {
          text = message.content;
        } else if (Array.isArray(message.content)) {
          text = message.content
            .filter((part: { type: string }) => part.type === "text")
            .map((part: { text: string }) => part.text)
            .join("\n");
        }

        if (!text.trim()) continue;
        if (text.length > 10_000) {
          text = `${text.slice(0, 10_000)}\n[...truncated]`;
        }

        filtered.push({ role, content: text });
      } catch {
        // Skip malformed lines.
      }
    }

    return JSON.stringify(filtered);
  } catch {
    return "[]";
  }
}

const PROMPTS = {
  stageOneSystem: `You are a memory extraction agent. Your task is to analyze a coding agent session transcript and extract durable, reusable knowledge.

## What to extract

Extract facts that would help a future session working on the same project:

1. Project architecture
2. Conventions
3. Key decisions
4. Environment setup
5. Gotchas and workarounds
6. User preferences

## What NOT to extract

- Transient task details
- Code snippets longer than 3 lines
- Information obvious from the codebase
- Secrets, API keys, tokens, or credentials

## Output format

Return a JSON array of memory objects:

\`\`\`json
[
  {
    "category": "architecture|convention|decision|environment|gotcha|preference",
    "content": "Clear, concise statement of the knowledge",
    "confidence": 0.0-1.0,
    "source_context": "Brief note on what in the session led to this extraction"
  }
]
\`\`\`

If the session contains no extractable durable knowledge, return [].
Be selective. Quality over quantity.`,
  stageOneInput: `## Session: {{thread_id}}

Analyze the following session transcript and extract durable knowledge.

<session_transcript>
{{response_items_json}}
</session_transcript>

Return ONLY the JSON array.`,
  consolidation: `Merge and deduplicate these extracted memories into a clean, organized markdown document.

## Tasks

1. Deduplicate
2. Resolve conflicts
3. Rank
4. Prune
5. Categorize

## Output format

Return a markdown document with:

# Project Memory

## Architecture
- item

## Conventions
- item

## Key Decisions
- item

## Environment
- item

## Gotchas
- item

## Preferences
- item

Only include sections with entries.
CRITICAL: Never include secrets, API keys, tokens, or credentials.

## Input memories

{{memories_json}}`,
  readPath: `## Project Memory (auto-extracted)

The following knowledge was automatically extracted from previous sessions working on this project. Use it to inform your responses, but verify against the actual codebase when making changes.

{{memory_content}}`,
} as const;

async function runPhase1(
  storage: MemoryStorage,
  config: PipelineConfig,
  llmCall: LLMCallFn,
  workerId: string,
): Promise<{ processed: number; errors: number }> {
  let processed = 0;
  let errors = 0;

  const jobs = storage.claimStage1Jobs(workerId, config.stage1Concurrency, 300);
  if (jobs.length === 0) {
    return { processed: 0, errors: 0 };
  }

  await Promise.all(jobs.map(async (job) => {
    try {
      const thread = storage.getThread(job.threadId);
      if (!thread) {
        storage.failStage1Job(job.threadId, "Thread not found");
        errors += 1;
        return;
      }

      const sessionContent = filterSessionContent(thread.file_path);
      if (sessionContent === "[]") {
        storage.completeStage1Job(job.threadId, "[]");
        processed += 1;
        return;
      }

      const userPrompt = PROMPTS.stageOneInput
        .replace("{{thread_id}}", job.threadId)
        .replace("{{response_items_json}}", sessionContent);
      const response = await llmCall(PROMPTS.stageOneSystem, userPrompt, { maxTokens: 4096 });
      const redacted = redactSecrets(response);

      try {
        JSON.parse(redacted);
        storage.completeStage1Job(job.threadId, redacted);
        processed += 1;
        return;
      } catch {
        const match = redacted.match(/\[[\s\S]*\]/);
        if (match) {
          JSON.parse(match[0]);
          storage.completeStage1Job(job.threadId, match[0]);
          processed += 1;
          return;
        }
      }

      storage.failStage1Job(job.threadId, "LLM output is not valid JSON");
      errors += 1;
    } catch (error) {
      storage.failStage1Job(
        job.threadId,
        error instanceof Error ? error.message : String(error),
      );
      errors += 1;
    }
  }));

  return { processed, errors };
}

async function runPhase2(
  storage: MemoryStorage,
  config: PipelineConfig,
  llmCall: LLMCallFn,
  workerId: string,
): Promise<boolean> {
  const phase2 = storage.tryClaimGlobalPhase2Job(workerId, 600);
  if (!phase2) {
    return false;
  }

  try {
    const outputs = storage.getStage1OutputsForCwd(config.cwd);
    if (outputs.length === 0) {
      storage.completePhase2Job(phase2.jobId);
      return true;
    }

    const allMemories: unknown[] = [];
    for (const output of outputs) {
      try {
        const memories = JSON.parse(output.extractionJson);
        if (Array.isArray(memories)) {
          allMemories.push(...memories);
        }
      } catch {
        // Skip malformed outputs.
      }
    }

    if (!existsSync(config.memoryDir)) {
      mkdirSync(config.memoryDir, { recursive: true });
    }

    if (allMemories.length === 0) {
      writeFileSync(join(config.memoryDir, "MEMORY.md"), "# Project Memory\n\nNo memories extracted yet.\n");
      writeFileSync(join(config.memoryDir, "memory_summary.md"), "");
      storage.completePhase2Job(phase2.jobId);
      return true;
    }

    writeFileSync(
      join(config.memoryDir, "raw_memories.md"),
      `# Raw Extracted Memories\n\n\`\`\`json\n${JSON.stringify(allMemories, null, 2)}\n\`\`\`\n`,
    );

    const consolidated = await llmCall(
      "You are a memory consolidation agent. Merge the extracted memories into a clean, organized markdown document.",
      PROMPTS.consolidation.replace("{{memories_json}}", JSON.stringify(allMemories, null, 2)),
      { maxTokens: 8192 },
    );
    const redacted = redactSecrets(consolidated);

    writeFileSync(join(config.memoryDir, "MEMORY.md"), redacted);
    writeFileSync(
      join(config.memoryDir, "memory_summary.md"),
      redacted.split("\n").slice(0, 100).join("\n"),
    );
    storage.completePhase2Job(phase2.jobId);
    return true;
  } catch {
    return false;
  }
}

export async function runStartup(
  storage: MemoryStorage,
  config: PipelineConfig,
  llmCall: LLMCallFn,
): Promise<{ phase1: { processed: number; errors: number }; phase2: boolean }> {
  const workerId = `worker-${Date.now()}`;
  const sessionFiles = await scanSessionFiles(config.sessionsDir, config.cwd);

  const now = Date.now();
  const maxAgeMs = config.maxRolloutAgeDays * 24 * 60 * 60 * 1000;
  const minIdleMs = config.minRolloutIdleHours * 60 * 60 * 1000;
  const eligible = sessionFiles
    .filter((file) => {
      const age = now - file.fileMtime;
      return age <= maxAgeMs && age >= minIdleMs;
    })
    .slice(0, config.maxRolloutsPerStartup);

  if (eligible.length > 0) {
    storage.upsertThreads(eligible.map((file) => ({
      threadId: file.threadId,
      filePath: file.filePath,
      fileSize: file.fileSize,
      fileMtime: file.fileMtime,
      cwd: config.cwd,
    })));
  }

  const phase1 = await runPhase1(storage, config, llmCall, workerId);
  const phase2 = phase1.processed > 0
    ? await runPhase2(storage, config, llmCall, workerId)
    : false;

  return { phase1, phase2 };
}

export function getMemorySummary(memoryDir: string): string | null {
  const summaryPath = join(memoryDir, "memory_summary.md");
  if (!existsSync(summaryPath)) {
    return null;
  }

  try {
    const content = readFileSync(summaryPath, "utf-8").trim();
    if (!content) {
      return null;
    }
    return PROMPTS.readPath.replace("{{memory_content}}", content);
  } catch {
    return null;
  }
}

export function getFullMemory(memoryDir: string): string | null {
  const memoryPath = join(memoryDir, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    return null;
  }

  try {
    return readFileSync(memoryPath, "utf-8");
  } catch {
    return null;
  }
}
