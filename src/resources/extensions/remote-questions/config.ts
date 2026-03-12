/**
 * Remote Questions — configuration resolution and validation
 */

import { loadEffectiveGSDPreferences, type RemoteQuestionsConfig } from "../gsd/preferences.js";
import type { RemoteChannel } from "./types.js";

export interface ResolvedConfig {
  channel: RemoteChannel;
  channelId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  token: string;
}

const ENV_KEYS: Record<RemoteChannel, string> = {
  slack: "SLACK_BOT_TOKEN",
  discord: "DISCORD_BOT_TOKEN",
};

const CHANNEL_ID_PATTERNS: Record<RemoteChannel, RegExp> = {
  slack: /^[A-Z0-9]{9,12}$/,
  discord: /^\d{17,20}$/,
};

const DEFAULT_TIMEOUT_MINUTES = 5;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 30;
const MIN_POLL_INTERVAL_SECONDS = 2;
const MAX_POLL_INTERVAL_SECONDS = 30;

export function resolveRemoteConfig(): ResolvedConfig | null {
  const prefs = loadEffectiveGSDPreferences();
  const remoteQuestions: RemoteQuestionsConfig | undefined = prefs?.preferences.remote_questions;
  if (!remoteQuestions || !remoteQuestions.channel || !remoteQuestions.channel_id) return null;
  if (remoteQuestions.channel !== "slack" && remoteQuestions.channel !== "discord") return null;

  const channelId = String(remoteQuestions.channel_id);
  if (!CHANNEL_ID_PATTERNS[remoteQuestions.channel].test(channelId)) return null;

  const token = process.env[ENV_KEYS[remoteQuestions.channel]];
  if (!token) return null;

  const timeoutMinutes = clampNumber(remoteQuestions.timeout_minutes, DEFAULT_TIMEOUT_MINUTES, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES);
  const pollIntervalSeconds = clampNumber(remoteQuestions.poll_interval_seconds, DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS, MAX_POLL_INTERVAL_SECONDS);

  return {
    channel: remoteQuestions.channel,
    channelId,
    timeoutMs: timeoutMinutes * 60 * 1000,
    pollIntervalMs: pollIntervalSeconds * 1000,
    token,
  };
}

export function getRemoteConfigStatus(): string {
  const prefs = loadEffectiveGSDPreferences();
  const remoteQuestions: RemoteQuestionsConfig | undefined = prefs?.preferences.remote_questions;
  if (!remoteQuestions || !remoteQuestions.channel || !remoteQuestions.channel_id) return "Remote questions: not configured";
  if (remoteQuestions.channel !== "slack" && remoteQuestions.channel !== "discord") {
    return `Remote questions: unknown channel type "${remoteQuestions.channel}"`;
  }

  const channelId = String(remoteQuestions.channel_id);
  if (!CHANNEL_ID_PATTERNS[remoteQuestions.channel].test(channelId)) {
    return `Remote questions: invalid ${remoteQuestions.channel} channel ID format`;
  }

  const envVar = ENV_KEYS[remoteQuestions.channel];
  if (!process.env[envVar]) return `Remote questions: ${envVar} not set — remote questions disabled`;

  const timeoutMinutes = clampNumber(remoteQuestions.timeout_minutes, DEFAULT_TIMEOUT_MINUTES, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES);
  const pollIntervalSeconds = clampNumber(remoteQuestions.poll_interval_seconds, DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS, MAX_POLL_INTERVAL_SECONDS);
  return `Remote questions: ${remoteQuestions.channel} configured (timeout ${timeoutMinutes}m, poll ${pollIntervalSeconds}s)`;
}

export function isValidChannelId(channel: RemoteChannel, id: string): boolean {
  return CHANNEL_ID_PATTERNS[channel].test(id);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
