-- 0011_ai_analyses_candidates.sql — guarda los candidatos extraídos del HTML
-- al momento del análisis, para que apply NO tenga que re-extraer del HTML
-- viejo (que el tenant ya no tiene necesariamente). El apply igual re-extrae
-- del HTML ACTUAL por seguridad — ver htmlbox-spec-ai-apply-schema.md §4.

ALTER TABLE htmlbox_ai_analyses ADD COLUMN candidates_json TEXT;