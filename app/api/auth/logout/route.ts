import { signedOutResponse } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/validation";
export async function POST(request: Request) {
  try { assertSameOrigin(request); return await signedOutResponse(request); }
  catch (error) { return errorResponse(error); }
}
