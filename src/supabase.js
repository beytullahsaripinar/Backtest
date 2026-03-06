import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Supabase env variables eksik! .env dosyasını kontrol et.");
}

export const supabase = createClient(supabaseUrl, supabaseKey);

// ── DB Operations ─────────────────────────────────────────────────────────────

export async function dbLoadAll() {
  const { data, error } = await supabase
    .from("datasets")
    .select("*")
    .order("uploaded_at", { ascending: false });

  if (error) throw error;

  const results = {};
  (data || []).forEach((row) => {
    results[row.storage_key] = {
      meta: {
        pair:         row.pair,
        timeframe:    row.timeframe,
        startDate:    row.start_date  || "",
        endDate:      row.end_date    || "",
        contractType: row.contract_type || "P",
        storageKey:   row.storage_key,
      },
      trades:     row.trades,
      filename:   row.filename,
      uploadedAt: row.uploaded_at,
    };
  });
  return results;
}

export async function dbSaveDataset(storageKey, dataset) {
  const { error } = await supabase.from("datasets").upsert(
    {
      storage_key:   storageKey,
      pair:          dataset.meta.pair,
      timeframe:     dataset.meta.timeframe,
      start_date:    dataset.meta.startDate  || null,
      end_date:      dataset.meta.endDate    || null,
      contract_type: dataset.meta.contractType || "P",
      filename:      dataset.filename,
      trades:        dataset.trades,
      uploaded_at:   dataset.uploadedAt,
    },
    { onConflict: "storage_key" }
  );
  if (error) throw error;
}

export async function dbDeleteDataset(storageKey) {
  const { error } = await supabase
    .from("datasets")
    .delete()
    .eq("storage_key", storageKey);
  if (error) throw error;
}
