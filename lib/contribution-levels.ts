export const CONTRIBUTION_LEVELS = [
  { level: 1, name: "探索者", threshold: 0, description: "从了解项目、加入团队开始，寻找自己可以参与的方向。" },
  { level: 2, name: "参与者", threshold: 100, description: "已留下被认可的贡献，开始成为团队协作的一员。" },
  { level: 3, name: "实践者", threshold: 300, description: "通过多次有效交付，把自己的想法转化为项目成果。" },
  { level: 4, name: "共建者", threshold: 700, description: "持续参与任务与协作，和其他成员共同完善项目。" },
  { level: 5, name: "中坚者", threshold: 1500, description: "积累了丰富的有效贡献，为团队推进提供稳定支持。" },
  { level: 6, name: "领航者", threshold: 3000, description: "长期贡献成果与经验，帮助团队和更多成员共同成长。" },
  { level: 7, name: "项目狂人", threshold: 9999, description: "将持续创造与团队协作变成习惯，让每一次投入都留下成果。" },
] as const;

export const CONTRIBUTION_RULES = {
  task: { label: "任务交付", points: 30, description: "已提交的任务通过项目创建者审核，同一任务只计一次。" },
  knowledge: { label: "成果采纳", points: 10, description: "分享至团队知识库的独立证据成果，经创建者确认采纳。" },
  review: { label: "有效审查", points: 10, description: "审核他人的任务或成果，写明检查内容并确认通过。" },
  milestone: { label: "项目里程碑", points: 20, description: "已完成研究包经创建者确认，本阶段已有认可交付或成果的成员获得经验。" },
} as const;
export type ContributionKind = keyof typeof CONTRIBUTION_RULES;

export function contributionLevel(points: number) {
  const experience = Math.max(0, Math.floor(Number.isFinite(points) ? points : 0));
  const current = [...CONTRIBUTION_LEVELS].reverse().find(row => experience >= row.threshold)!;
  const next = CONTRIBUTION_LEVELS.find(row => row.level === current.level + 1) ?? null;
  return { ...current, experience, next, remaining: next ? next.threshold - experience : 0,
    progress: next ? Math.min(100, (experience - current.threshold) / (next.threshold - current.threshold) * 100) : 100 };
}
