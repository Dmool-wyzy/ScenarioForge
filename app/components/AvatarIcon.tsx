import Image from "next/image";
export const avatarSymbols: Record<string, string> = { leaf: "❧", sun: "☀", moon: "☾", mountain: "△", wave: "≈", star: "✦" };
export default function AvatarIcon({ value, alt = "我的头像" }: { value?: string; alt?: string }) {
  return value?.startsWith("data:image/")
    ? <Image unoptimized src={value} alt={alt} width={256} height={256} className="sf-avatar-image" />
    : <>{avatarSymbols[value ?? "leaf"] || avatarSymbols.leaf}</>;
}
