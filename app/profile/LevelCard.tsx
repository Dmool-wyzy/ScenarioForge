"use client";
import { contributionLevel } from "@/lib/contribution-levels";

export default function LevelCard({ experience, preview = false, onOpen }: { experience: number; preview?: boolean; onOpen?: () => void }) {
  const rank = contributionLevel(experience);
  return <section className={`sf-level-card sf-level-${rank.level}${preview ? " sf-level-preview" : ""}`} aria-label={`${preview ? "预览：" : "个人等级："}Lv.${rank.level} ${rank.name}`}>
    <div className="sf-level-ornament" aria-hidden="true"><span>✦</span><span>✧</span><span>✦</span></div>
    <div className="sf-level-top"><span className="sf-level-caption">{preview ? "LEVEL COLLECTION / 等级图鉴" : "YOUR GROWTH / 你的协作成长"}</span><span className="sf-level-total">{rank.experience.toLocaleString("zh-CN")} <small>EXP</small></span></div>
    <div className="sf-level-main"><div className="sf-level-emblem" aria-hidden="true"><span>{rank.level === 7 ? "♛" : "✦"}</span><b>{String(rank.level).padStart(2, "0")}</b></div><div><h2><small>Lv.{rank.level}</small> {rank.name}</h2><p>{rank.description}</p></div></div>
    <div className="sf-level-bottom"><span>{rank.next ? <>距离 <b>Lv.{rank.next.level} {rank.next.name}</b> 还差 {rank.remaining.toLocaleString("zh-CN")} 经验</> : "已达到最高等级，新的贡献仍会继续积累。"}</span>{onOpen && <button type="button" onClick={onOpen}>查看贡献与等级 ↗</button>}</div>
    <div className="sf-level-progress" role="progressbar" aria-label="当前等级进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(rank.progress)} aria-valuetext={rank.next ? `距离下一级还差 ${rank.remaining} 经验` : "已达到最高等级"}><span style={{ width: `${rank.progress}%` }} /></div>
  </section>;
}
