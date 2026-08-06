-- Drop the prebuilt-image subsystem.
--
-- Prebuilt images existed because a session's filesystem was a disposable
-- sandbox that had to be reconstructed on every spawn. Execution now happens on
-- an outpost — a durable machine the user owns, with a real filesystem — so
-- there is nothing for an image to prebuild, and every table, route, adapter and
-- settings surface behind this has been removed.
--
-- image_builds (0039) generalized environment_images (0033/0034) and repo_images
-- (0009/0022/0023, dropped in 0040). Its provider-side artifacts were reclaimed
-- by the reaper, which is gone with the rest of the subsystem; any artifact still
-- alive at this point belongs to the provider account and expires on the
-- provider's own schedule.
--
-- The two enablement flags go with it. Both carried NOT NULL DEFAULT 0, so
-- nothing depended on their values once the readers were removed.

DROP TABLE IF EXISTS image_builds;

ALTER TABLE environments DROP COLUMN prebuild_enabled;
ALTER TABLE repo_metadata DROP COLUMN image_build_enabled;
