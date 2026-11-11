import path from "node:path";
import { z } from "zod";

// A display-only absolute path from the Runner's own operating system. Do not
// resolve this value on the server or include it in model inputs.
export const runnerDirectory = z.string().min(1).max(1000).refine(value =>
  !/[\u0000-\u001f\u007f]/.test(value) && (
    path.posix.isAbsolute(value) ||
    (path.win32.isAbsolute(value) && (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value)))
  ), "Runner 须上报有效的绝对目录，且不能包含控制字符。");
