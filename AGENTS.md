# Agent instructions

This repository contains the Asset-upload workflow only. The separate Venture Document Automation workflow creates venture folders and writes `Venture Management.Venture Folder`.

## Workflow boundary

- `production-airtable/asset-upload-intake.js` runs after the media or tech-demo Airtable form creates a `Venture Assets` record.
- `production-apps-script/asset-upload-worker.gs` runs from an installed Apps Script time trigger.
- The worker reads `Venture Folder` and uploads directly into that folder.
- Never create or use a `Venture Assets` child folder.
- Never read or write the legacy `Venture Assets Folder` field.
- Keep Airtable source attachments after transfer.

## Safety

- Do not commit PATs, shared tokens, OAuth credentials, temporary attachment URLs, or binary test data.
- Do not edit live Airtable, Apps Script, Drive, or production records unless the user explicitly requests that work.
- Repository changes do not deploy themselves.
- Use disposable records and Drive folders for integration or failure-mode tests.

## Before handoff

- Run `npm test` and `npm run check`.
- Check that the worker still uses `Venture Folder` as its only destination.
- Keep the README and changelog aligned with the source.
- State what was verified locally and what still requires live verification.
