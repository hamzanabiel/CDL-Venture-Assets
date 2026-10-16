const CONFIG = {
  TABLE_ID: "tblKhEC1EGewGvyrS",
  FIELDS: {
    VENTURE_LINK: "fld9TupZUWzP1mbMk",
    LOGOS: "fldKETNjqynzL7oX0",
    HEADSHOTS: "fldgd25eu0ykNUqWb",
    PITCH_DECK: "fldcZA72N03TZnVmT",
    TECH_DEMO: "fldCJLZfpqbN5Vn9w",
    STATUS: "fld4ZVRAmS2kQtfOe",
    QUEUED_AT: "fldusoEqVLoL3VJ64",
    STARTED_AT: "fld66ylV2jf6pMber",
    LAST_PROGRESS_AT: "fldsXXSc5Xns36o9l",
    COMPLETED_AT: "fldhkwmPhafKIng9J",
    ATTEMPTS: "fldd5vXHd9CIADpBq",
    WORKER_RUN_ID: "fldsIsGP8v6DyGnHd",
    ERROR: "fld5VBW4OvyRovF0f",
    MANIFEST: "fldkzDLMvQrel14ye",
  },
};

const STATUS = { QUEUED: "Queued" };
const { recordId } = input.config();

assertConfigured(CONFIG);
if (!recordId || typeof recordId !== "string") throw new Error("Missing automation input: recordId");

const table = base.getTable(CONFIG.TABLE_ID);
const record = await table.selectRecordAsync(recordId);
if (!record) throw new Error(`Venture Assets record not found: ${recordId}`);

const ventureLinks = readArray(record.getCellValue(CONFIG.FIELDS.VENTURE_LINK));
if (ventureLinks.length !== 1) throw new Error("Submission must link to exactly one Venture Management record");

const attachments = []
  .concat(snapshotAttachments(record, CONFIG.FIELDS.LOGOS, "logo"))
  .concat(snapshotAttachments(record, CONFIG.FIELDS.HEADSHOTS, "headshot"))
  .concat(snapshotAttachments(record, CONFIG.FIELDS.PITCH_DECK, "pitch_deck"))
  .concat(snapshotAttachments(record, CONFIG.FIELDS.TECH_DEMO, "tech_demo"));

if (!attachments.length) throw new Error("Submission must contain at least one attachment");
if (attachments.filter((item) => item.assetType === "pitch_deck").length > 1) throw new Error("Submission may contain at most one pitch deck");
if (attachments.filter((item) => item.assetType === "tech_demo").length > 1) throw new Error("Submission may contain at most one tech demo");

const queuedAt = new Date().toISOString();
const manifest = {
  version: 1,
  recordId,
  ventureManagementRecordId: ventureLinks[0].id,
  queuedAt,
  attachments,
};

await table.updateRecordAsync(recordId, {
  [CONFIG.FIELDS.STATUS]: { name: STATUS.QUEUED },
  [CONFIG.FIELDS.QUEUED_AT]: queuedAt,
  [CONFIG.FIELDS.STARTED_AT]: null,
  [CONFIG.FIELDS.LAST_PROGRESS_AT]: null,
  [CONFIG.FIELDS.COMPLETED_AT]: null,
  [CONFIG.FIELDS.ATTEMPTS]: 0,
  [CONFIG.FIELDS.WORKER_RUN_ID]: null,
  [CONFIG.FIELDS.ERROR]: null,
  [CONFIG.FIELDS.MANIFEST]: JSON.stringify(manifest),
});

output.set("queued", true);
output.set("recordId", recordId);
output.set("attachmentCount", attachments.length);

function snapshotAttachments(record, fieldId, assetType) {
  return readArray(record.getCellValue(fieldId)).map((attachment) => {
    if (!attachment || typeof attachment.id !== "string" || typeof attachment.filename !== "string") {
      throw new Error(`Malformed ${assetType} attachment metadata`);
    }
    if (!Number.isFinite(attachment.size) || attachment.size < 0) throw new Error(`Malformed ${assetType} attachment size`);
    return {
      id: attachment.id,
      assetType,
      filename: attachment.filename,
      size: attachment.size,
      mimeType: attachment.type || "application/octet-stream",
    };
  });
}

function readArray(value) {
  return Array.isArray(value) ? value : [];
}

function assertConfigured(config) {
  const values = [config.TABLE_ID, ...Object.values(config.FIELDS)];
  if (values.some((value) => !value || value.includes("REPLACE"))) throw new Error("Asset-upload Airtable configuration is incomplete");
}
