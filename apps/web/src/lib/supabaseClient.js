import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isMockMode = !supabaseUrl || !supabaseAnonKey || 
                          supabaseUrl.includes("placeholder-id") || 
                          supabaseAnonKey.includes("placeholder-anon-key");

if (isMockMode) {
  if (typeof window !== "undefined") {
    console.warn("Supabase credentials missing or placeholders. Running in LOCAL STORAGE MOCK DATABASE MODE.");
  }
}

const finalUrl = supabaseUrl || "https://placeholder-id.supabase.co";
const finalKey = supabaseAnonKey || "placeholder-anon-key";

export const supabase = createClient(finalUrl, finalKey);

