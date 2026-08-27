-- 0009_box_auto_analyze.sql — toggle por-box para auto-generar schema al
-- guardar HTML. El portal/SDK lo lee antes de subir para decidir si dispara
-- el flujo de analyze-html.

ALTER TABLE htmlbox_boxes ADD COLUMN auto_analyze_on_save INTEGER NOT NULL DEFAULT 0;