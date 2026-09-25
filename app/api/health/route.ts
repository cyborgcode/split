import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Lets the client verify setup on load instead of failing silently mid-debate. */
export async function GET() {
  return NextResponse.json({
    ai: process.env.GEMINI_API_KEY ? "gemini" : null,
    model: process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite",
  });
}
