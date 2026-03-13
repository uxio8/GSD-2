import picomatch from "picomatch";

export type TtsrMatchSource = "text" | "thinking" | "tool";

export interface TtsrMatchContext {
  source: TtsrMatchSource;
  toolName?: string;
  filePaths?: string[];
  streamKey?: string;
}

export interface Rule {
  name: string;
  path: string;
  content: string;
  condition: string[];
  scope?: string[];
  globs?: string[];
}

export interface TtsrSettings {
  enabled?: boolean;
  contextMode?: "discard" | "keep";
  interruptMode?: "always" | "first";
  repeatMode?: "once" | "gap";
  repeatGap?: number;
}

interface ToolScope {
  toolName?: string;
  pathMatcher?: picomatch.Matcher;
}

interface TtsrScope {
  allowText: boolean;
  allowThinking: boolean;
  allowAnyTool: boolean;
  toolScopes: ToolScope[];
}

interface TtsrEntry {
  rule: Rule;
  conditions: RegExp[];
  scope: TtsrScope;
  globalPathMatchers?: picomatch.Matcher[];
}

interface InjectionRecord {
  lastInjectedAt: number;
}

const DEFAULT_SETTINGS: Required<TtsrSettings> = {
  enabled: true,
  contextMode: "discard",
  interruptMode: "always",
  repeatMode: "once",
  repeatGap: 10,
};

const MAX_BUFFER_BYTES = 512 * 1024;

const DEFAULT_SCOPE: TtsrScope = {
  allowText: true,
  allowThinking: false,
  allowAnyTool: true,
  toolScopes: [],
};

export class TtsrManager {
  readonly #settings: Required<TtsrSettings>;
  readonly #rules = new Map<string, TtsrEntry>();
  readonly #injectionRecords = new Map<string, InjectionRecord>();
  readonly #buffers = new Map<string, string>();
  #messageCount = 0;

  constructor(settings?: TtsrSettings) {
    this.#settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  #canTrigger(ruleName: string): boolean {
    const record = this.#injectionRecords.get(ruleName);
    if (!record) return true;
    if (this.#settings.repeatMode === "once") return false;
    return this.#messageCount - record.lastInjectedAt >= this.#settings.repeatGap;
  }

  #compileConditions(rule: Rule): RegExp[] {
    const compiled: RegExp[] = [];
    for (const pattern of rule.condition ?? []) {
      try {
        compiled.push(new RegExp(pattern));
      } catch (error) {
        console.warn(`[ttsr] Rule "${rule.name}": invalid regex "${pattern}" — ${(error as Error).message}`);
      }
    }
    return compiled;
  }

