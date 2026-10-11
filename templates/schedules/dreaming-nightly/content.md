# Nightly Dreaming

Fires the seeded `dreaming` workflow once a night. This schedule only holds the time: everything dreaming does lives in the workflow. The workflow reads its settings from the Dreaming configuration group and does nothing until `DREAMING_ENABLED` is on, so an install that never turns dreaming on pays only for one short no-op run a night.

See the dreaming guide in the docs for what a run does and how to configure it.

**Pick your time.** The default is 03:25 UTC. Move the cron to about one hour after your install's deploy window, so a run never overlaps a restart.

**Editing the cron is safe.** Editing this schedule freezes only this small schedule row: the seeder stops updating it, and nothing else. The `dreaming` workflow is a separate row and keeps receiving template updates.

## Schedule

```json
{
  "cron": "25 3 * * *",
  "timezone": "UTC",
  "enabled": true,
  "workflow": "dreaming"
}
```
