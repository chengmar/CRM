import type { AgentConfig } from "../config.js";
import type { AgentDatabase } from "../db.js";
import type { FeishuIntegration } from "../integrations/feishu.js";
import { listFeishuAlertDestinations } from "../integrations/feishu-destinations.js";
import { logger } from "../logger.js";
import {
  launchScheduledDailyResearch,
  ScheduledResearchLaunchError,
  selectScheduledDailyResearchPlay,
} from "../acquisition/scheduled-research-launch.js";

function localParts(timeZone: string, now: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    hour: Number(value.hour ?? 0),
  };
}

export class DailyResearchScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly db: AgentDatabase,
    private readonly feishu: FeishuIntegration,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  isEnabled(): boolean {
    const override = this.db.getSetting("daily_research_enabled");
    return override === null ? this.config.DAILY_RESEARCH_ENABLED : override === "true";
  }

  start(): void {
    this.timer = setInterval(
      () => void this.tick().catch((error) => logger.error({ error }, "Daily research scheduler failed")),
      60_000,
    );
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running || !this.isEnabled()) return;
    const now = this.nowProvider();
    const local = localParts(this.config.DAILY_RESEARCH_TIMEZONE, now);
    if (local.hour < this.config.DAILY_RESEARCH_HOUR) return;
    const runKey = `daily_research_run:${local.date}`;
    if (this.db.getSetting(runKey)) return;
    const destination = listFeishuAlertDestinations(this.config, this.db)[0] ?? "";
    const selection = selectScheduledDailyResearchPlay(this.db, {
      asOf: now.toISOString(),
      allowedMarkets: this.config.dailyResearchMarkets,
    });
    if (selection.status !== "SELECTED") {
      const noticeKey = `daily_research_notice:no_eligible_play:${local.date}`;
      if (this.db.setSettingIfAbsent(noticeKey, now.toISOString())) {
        logger.warn(
          { date: local.date, blocker: selection.blocker },
          "Daily research failed closed without an eligible play",
        );
        if (destination) {
          await this.feishu.sendText(
            destination,
            `每日自动研究未启动：当前没有同时满足最新方案、有效市场证据和未应用分配建议条件的方案。` +
              `系统已保持停止状态（原因代码：${selection.blocker}）。`,
          ).catch((error) => logger.warn({ error }, "Daily research eligibility warning failed"));
        }
      }
      return;
    }

    this.running = true;
    try {
      let reservation;
      try {
        reservation = launchScheduledDailyResearch(this.db, {
          runKey,
          date: local.date,
          selection,
          allowedMarkets: this.config.dailyResearchMarkets,
          targetCount: this.config.DAILY_RESEARCH_TARGET,
          maxProviderUnits: this.config.MAX_PAGES_PER_CAMPAIGN,
          replyChatId: destination,
        });
      } catch (error) {
        const blocker = error instanceof ScheduledResearchLaunchError ? error.blocker : "LAUNCH_FAILED";
        logger.warn({ error, blocker, date: local.date }, "Daily research launch failed closed");
        const noticeKey = `daily_research_notice:launch_blocked:${local.date}`;
        if (destination && this.db.setSettingIfAbsent(noticeKey, now.toISOString())) {
          await this.feishu.sendText(
            destination,
            `每日自动研究未启动：启动授权或研究账本核验没有通过。系统没有创建研究任务，也不会发送客户邮件` +
              `（原因代码：${blocker}）。`,
          ).catch((notificationError) => logger.warn(
            { error: notificationError },
            "Daily research launch warning failed",
          ));
        }
        return;
      }
      if (!reservation) return;
      if (destination) {
        await this.feishu.sendText(
          destination,
          `每日自动研究已启动：市场 ${reservation.market}，方案 ${reservation.playId}，` +
            `目标研究 ${this.config.DAILY_RESEARCH_TARGET} 家公司。本次只做公开信息研究，不会生成或发送客户邮件。`,
        );
      }
    } finally {
      this.running = false;
    }
  }
}
