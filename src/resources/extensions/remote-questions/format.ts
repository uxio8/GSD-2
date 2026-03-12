/**
 * Remote Questions — payload formatting and parsing helpers
 */

import type { RemotePrompt, RemoteQuestion, RemoteAnswer } from "./types.js";

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
}

const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
const MAX_USER_NOTE_LENGTH = 500;

export function formatForSlack(prompt: RemotePrompt): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "GSD needs your input" },
    },
  ];

  for (const question of prompt.questions) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${question.header}*\n${question.question}` },
    });

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: question.options.map((option, index) => `${index + 1}. *${option.label}* — ${option.description}`).join("\n"),
      },
    });

    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: question.allowMultiple
          ? "Reply in thread with comma-separated numbers (`1,3`) or free text."
          : "Reply in thread with a number (`1`) or free text.",
      }],
    });

    blocks.push({ type: "divider" });
  }

  return blocks;
}

export function formatForDiscord(prompt: RemotePrompt): { embeds: DiscordEmbed[]; reactionEmojis: string[] } {
  const reactionEmojis: string[] = [];
  const embeds: DiscordEmbed[] = prompt.questions.map((question, questionIndex) => {
    const supportsReactions = prompt.questions.length === 1;
    const optionLines = question.options.map((option, index) => {
      const emoji = NUMBER_EMOJIS[index] ?? `${index + 1}.`;
      if (supportsReactions && NUMBER_EMOJIS[index]) reactionEmojis.push(NUMBER_EMOJIS[index]);
      return `${emoji} **${option.label}** — ${option.description}`;
    });

    const footerText = supportsReactions
      ? (question.allowMultiple
          ? "Reply with comma-separated choices (`1,3`) or react with matching numbers"
          : "Reply with a number or react with the matching number")
      : `Question ${questionIndex + 1}/${prompt.questions.length} — reply with one line per question or use semicolons`;

    return {
      title: question.header,
      description: question.question,
      color: 0x7c3aed,
      fields: [{ name: "Options", value: optionLines.join("\n") }],
      footer: { text: footerText },
    };
  });

  return { embeds, reactionEmojis };
}

export function parseSlackReply(text: string, questions: RemoteQuestion[]): RemoteAnswer {
  const answers: RemoteAnswer["answers"] = {};
  const trimmed = text.trim();

  if (questions.length === 1) {
    answers[questions[0].id] = parseAnswerForQuestion(trimmed, questions[0]);
    return { answers };
  }

  const parts = trimmed.includes(";")
    ? trimmed.split(";").map((part) => part.trim()).filter(Boolean)
    : trimmed.split("\n").map((part) => part.trim()).filter(Boolean);

  for (let index = 0; index < questions.length; index++) {
    answers[questions[index].id] = parseAnswerForQuestion(parts[index] ?? "", questions[index]);
  }

  return { answers };
}

export function parseDiscordResponse(
  reactions: Array<{ emoji: string; count: number }>,
  replyText: string | null,
  questions: RemoteQuestion[],
): RemoteAnswer {
  if (replyText) return parseSlackReply(replyText, questions);

  const answers: RemoteAnswer["answers"] = {};
  if (questions.length !== 1) {
    for (const question of questions) {
      answers[question.id] = { answers: [], user_note: "Discord reactions are only supported for single-question prompts" };
    }
    return { answers };
  }

  const question = questions[0];
  const picked = reactions
    .filter((reaction) => NUMBER_EMOJIS.includes(reaction.emoji) && reaction.count > 0)
    .map((reaction) => question.options[NUMBER_EMOJIS.indexOf(reaction.emoji)]?.label)
    .filter(Boolean) as string[];

  answers[question.id] = picked.length > 0
    ? { answers: question.allowMultiple ? picked : [picked[0]] }
    : { answers: [], user_note: "No clear response via reactions" };

  return { answers };
}

function parseAnswerForQuestion(text: string, question: RemoteQuestion): { answers: string[]; user_note?: string } {
  if (!text) return { answers: [], user_note: "No response provided" };

  if (/^[\d,\s]+$/.test(text)) {
    const nums = text
      .split(",")
      .map((part) => parseInt(part.trim(), 10))
      .filter((num) => !Number.isNaN(num) && num >= 1 && num <= question.options.length);

    if (nums.length > 0) {
      const selected = nums.map((num) => question.options[num - 1].label);
      return { answers: question.allowMultiple ? selected : [selected[0]] };
    }
  }

  const single = parseInt(text, 10);
  if (!Number.isNaN(single) && single >= 1 && single <= question.options.length) {
    return { answers: [question.options[single - 1].label] };
  }

  return { answers: [], user_note: truncateNote(text) };
}

function truncateNote(text: string): string {
  return text.length > MAX_USER_NOTE_LENGTH ? `${text.slice(0, MAX_USER_NOTE_LENGTH)}…` : text;
}
