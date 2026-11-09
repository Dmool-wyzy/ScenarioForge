"use client";
export default function ProjectPriority({ name, value, busy, onChange }: { name: string; value: number; busy: boolean; onChange: (stars: number) => void }) {
  return <div className="sf-priority"><span>我的优先级</span><div role="radiogroup" aria-label={`${name}的个人优先级`} aria-busy={busy}>
    {[1, 2, 3, 4, 5].map(star => <label key={star} title={`${star} 星${star === 5 ? " · 最高" : ""}`} className={star <= value ? "is-filled" : ""}>
      <input type="radio" name={`priority-${name}`} value={star} checked={star === value} disabled={busy} aria-label={`${star} 星`} onChange={() => onChange(star)} /><span aria-hidden="true">★</span>
    </label>)}
  </div><small aria-live="polite">{busy ? "保存中" : `${value} / 5`}</small></div>;
}
