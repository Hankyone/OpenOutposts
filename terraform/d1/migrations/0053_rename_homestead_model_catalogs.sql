-- The runner became the homestead. The catalog table a connected homestead
-- reports its models into follows the vocabulary; data is untouched. The
-- 0048/0050 files stay as written because they already ran where it matters.
ALTER TABLE runner_model_catalogs RENAME TO homestead_model_catalogs;
ALTER TABLE homestead_model_catalogs RENAME COLUMN runner_id TO homestead_id;
