# Feasibility test

`asset-upload-feasibility.gs` is a disposable Apps Script test. It is not the production worker.

## Setup

Run it in a standalone Apps Script project with these Script Properties:

```text
AIRTABLE_PAT
AIRTABLE_BASE_ID             optional
VENTURE_ASSETS_TABLE_ID      optional
TEST_ASSET_RECORD_ID         disposable record
TEST_ATTACHMENT_ID           disposable attachment
TEST_DRIVE_FOLDER_ID         disposable Drive folder
```

Run `runFeasibilityTest()` only against disposable resources. The test leaves its Drive file in the configured test folder for inspection.

## Recorded result

Date: 2026-08-27

Decision: PASS

- Source size: 130,009,096 bytes.
- Three separated 1 MiB ranges returned HTTP 206 with correct byte counts.
- The attachment URL was refreshed before the final probe.
- Drive resumable upload completed with 4 MiB chunks.
- Final size, parent folder, and source metadata matched the fixture.
- A rerun reused the existing Drive file and did not create a duplicate.

Keep the test source separate from `production-apps-script/asset-upload-worker.gs`. Do not treat this result as proof of every production condition.
