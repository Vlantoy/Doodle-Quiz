import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

let supabase = null;

export function getSupabase() {
  if (!supabase) {
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new Error("Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
    }
    supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }
  return supabase;
}

