# Operating System → Opportunity Radar bridge

Status: production bridge code installed.

The Operating System now builds an evidence-backed internal-intelligence snapshot from recorded projects and demonstrated work, then sends it to Opportunity Radar using the dedicated machine token when:

- a project is created,
- a new OS event is recorded,
- a GitHub webhook creates OS events, or
- the scheduled OS job runs.

Radar imports this as internal intelligence only. It does not treat OS-derived facts as independent market evidence.
