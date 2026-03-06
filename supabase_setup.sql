-- BacktestLab - Supabase Tablo Kurulumu
-- Bu SQL'i Supabase > SQL Editor'e yapistir ve calistir

CREATE TABLE IF NOT EXISTS public.datasets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key   TEXT UNIQUE NOT NULL,
  pair          TEXT NOT NULL,
  timeframe     TEXT NOT NULL DEFAULT 'main',
  start_date    TEXT,
  end_date      TEXT,
  contract_type TEXT DEFAULT 'P',
  filename      TEXT,
  trades        JSONB NOT NULL DEFAULT '[]'::jsonb,
  uploaded_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_datasets_pair ON public.datasets(pair);
CREATE INDEX IF NOT EXISTS idx_datasets_timeframe ON public.datasets(timeframe);

-- Enable Row Level Security
ALTER TABLE public.datasets ENABLE ROW LEVEL SECURITY;

-- Public read/write policy (kisisel kullanim icin)
CREATE POLICY "Allow all operations" ON public.datasets
  FOR ALL USING (true) WITH CHECK (true);

-- Confirmation
SELECT 'Tablo basariyla olusturuldu!' as durum;
