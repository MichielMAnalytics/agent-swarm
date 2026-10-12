-- Whether a run may still run seeded `runAs: "lead"` scripts as the Lead.
--
-- Set at run creation only when the workflow is the unedited seeded template,
-- and cleared for good the first time any walk of the run (start, resume,
-- retry, recovery) executes a definition that is not. Restoring the stored
-- row later never sets it back, so output produced under an edited definition
-- is never consumed with Lead credentials.

ALTER TABLE workflow_runs ADD COLUMN leadPrincipalEligible INTEGER NOT NULL DEFAULT 0;
