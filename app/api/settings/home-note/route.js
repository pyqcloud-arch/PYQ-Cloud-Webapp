import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
const defaults = { heading: "A note for you", subtitle: "Today is a new day!", text: "Every question that you practice brings you one step closer to your dream." };

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json(defaults, { headers: { "Cache-Control": "no-store" } });
  const database = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await database.from("app_settings").select("value").eq("key", "home_note").maybeSingle();
  if (error) return NextResponse.json(defaults, { headers: { "Cache-Control": "no-store" } });
  const value = data?.value && typeof data.value === "object" ? data.value : {};
  return NextResponse.json({ ...defaults, ...value }, { headers: { "Cache-Control": "no-store" } });
}
