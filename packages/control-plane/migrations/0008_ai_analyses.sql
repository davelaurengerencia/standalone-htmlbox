-- 0008_ai_analyses.sql — historial de análisis AI (Fase 4).
--
-- Guarda cada propuesta generada para un box. La columna `proposal_json`
-- contiene el JSON saneado por validateProposal (mismo shape que devuelve
-- el endpoint /api/ai/analyze-html).

CREATE TABLE IF NOT EXISTS htmlbox_ai_analyses (
  id TEXT PRIMARY KEY,
  box_id TEXT NOT NULL REFERENCES htmlbox_boxes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES htmlbox_users(id),
  prompt_html_size INTEGER NOT NULL,
  proposal_json TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_used INTEGER,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_htmlbox_ai_analyses_box ON htmlbox_ai_analyses(box_id, created_at DESC);