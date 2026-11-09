// Deterministic parsing only: task dates never depend on refresh time or server timezone.
const DAY = 86400000;
const BEIJING = 8 * 3600000;
export type TaskDeadline = { dueAt: string; precision: "date" | "time"; relative: boolean };
export type KnownDeadline = TaskDeadline & { source: "task" };

const number = "[0-9零〇一二两三四五六七八九十百]+";
const datePart = `(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|(?:\\d{4}年)?\\d{1,2}月\\d{1,2}[日号]|今天|明天|后天|(?:本|这|下)周[一二三四五六日天]|${number}\\s*(?:天|日|周|星期)(?:之?内|以内))`;
const timePart = "(?:[T\\s]*(?:上午|下午|晚上|中午|早上)?\\s*\\d{1,2}(?:[:：]\\d{2}(?:[:：]\\d{2}(?:\\.\\d{1,3})?)?|[点时](?:\\d{1,2}分?|半)?)(?:\\s*(?:Z|[+-]\\d{2}:?\\d{2}))?)?";
const label = /(?:截止(?:日期|时间)?|截至(?:日期|时间)?|最晚|交付日期|提交期限|完成期限|deadline|due(?:\s+date)?)(?:\s*(?:为|是|于|在|on|at|by))?\s*[:：]?\s*$/i;
const uncertain = /(?:例如|比如|示例|假设|如果|参考|可能|待定|未定|另行通知|不设|无需|没有|无明确|不限|尚未|未指定|未设置|不需要|no\s+deadline|e\.g\.)/i;

function chineseNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0, current = 0;
  for (const char of value) {
    if (char === "十" || char === "百") { total += (current || 1) * (char === "十" ? 10 : 100); current = 0; }
    else if (char in digits) current = digits[char];
    else return NaN;
  }
  return total + current;
}

function parseToken(token: string, reference: Date): TaskDeadline | null {
  const duration = token.match(new RegExp(`^(${number})\\s*(天|日|周|星期)(?:之?内|以内)$`));
  if (duration) {
    const days = chineseNumber(duration[1]) * (/周|星期/.test(duration[2]) ? 7 : 1);
    if (!Number.isFinite(days) || days < 0 || days > 3650) return null;
    return { dueAt: new Date(reference.getTime() + days * DAY).toISOString(), precision: "time", relative: true };
  }
  const base = new Date(reference.getTime() + BEIJING);
  let year = base.getUTCFullYear(), month = base.getUTCMonth() + 1, day = base.getUTCDate(), rest = "", relative = false;
  const numeric = token.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const chinese = token.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]/);
  const relativeDay = token.match(/^(今天|明天|后天|(?:本|这|下)周[一二三四五六日天])/);
  if (numeric || chinese) {
    const match = (numeric || chinese)!;
    year = match[1] ? Number(match[1]) : year;
    month = Number(match[2]); day = Number(match[3]); rest = token.slice(match[0].length);
  } else if (relativeDay) {
    const name = relativeDay[1];
    let offset = name === "今天" ? 0 : name === "明天" ? 1 : 2;
    if (name.includes("周")) {
      const target = "一二三四五六日".indexOf(name.at(-1)!.replace("天", "日"));
      offset = target - (base.getUTCDay() + 6) % 7 + (name.startsWith("下") ? 7 : 0);
    }
    base.setUTCDate(day + offset);
    year = base.getUTCFullYear(); month = base.getUTCMonth() + 1; day = base.getUTCDate();
    rest = token.slice(name.length); relative = true;
  } else return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  let hours = 23, minutes = 59, seconds = 59, milliseconds = 999, timezone = BEIJING;
  const hasTime = !!rest.trim();
  if (hasTime) {
    const time = rest.match(/^[T\s]*(上午|下午|晚上|中午|早上)?\s*(\d{1,2})(?:[:：](\d{2})(?:[:：](\d{2})(?:\.(\d{1,3}))?)?|[点时](?:(\d{1,2})分?|(半))?)\s*(Z|[+-]\d{2}:?\d{2})?$/i);
    if (!time) return null;
    hours = Number(time[2]); minutes = time[7] ? 30 : Number(time[3] ?? time[6] ?? 0);
    seconds = Number(time[4] ?? 0); milliseconds = Number((time[5] ?? "0").padEnd(3, "0"));
    if (/下午|晚上|中午/.test(time[1] ?? "") && hours < 12) hours += 12;
    if (/上午|早上/.test(time[1] ?? "") && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
    if (time[8]?.toUpperCase() === "Z") timezone = 0;
    else if (time[8]) {
      const zone = time[8].match(/^([+-])(\d{2}):?(\d{2})$/)!;
      const zoneHours = Number(zone[2]), zoneMinutes = Number(zone[3]);
      if (zoneHours > 14 || zoneMinutes > 59 || (zoneHours === 14 && zoneMinutes > 0)) return null;
      timezone = (zoneHours * 60 + zoneMinutes) * 60000 * (zone[1] === "-" ? -1 : 1);
    }
  }
  return { dueAt: new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, milliseconds) - timezone).toISOString(), precision: hasTime ? "time" : "date", relative };
}

function normalize(value: string) { return value.normalize("NFKC").replace(/[*`_]/g, "").trim(); }

// Dates mentioned as examples or events do not automatically become task deadlines.
export function extractTaskDeadline(text: string, reference: Date): TaskDeadline | null {
  const found: TaskDeadline[] = [];
  for (const clause of normalize(text).split(/[\n。;；!?！？]/)) {
    if (uncertain.test(clause)) continue;
    for (const match of clause.matchAll(new RegExp(`(?<![\\d./-])(${datePart}${timePart})(?![\\d])`, "gi"))) {
      const before = clause.slice(0, match.index), after = clause.slice(match.index + match[0].length);
      const marked = label.test(before) || /^\s*(?:前|之前)\s*(?:必须|务必|需|要|请)?\s*(?:完成|提交|交付|上线|验收)/.test(after)
        || /^\s*截止/.test(after) || (/内$/.test(match[0]) && /^\s*(?:完成|提交|交付|上线|验收)/.test(after));
      if (!marked) continue;
      if (/^\s*(?:的)?(?:数据|统计|累计|记录|情况|资料|共\d)/.test(after)) continue;
      // Do not silently reinterpret a partly supported time or an unspecified foreign timezone.
      if (/^\s*(?:[T:：\d]|上午|下午|晚上|中午|早上|[+-]\d|UTC|GMT|PST|EST|东京|纽约|伦敦)/i.test(after)
        || /^\s*(?:或(?:者)?|至|到|[~～—–-])\s*(?:\d|今天|明天|后天)/.test(after)) return null;
      const parsed = parseToken(match[0], reference);
      if (!parsed) return null;
      found.push(parsed);
    }
  }
  const unique = new Map(found.map(value => [value.dueAt, value]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

// Only the task description supplies its deadline; project context is not a task due date.
export function taskDeadline(task: { objective: string; createdAt: Date }): KnownDeadline | null {
  const parsed = extractTaskDeadline(task.objective, task.createdAt);
  return parsed ? { ...parsed, source: "task" } : null;
}
