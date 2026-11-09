export async function avatarFromFile(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("请选择 JPG、PNG 或 WebP 图片。");
  if (file.size > 5 * 1024 * 1024) throw new Error("图片不能超过 5 MB，请选择较小的图片。");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("图片无法读取，请换一张图片。"); }
  try {
    if (bitmap.width * bitmap.height > 16777216) throw new Error("图片分辨率过大，请先缩小到 1600 万像素以内。");
    const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法处理图片，请重试。");
    const size = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 256, 256);
    return canvas.toDataURL("image/webp", 0.85);
  } finally { bitmap.close(); }
}
