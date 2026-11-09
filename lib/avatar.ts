import "server-only";
import sharp from "sharp";
import { z } from "zod";
import { ApiError } from "./errors";

export const avatarSchema = z.union([
  z.enum(["leaf", "sun", "moon", "mountain", "wave", "star"]),
  z.string().max(200000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
]);
export async function normalizeAvatar(value: string) {
  const avatar = avatarSchema.parse(value);
  if (!avatar.startsWith("data:")) return avatar;
  try {
    const bytes = Buffer.from(avatar.slice(avatar.indexOf(",") + 1), "base64");
    const input = sharp(bytes, { limitInputPixels: 16777216, animated: false });
    const metadata = await input.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new Error("Unsupported avatar");
    const output = await input.rotate().resize(256, 256, { fit: "cover", position: "centre" }).webp({ quality: 85 }).toBuffer();
    return `data:image/webp;base64,${output.toString("base64")}`;
  } catch { throw new ApiError(400, "图片无法读取，请选择有效的 JPG、PNG 或 WebP 图片。"); }
}
