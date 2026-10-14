-- Down for 0056_optics_labels.sql — 👓 النظارات.
--
-- What is lost: «⚙ أسماء الحقول» — the ten labels a tenant gave the boxes of
-- «👓 القياسات». The prescriptions themselves stay, whole: `optical_prescriptions`
-- keeps both eyes (`rightEye` · `leftEye`) and every value in them, and the screen falls
-- back to the desktop's own defaults — «RE-SPH» … «LE-IPD» — exactly as
-- `frmGlasses.loadNameLbl` does with `isnull(R1,'RE-SPH') … isnull(L5,'LE-IPD')`.
--
-- Nothing that existed before this migration is touched.

DROP INDEX IF EXISTS optics_field_labels_tenant_key;
DROP TABLE IF EXISTS optics_field_labels;
