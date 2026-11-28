# Weekly bus schedule check

The GTFS validator checks NJ Transit's public bus schedule ZIP for possible problems.
It runs every Monday at 10:23 UTC (5:23 AM Eastern in winter, 6:23 AM in summer).
It can also run by hand from Actions, and on pull requests changing its workflow,
summary script or summary test.

This is an informational check (D81). It never blocks pull requests or deployments;
do not make it a required check or a dependency of a deployment.
Even ERROR notices in NJ Transit's data do not fail the job.
A failed download, wrong validator checksum, broken tool or missing report does.

Open the GTFS validator run in Actions to read its summary: validator version,
feed checksum and byte size, severity totals, and each notice code and count.
The summary includes no sample rows.
Download the gtfs-validator-reports artifact for report.json and report.html.
Artifacts are kept for 30 days; open report.html in a browser for the full report.

Research each disagreement against NJ Transit's file before changing anything
in Dale. A validator notice alone is not proof that Dale should change (D81).

GTFS validator by MobilityData, Apache License 2.0