  #compileGlobalPathMatchers(globs: Rule["globs"]): picomatch.Matcher[] | undefined {
    if (!globs || globs.length === 0) return undefined;
    const matchers = globs
      .map((glob) => glob.trim())
      .filter((glob) => glob.length > 0)
      .map((glob) => picomatch(glob));
    return matchers.length > 0 ? matchers : undefined;
  }

  #parseToolScopeToken(token: string): ToolScope | undefined {
    const match =
      /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(token);
    if (!match) return undefined;

    const groups = match.groups;
    const hasToolPrefix = groups?.prefix !== undefined;
    const toolName = (groups?.tool ?? (hasToolPrefix ? undefined : groups?.bare))?.trim().toLowerCase();
    const pathPattern = groups?.path?.trim();

    if (!pathPattern) return { toolName };

    return {
      toolName,
      pathMatcher: picomatch(pathPattern),
    };
  }

  #buildScope(rule: Rule): TtsrScope {
    if (!rule.scope || rule.scope.length === 0) {
      return {
        allowText: DEFAULT_SCOPE.allowText,
        allowThinking: DEFAULT_SCOPE.allowThinking,
        allowAnyTool: DEFAULT_SCOPE.allowAnyTool,
        toolScopes: [...DEFAULT_SCOPE.toolScopes],
      };
    }

    const scope: TtsrScope = {
      allowText: false,
      allowThinking: false,
      allowAnyTool: false,
      toolScopes: [],
    };

    for (const rawToken of rule.scope) {
      const token = rawToken.trim();
      const normalized = token.toLowerCase();
      if (token.length === 0) continue;
      if (normalized === "text") {
        scope.allowText = true;
        continue;
      }
      if (normalized === "thinking") {
        scope.allowThinking = true;
        continue;
      }
      if (normalized === "tool" || normalized === "toolcall") {
        scope.allowAnyTool = true;
        continue;
      }

      const toolScope = this.#parseToolScopeToken(token);
      if (!toolScope) continue;
      if (!toolScope.toolName && !toolScope.pathMatcher) {
        scope.allowAnyTool = true;
        continue;
      }
      scope.toolScopes.push(toolScope);
    }

    return scope;
  }

  #hasReachableScope(scope: TtsrScope): boolean {
    return scope.allowText || scope.allowThinking || scope.allowAnyTool || scope.toolScopes.length > 0;
  }

  #bufferKey(context: TtsrMatchContext): string {
    if (context.streamKey && context.streamKey.trim().length > 0) return context.streamKey;
    if (context.source !== "tool") return context.source;
    const toolName = context.toolName?.trim().toLowerCase();
    return toolName ? `tool:${toolName}` : "tool";
  }

  #normalizePath(pathValue: string): string {
    return pathValue.replaceAll("\\", "/");
  }

  #matchesGlob(matcher: picomatch.Matcher, filePaths: string[] | undefined): boolean {
    if (!filePaths || filePaths.length === 0) return false;

    for (const filePath of filePaths) {
      const normalized = this.#normalizePath(filePath);
      if (matcher(normalized)) return true;
      const slashIndex = normalized.lastIndexOf("/");
      const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
      if (basename !== normalized && matcher(basename)) return true;
    }

    return false;
  }

  #matchesGlobalPaths(entry: TtsrEntry, context: TtsrMatchContext): boolean {
    if (!entry.globalPathMatchers || entry.globalPathMatchers.length === 0) return true;
    for (const matcher of entry.globalPathMatchers) {
      if (this.#matchesGlob(matcher, context.filePaths)) return true;
    }
    return false;
  }

  #matchesScope(entry: TtsrEntry, context: TtsrMatchContext): boolean {
    if (context.source === "text") return entry.scope.allowText;
    if (context.source === "thinking") return entry.scope.allowThinking;
    if (entry.scope.allowAnyTool) return true;

    const toolName = context.toolName?.trim().toLowerCase();
    for (const toolScope of entry.scope.toolScopes) {
      if (toolScope.toolName && toolScope.toolName !== toolName) continue;
      if (toolScope.pathMatcher && !this.#matchesGlob(toolScope.pathMatcher, context.filePaths)) continue;
      return true;
    }
    return false;
  }

  #matchesCondition(entry: TtsrEntry, streamBuffer: string): boolean {
    for (const condition of entry.conditions) {
      condition.lastIndex = 0;
      if (condition.test(streamBuffer)) return true;
    }
    return false;
  }

  addRule(rule: Rule): boolean {
    if (this.#rules.has(rule.name)) return false;

    const conditions = this.#compileConditions(rule);
    if (conditions.length === 0) return false;

    const scope = this.#buildScope(rule);
    if (!this.#hasReachableScope(scope)) return false;

    this.#rules.set(rule.name, {
      rule,
      conditions,
      scope,
      globalPathMatchers: this.#compileGlobalPathMatchers(rule.globs),
    });
    return true;
  }

  checkDelta(delta: string, context: TtsrMatchContext): Rule[] {
    const bufferKey = this.#bufferKey(context);
    let nextBuffer = `${this.#buffers.get(bufferKey) ?? ""}${delta}`;
    if (nextBuffer.length > MAX_BUFFER_BYTES) {
      nextBuffer = nextBuffer.slice(-MAX_BUFFER_BYTES);
    }
    this.#buffers.set(bufferKey, nextBuffer);

    const matches: Rule[] = [];
    for (const [name, entry] of this.#rules) {
      if (!this.#settings.enabled || !this.#canTrigger(name)) continue;
      if (!this.#matchesScope(entry, context)) continue;
      if (!this.#matchesGlobalPaths(entry, context)) continue;
      if (!this.#matchesCondition(entry, nextBuffer)) continue;
      matches.push(entry.rule);
    }
    return matches;
  }

  resetBuffer(): void {
    this.#buffers.clear();
  }

  incrementMessageCount(): void {
    this.#messageCount++;
  }

  markInjected(rules: Rule[]): void {
    for (const rule of rules) {
      this.#injectionRecords.set(rule.name, { lastInjectedAt: this.#messageCount });
    }
  }

  restoreInjected(ruleNames: string[]): void {
    for (const ruleName of ruleNames) {
      this.#injectionRecords.set(ruleName, { lastInjectedAt: this.#messageCount });
    }
  }

  getInjectedRuleNames(): string[] {
    return Array.from(this.#injectionRecords.keys());
  }

  hasRules(): boolean {
    return this.#rules.size > 0;
  }
}
