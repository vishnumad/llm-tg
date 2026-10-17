import { expect, test } from "bun:test";
import { getModelId } from "../ai/chat";
import { getChat } from "../ai/chat-store";
import { uniqueChatId } from "../test-setup";
import { type CommandInput, commands, parseGuestCommand } from "./commands";

function switchModel(chatId: number, args: string) {
  return commands.switchmodel({
    chat: { id: chatId, type: "private", first_name: "Sam" },
    from: { id: 7, is_bot: false, first_name: "Sam" },
    args,
    replier: {
      whileTyping: (work) => work(),
      send: async () => {},
      notice: async () => {},
    },
  } satisfies CommandInput);
}

test("/switchmodel default goes back to the configured model", async () => {
  const chatId = uniqueChatId();

  await switchModel(chatId, "chosen-model");
  expect(getModelId(chatId)).toBe("chosen-model");

  await switchModel(chatId, "default");
  expect(getChat(chatId).modelId).toBeUndefined();
  expect(getModelId(chatId)).toBe("default-model");
});

test("parseGuestCommand finds known commands and their arguments", () => {
  expect(parseGuestCommand("/switchmodel  some/model ")).toEqual({
    command: commands.switchmodel,
    args: "some/model ",
  });
  expect(parseGuestCommand("/Ping")).toEqual({
    command: commands.start,
    args: "",
  });
  expect(parseGuestCommand("/unknown")).toBeUndefined();
  expect(parseGuestCommand("/constructor")).toBeUndefined();
  expect(parseGuestCommand("what does /debug do?")).toBeUndefined();
});
