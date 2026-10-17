import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { config } from "../config";

export type ChatState = {
  history: ModelMessage[];
  /** Running summary of everything compacted out of `history`. */
  summary?: string;
  tokenUsage: { totalInputTokens: number; totalOutputTokens: number };
  /** Size of the context the model last saw, as reported by the provider. */
  lastContextTokens?: number;
};

const chats = new Map<number, ChatState>();

function emptyChat(): ChatState {
  return {
    history: [],
    tokenUsage: { totalInputTokens: 0, totalOutputTokens: 0 },
  };
}

function chatPath(chatId: number): string {
  return join(config.CHAT_DATA_DIR, `${chatId}.json`);
}

function loadChat(chatId: number): ChatState {
  const path = chatPath(chatId);
  if (!existsSync(path)) {
    return emptyChat();
  }
  return { ...emptyChat(), ...JSON.parse(readFileSync(path, "utf-8")) };
}

// Synchronous so writes can't land out of order, and renamed into place so a
// crash can't leave a half-written file behind.
function writeChat(chatId: number, chat: ChatState) {
  mkdirSync(config.CHAT_DATA_DIR, { recursive: true });
  const path = chatPath(chatId);
  writeFileSync(`${path}.tmp`, JSON.stringify(chat, null, 2));
  renameSync(`${path}.tmp`, path);
}

export function getChat(chatId: number): ChatState {
  let chat = chats.get(chatId);
  if (!chat) {
    chat = loadChat(chatId);
    chats.set(chatId, chat);
  }
  return chat;
}

export function updateChat(chatId: number, update: (chat: ChatState) => void) {
  const chat = getChat(chatId);
  update(chat);
  writeChat(chatId, chat);
}

export function resetChat(chatId: number) {
  const chat = emptyChat();
  chats.set(chatId, chat);
  writeChat(chatId, chat);
}

export function addUsage(chat: ChatState, usage: LanguageModelUsage) {
  chat.tokenUsage.totalInputTokens += usage.inputTokens ?? 0;
  chat.tokenUsage.totalOutputTokens += usage.outputTokens ?? 0;
}
