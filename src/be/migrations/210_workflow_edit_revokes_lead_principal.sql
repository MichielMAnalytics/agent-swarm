-- Any edit to a workflow revokes Lead eligibility of every run of it.
--
-- Every path that executes a node (walks, resume, recovery, the retry poller,
-- step validation, task-failure routing) reads the stored row, and the only
-- way to change that row is an UPDATE. Revoking here, at the write, covers
-- every reader, including ones added later. Restoring the row is another
-- edit and never sets the flag back. `enabled`, `key`, the timestamps and the
-- audit columns are left out: toggling the seeded workflow on is its normal
-- adoption path and does not change what it runs.

CREATE TRIGGER revoke_lead_principal_on_workflow_edit
AFTER UPDATE ON workflows
WHEN NEW.name IS NOT OLD.name
  OR NEW.description IS NOT OLD.description
  OR NEW.definition IS NOT OLD.definition
  OR NEW.triggers IS NOT OLD.triggers
  OR NEW.cooldown IS NOT OLD.cooldown
  OR NEW.input IS NOT OLD.input
  OR NEW.triggerSchema IS NOT OLD.triggerSchema
  OR NEW.params IS NOT OLD.params
  OR NEW.requiredParams IS NOT OLD.requiredParams
  OR NEW.requires IS NOT OLD.requires
  OR NEW.dir IS NOT OLD.dir
  OR NEW.vcs_repo IS NOT OLD.vcs_repo
  OR NEW.createdByAgentId IS NOT OLD.createdByAgentId
BEGIN
  UPDATE workflow_runs SET leadPrincipalEligible = 0
  WHERE workflowId = NEW.id AND leadPrincipalEligible = 1;
END;
