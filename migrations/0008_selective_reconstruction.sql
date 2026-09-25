-- A source may be successfully processed again, but only one run may own it
-- while processing. Ordinary consolidation still filters successful sources.
DROP INDEX consolidation_run_sources_active_interaction_idx;
CREATE UNIQUE INDEX consolidation_run_sources_processing_interaction_idx
  ON consolidation_run_sources (interaction_id) WHERE status = 'processing';

DROP INDEX consolidation_run_event_sources_active_idx;
CREATE UNIQUE INDEX consolidation_run_event_sources_processing_idx
  ON consolidation_run_event_sources (event_id) WHERE status = 'processing';

ALTER TABLE consolidation_runs DROP CONSTRAINT consolidation_runs_trigger_kind_check;
ALTER TABLE consolidation_runs ADD CONSTRAINT consolidation_runs_trigger_kind_check
  CHECK (trigger_kind IN ('manual', 'background', 'reconstruction'));
