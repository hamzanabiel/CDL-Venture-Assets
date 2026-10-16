const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const intake = fs.readFileSync("production-airtable/asset-upload-intake.js", "utf8");
const worker = fs.readFileSync("production-apps-script/asset-upload-worker.gs", "utf8");

test("intake queues Venture Assets records and snapshots all four asset types", () => {
  assert.match(intake, /TABLE_ID:\s*"tblKhEC1EGewGvyrS"/);
  assert.match(intake, /input\.config\(\)/);
  for (const assetType of ["logo", "headshot", "pitch_deck", "tech_demo"]) {
    assert.match(intake, new RegExp(`snapshotAttachments\\([^\\n]+"${assetType}"`));
  }
  assert.match(intake, /STATUS\.QUEUED/);
  assert.match(intake, /MANIFEST/);
});

test("worker uses the Venture Folder destination and Drive metadata", () => {
  assert.match(worker, /FOLDER_URL:\s*"fldDVCDr1aObRUGgt"/);
  assert.match(worker, /parseDriveFolderId_/);
  assert.match(worker, /sourceAttachmentId/);
  assert.match(worker, /sourceRecordId/);
  assert.match(worker, /CHUNK_SIZE:\s*4 \* 1024 \* 1024/);
  assert.doesNotMatch(worker, /Venture Assets Folder/);
});

test("worker has the installed trigger entry point", () => {
  assert.match(worker, /function runVaupWorker\(\)/);
  assert.match(worker, /LockService\.getScriptLock\(\)/);
});
