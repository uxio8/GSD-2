/**
 * Remote Questions — Slack adapter
 */

import type { ChannelAdapter, RemotePrompt, RemoteDispatchResult, RemoteAnswer, RemotePromptRef } from "./types.js";
import { formatForSlack, parseSlackReply } from "./format.js";

const SLACK_API = "https://slack.com/api";
const PER_REQUEST_TIMEOUT_MS = 15_000;

export class SlackAdapter implements ChannelAdapter {
  readonly name = "slack" as const;
  private botUserId: string | null = null;
  private readonly token: string;
  private readonly channelId: string;

  constructor(token: string, channelId: string) {
    this.token = token;
    this.channelId = channelId;
  }

  async validate(): Promise<void> {
    const response = await this.slackApi("auth.test", {});
    if (!response.ok) throw new Error(`Slack auth failed: ${response.error ?? "invalid token"}`);
    this.botUserId = String(response.user_id ?? "");
  }

  async sendPrompt(prompt: RemotePrompt): Promise<RemoteDispatchResult> {
    const response = await this.slackApi("chat.postMessage", {
      channel: this.channelId,
      text: "GSD needs your input",
      blocks: formatForSlack(prompt),
    });

    if (!response.ok) throw new Error(`Slack postMessage failed: ${response.error ?? "unknown"}`);

    const ts = String(response.ts);
    const channel = String(response.channel);
    return {
      ref: {
        id: prompt.id,
        channel: "slack",
        messageId: ts,
        threadTs: ts,
        channelId: channel,
        threadUrl: `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`,
      },
    };
  }

  async pollAnswer(prompt: RemotePrompt, ref: RemotePromptRef): Promise<RemoteAnswer | null> {
    if (!this.botUserId) await this.validate();

    const response = await this.slackApi("conversations.replies", {
      channel: ref.channelId,
      ts: ref.threadTs!,
      limit: "20",
    });

    if (!response.ok) return null;

    const messages = (response.messages ?? []) as Array<{ user?: string; text?: string; ts: string }>;
    const userReplies = messages.filter((message) => (
      message.ts !== ref.threadTs &&
      message.user &&
      message.user !== this.botUserId &&
      message.text
    ));
    if (userReplies.length === 0) return null;

    return parseSlackReply(String(userReplies[0].text), prompt.questions);
  }

  private async slackApi(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${SLACK_API}/${method}`;
    const isGet = method === "conversations.replies" || method === "auth.test";

    let response: Response;
    if (isGet) {
      const query = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))).toString();
      response = await fetch(`${url}?${query}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
      });
    } else {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
      });
    }

    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}: ${response.statusText}`);
    return (await response.json()) as Record<string, unknown>;
  }
}
