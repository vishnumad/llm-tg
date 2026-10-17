import { describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { uniqueChatId } from "../test-setup";
import { getChat, resetChat, updateChat } from "./chat-store";

function readChatFile(chatId: number) {
  return JSON.parse(
    readFileSync(join(config.CHAT_DATA_DIR, `${chatId}.json`), "utf-8"),
  );
}

function writeChatFile(chatId: number, contents: string) {
  writeFileSync(join(config.CHAT_DATA_DIR, `${chatId}.json`), contents);
}

describe("chat store", () => {
  test("starts a chat with no saved file empty", () => {
    expect(getChat(uniqueChatId())).toEqual({
      history: [],
      tokenUsage: { totalInputTokens: 0, totalOutputTokens: 0 },
    });
  });

  test("writes every update to disk, leaving no temp file behind", () => {
    const chatId = uniqueChatId();
    updateChat(chatId, (chat) => {
      chat.history.push({ role: "user", content: "hello" });
    });

    expect(readChatFile(chatId)).toEqual({
      history: [{ role: "user", content: "hello" }],
      tokenUsage: { totalInputTokens: 0, totalOutputTokens: 0 },
    });
    expect(readdirSync(config.CHAT_DATA_DIR)).not.toContain(
      `${chatId}.json.tmp`,
    );
  });

  test("loads a saved chat, filling in fields older files lack", () => {
    const chatId = uniqueChatId();
    writeChatFile(
      chatId,
      JSON.stringify({
        history: [{ role: "user", content: "hi" }],
        summary: "s",
      }),
    );

    expect(getChat(chatId)).toEqual({
      history: [{ role: "user", content: "hi" }],
      summary: "s",
      tokenUsage: { totalInputTokens: 0, totalOutputTokens: 0 },
    });
  });

  test("refuses to load a corrupted file rather than overwrite it", () => {
    const chatId = uniqueChatId();
    writeChatFile(chatId, "not json {{{");

    expect(() => getChat(chatId)).toThrow();
    expect(
      readFileSync(join(config.CHAT_DATA_DIR, `${chatId}.json`), "utf-8"),
    ).toBe("not json {{{");
  });

  test("reset clears the conversation", () => {
    const chatId = uniqueChatId();
    updateChat(chatId, (chat) => {
      chat.history.push({ role: "user", content: "hello" });
      chat.summary = "summary";
      chat.lastContextTokens = 500;
      chat.tokenUsage.totalInputTokens = 100;
    });

    resetChat(chatId);

    const expected = {
      history: [],
      tokenUsage: { totalInputTokens: 0, totalOutputTokens: 0 },
    };
    expect(getChat(chatId)).toEqual(expected);
    expect(readChatFile(chatId)).toEqual(expected);
  });

  test("creates the data directory on first write", () => {
    rmSync(config.CHAT_DATA_DIR, { recursive: true });
    const chatId = uniqueChatId();

    updateChat(chatId, () => {});

    expect(existsSync(join(config.CHAT_DATA_DIR, `${chatId}.json`))).toBe(true);
  });
});
