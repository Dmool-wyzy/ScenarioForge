import "server-only";
import type { Session, AgentInputItem } from "@openai/agents";
import { db } from "./db";

export class DatabaseSession implements Session {
  constructor(private packageId: string, private sessionId: string) {}
  async getSessionId() { return this.sessionId; }
  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const row = await db.researchPackage.findUniqueOrThrow({ where: { id: this.packageId }, select: { sessionState: true } });
    const items = JSON.parse(row.sessionState) as AgentInputItem[];
    return limit === undefined ? items : limit <= 0 ? [] : items.slice(-limit);
  }
  async addItems(items: AgentInputItem[]) {
    await db.$transaction(async (tx) => {
      const row = await tx.researchPackage.findUniqueOrThrow({ where: { id: this.packageId }, select: { sessionState: true } });
      const history = JSON.parse(row.sessionState) as AgentInputItem[];
      await tx.researchPackage.update({ where: { id: this.packageId }, data: { sessionState: JSON.stringify([...history, ...items]) } });
    });
  }
  async popItem() {
    return db.$transaction(async (tx) => {
      const row = await tx.researchPackage.findUniqueOrThrow({ where: { id: this.packageId }, select: { sessionState: true } });
      const history = JSON.parse(row.sessionState) as AgentInputItem[];
      const last = history.pop();
      await tx.researchPackage.update({ where: { id: this.packageId }, data: { sessionState: JSON.stringify(history) } });
      return last;
    });
  }
  async clearSession() { await db.researchPackage.update({ where: { id: this.packageId }, data: { sessionState: "[]" } }); }
}
