import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands/parser.js";
import { loadConfig } from "../src/config.js";

const disabledLlm = { isConfigured: () => false } as never;
const config = loadConfig({ DEFAULT_PRODUCT: "Sample Product" });

describe("Feishu command parser", () => {
  it("parses a Chinese lead discovery command without relying on an LLM", async () => {
    const command = await parseCommand(
      "开发越南市场的工业示例系统集成商，主推示例配件、示例配件和示例组件，寻找20家。",
      disabledLlm,
      config,
    );
    expect(command).toMatchObject({
      intent: "FIND",
      market: "Vietnam",
      buyerType: "system integrator",
      count: 20,
    });
    if (command.intent === "FIND") expect(command.product).toBe("Sample Product");
  });

  it("never turns an approval phrase without a lead ID into an approval target", async () => {
    const command = await parseCommand("批准发送", disabledLlm, config);
    expect(command).toEqual({ intent: "APPROVE", leadIds: [] });
  });

  it("extracts only explicit lead IDs for approval", async () => {
    const leadId = "lead_12345678-1234-1234-1234-123456789abc";
    const command = await parseCommand(`批准 ${leadId}`, disabledLlm, config);
    expect(command).toEqual({ intent: "APPROVE", leadIds: [leadId] });
  });

  it("parses Gmail self-test and activation commands explicitly", async () => {
    await expect(parseCommand("测试邮箱", disabledLlm, config)).resolves.toEqual({ intent: "TEST_EMAIL" });
    await expect(parseCommand("测试 Gmail", disabledLlm, config)).resolves.toEqual({ intent: "TEST_GMAIL" });
    await expect(parseCommand("开启 Gmail 试发", disabledLlm, config)).resolves.toEqual({
      intent: "ACTIVATE_GMAIL_PILOT",
    });
  });

  it("parses daily autonomous research controls explicitly", async () => {
    await expect(parseCommand("开启每日自动获客", disabledLlm, config)).resolves.toEqual({
      intent: "ENABLE_DAILY_RESEARCH",
    });
    await expect(parseCommand("关闭每日自动获客", disabledLlm, config)).resolves.toEqual({
      intent: "DISABLE_DAILY_RESEARCH",
    });
  });

  it("parses read-only funnel commands explicitly", async () => {
    await expect(parseCommand("今日漏斗", disabledLlm, config)).resolves.toEqual({
      intent: "FUNNEL",
      period: "TODAY",
    });
    await expect(parseCommand("漏斗报告", disabledLlm, config)).resolves.toEqual({
      intent: "FUNNEL",
      period: "ALL",
    });
  });

  it.each(["实时运营", "运营看板", "今日数据", "实时监测", "收发情况", "ops dashboard"])(
    "parses a live operations dashboard command explicitly: %s",
    async (text) => {
      await expect(parseCommand(text, disabledLlm, config)).resolves.toEqual({ intent: "OPERATIONS" });
    },
  );

  it.each([
    "能不能用了",
    "现在能发吗",
    "获客就绪",
    "可以开始获客了吗",
    "这个 Agent 能用了吗？",
  ])("treats an explicit readiness question as STATUS: %s", async (text) => {
    await expect(parseCommand(text, disabledLlm, config)).resolves.toEqual({ intent: "STATUS" });
  });

  it("does not mistake a concrete acquisition request for a readiness question", async () => {
    await expect(parseCommand(
      "开始获客：寻找越南20家工业设备集成商",
      disabledLlm,
      config,
    )).resolves.toMatchObject({ intent: "FIND", market: "Vietnam", count: 20 });
  });
});
