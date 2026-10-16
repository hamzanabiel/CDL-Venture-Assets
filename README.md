# CDL Venture Assets

This repository contains the production Asset-upload workflow. Founders submit media or tech-demo forms in Airtable. The workflow transfers the attachments into the existing venture folder in Google Drive.

## Production status

The owner confirmed that this workflow is in production. The separate Venture Document Automation workflow creates the venture folder and writes `Venture Management.Venture Folder`. This repository reads that URL. It does not create folders or a `Venture Assets` child folder.

Deployment versions, trigger ownership, and secret locations are live configuration and are not stored here.

## Workflow

1. A founder submits the media form or tech-demo form.
2. Airtable creates a record in the `Venture Assets` table.
3. The form automation runs `production-airtable/asset-upload-intake.js` with `recordId`.
4. The intake script validates the link and attachments, snapshots metadata in a manifest, and sets the record to `Queued`.
5. An installed Apps Script time trigger runs `runVaupWorker()`.
6. The worker reads `Venture Folder`, uploads files directly into that folder, and writes progress back to Airtable.

Use the same intake script for both form automations when both forms write to the same table and fields.

## Files

```text
production-airtable/asset-upload-intake.js       Airtable form intake
production-apps-script/asset-upload-worker.gs    Apps Script upload worker
production-apps-script/appsscript.json           Apps Script manifest
tests/                                            Local source-contract test
```

## Airtable setup

Pass this input to the Airtable script:

```text
recordId = the triggering Venture Assets record ID
```

The script requires exactly one linked Venture Management record and at least one attachment. It permits multiple logos and headshots, but no more than one pitch deck or tech demo per submission.

Important field IDs used by the source:

| Field | ID |
| --- | --- |
| Venture Assets table | `tblKhEC1EGewGvyrS` |
| Venture Management link | `fld9TupZUWzP1mbMk` |
| Company Logo(s) | `fldKETNjqynzL7oX0` |
| Founder's HeadShot(s) | `fldgd25eu0ykNUqWb` |
| Non-Confidential Pitch Deck | `fldcZA72N03TZnVmT` |
| Tech Demo | `fldCJLZfpqbN5Vn9w` |
| Drive Upload Status | `fld4ZVRAmS2kQtfOe` |
| Drive Upload Manifest | `fldkzDLMvQrel14ye` |
| Venture Folder | `fldDVCDr1aObRUGgt` |

Recheck field IDs, field types, and select values against the live base before changing or redeploying the workflow.

## Apps Script setup

Deploy `production-apps-script/asset-upload-worker.gs` in the standalone Asset-upload Apps Script project with `production-apps-script/appsscript.json`.

Install one time-driven trigger for `runVaupWorker`, normally once per minute, under the durable automation account.

Set this Script Property:

```text
AIRTABLE_PAT = dedicated Airtable personal access token
```

Set `VAUP_TEST_MODE=true` only in a disposable test project.

## Worker behavior

- Uses a script lock and deterministic queue order.
- Starts with 4 MiB Drive resumable-upload chunks.
- Refreshes Airtable attachment URLs by attachment ID.
- Uses Drive app properties and source IDs for idempotency.
- Allows three failed attempts and recovers stale progress after 15 minutes.
- Uses a four-minute internal execution deadline.
- Writes per-submission pitch-deck and tech-demo URLs.
- Updates Venture Management only when the completed submission is the newest one.
- Keeps Airtable attachments in place.
- Never reads or writes the legacy `Venture Assets Folder` field.

The checked-in worker does not implement latest checkboxes or filename renaming. Confirm those behaviors against the deployed worker before documenting them as live.

## Transfer evidence

A disposable transfer test previously passed for a 130,009,096-byte attachment using 4 MiB chunks. It verified byte ranges, refreshed attachment URLs, resumable Drive upload, exact size, destination parent, metadata, and an idempotent rerun. The temporary test harness and fixture details are not part of this production repository.

## Checks

```bash
npm test
npm run check
```

These checks validate local source contracts and syntax. They do not deploy code or prove live Airtable, Apps Script, or Drive behavior.
