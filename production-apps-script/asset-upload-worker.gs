/**
 * CDL Venture Asset Upload Worker.
 *
 * This file belongs to the standalone Asset-upload Apps Script project.
 * Keep the disposable feasibility test in asset-upload-feasibility.gs; this worker is invoked by
 * an installed one-minute time trigger and never by the Airtable form.
 */

var VAUP = Object.freeze({
  BASE_ID: "appb5aIrV0KGucNfX",
  ASSETS_TABLE_ID: "tblKhEC1EGewGvyrS",
  VENTURES_TABLE_ID: "tblwvGS9Zl8rfBuNo",
  AIRTABLE_API: "https://api.airtable.com/v0",
  DRIVE_UPLOAD_API: "https://www.googleapis.com/upload/drive/v3/files",
  DRIVE_FILES_API: "https://www.googleapis.com/drive/v3/files",
  CHUNK_SIZE: 4 * 1024 * 1024,
  MAX_ATTEMPTS: 3,
  STALE_MS: 15 * 60 * 1000,
  DEADLINE_MS: 4 * 60 * 1000,
  TIME_ZONE: "America/Toronto",
  TEST_MODE_PROPERTY: "VAUP_TEST_MODE",
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
    PITCH_URL: "fldMQYYtWzPokvK5s",
    DEMO_URL: "fld6jKkcEUDSYGZKv",
  },
  VENTURE_FIELDS: {
    FOLDER_URL: "fldDVCDr1aObRUGgt",
    PITCH_URL: "fldG6BUbKAHRGWfDX",
    DEMO_URL: "fld0G9wfKcleU7dk4",
  },
});

function runVaupWorker() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  var started = Date.now();
  var runId = Utilities.getUuid();
  var activeRecordId = null;
  try {
    var records = listAssetRecords_();
    recoverStale_(records);
    records = listAssetRecords_();
    var record = chooseWork_(records);
    if (!record) return;
    var claimed = claim_(record, runId);
    if (!claimed) return;
    activeRecordId = claimed.id;
    processRecord_(claimed, runId, started);
  } catch (error) {
    var message = String(error && error.message || "WORKER_ERROR");
    if (activeRecordId && message.indexOf("WORK_DEADLINE_OR_INCOMPLETE") < 0) fail_(activeRecordId, runId, sanitize_(message));
    Logger.log(JSON.stringify({ runId: runId, recordId: activeRecordId, code: "WORKER_ERROR", message: sanitize_(message) }));
  } finally {
    lock.releaseLock();
  }
}

function listAssetRecords_() {
  var url = airtableUrl_(VAUP.ASSETS_TABLE_ID) + "?pageSize=100&returnFieldsByFieldId=true";
  var response = airtableFetch_(url, "get");
  return (JSON.parse(response.getContentText()).records || []).filter(function (record) {
    var status = selectName_(record.fields[VAUP.FIELDS.STATUS]);
    return status === "Queued" || status === "Processing" || status === "Waiting for Folder";
  });
}

function chooseWork_(records) {
  return records.sort(function (a, b) {
    var at = Date.parse(a.fields[VAUP.FIELDS.QUEUED_AT] || "") || 0;
    var bt = Date.parse(b.fields[VAUP.FIELDS.QUEUED_AT] || "") || 0;
    return at - bt || a.id.localeCompare(b.id);
  })[0] || null;
}

function recoverStale_(records) {
  var now = Date.now();
  records.filter(function (record) {
    return selectName_(record.fields[VAUP.FIELDS.STATUS]) === "Processing" &&
      now - (Date.parse(record.fields[VAUP.FIELDS.LAST_PROGRESS_AT] || record.fields[VAUP.FIELDS.STARTED_AT] || "") || now) > VAUP.STALE_MS;
  }).forEach(function (record) {
    var attempts = Number(record.fields[VAUP.FIELDS.ATTEMPTS] || 0);
    patchAsset_(record.id, {
      [VAUP.FIELDS.STATUS]: attempts >= VAUP.MAX_ATTEMPTS ? "Error" : "Queued",
      [VAUP.FIELDS.ERROR]: attempts >= VAUP.MAX_ATTEMPTS ? "STALE_PROCESSING: attempts exhausted" : "STALE_PROCESSING: requeued after no progress",
      [VAUP.FIELDS.STARTED_AT]: null,
      [VAUP.FIELDS.WORKER_RUN_ID]: null,
    });
  });
}

function claim_(record, runId) {
  var status = selectName_(record.fields[VAUP.FIELDS.STATUS]);
  if (status !== "Queued" && status !== "Waiting for Folder" && status !== "Processing") return null;
  var attempts = Number(record.fields[VAUP.FIELDS.ATTEMPTS] || 0);
  if (status === "Queued" && attempts >= VAUP.MAX_ATTEMPTS) return null;
  var nextAttempts = status === "Queued" ? attempts + 1 : attempts;
  var now = new Date().toISOString();
  patchAsset_(record.id, {
    [VAUP.FIELDS.STATUS]: "Processing",
    [VAUP.FIELDS.ATTEMPTS]: nextAttempts,
    [VAUP.FIELDS.STARTED_AT]: record.fields[VAUP.FIELDS.STARTED_AT] || now,
    [VAUP.FIELDS.LAST_PROGRESS_AT]: now,
    [VAUP.FIELDS.WORKER_RUN_ID]: runId,
    [VAUP.FIELDS.ERROR]: null,
  });
  var refreshed = getAsset_(record.id);
  return refreshed.fields[VAUP.FIELDS.WORKER_RUN_ID] === runId ? refreshed : null;
}

function processRecord_(record, runId, started) {
  var fields = record.fields;
  var links = fields[VAUP.FIELDS.VENTURE_LINK] || [];
  if (!Array.isArray(links) || links.length !== 1) return fail_(record.id, runId, "INVALID_VENTURE_LINK");
  var ventureId = linkedRecordId_(links[0]);
  if (!ventureId) return fail_(record.id, runId, "INVALID_VENTURE_LINK");
  var venture = getVenture_(ventureId);
  var folderId = parseDriveFolderId_(venture.fields[VAUP.VENTURE_FIELDS.FOLDER_URL]);
  if (!folderId) {
    patchAsset_(record.id, { [VAUP.FIELDS.STATUS]: "Waiting for Folder", [VAUP.FIELDS.WORKER_RUN_ID]: null });
    return;
  }
  var manifest = parseManifest_(fields[VAUP.FIELDS.MANIFEST], record.id, ventureId);
  var refreshed = getAsset_(record.id);
  var latestFields = refreshed.fields;
  for (var index = 0; index < manifest.attachments.length; index += 1) {
    if (Date.now() - started >= VAUP.DEADLINE_MS) return;
    var item = manifest.attachments[index];
    if (item.completed && item.driveFileId) continue;
    var attachment = freshAttachment_(latestFields, item.id);
    if (!attachment) return fail_(record.id, runId, "ATTACHMENT_CHANGED_OR_REMOVED");
    var fileId = uploadAttachment_(record, manifest, item, attachment, folderId, started);
    item.driveFileId = fileId;
    item.driveUrl = "https://drive.google.com/file/d/" + fileId + "/view";
    item.completed = true;
    writeProgress_(record.id, runId, manifest, item.driveUrl, item.assetType);
  }
  completeRecord_(record.id, runId, manifest, venture.id);
}

function uploadAttachment_(record, manifest, item, attachment, folderId, started) {
  var existing = findManagedFile_(record.id, item.id, folderId);
  if (existing) return existing.id;
  var name = safeName_(item.filename);
  var marker = isTestMode_() ? { vaupTest: "true" } : { vaup: "true" };
  var metadata = { name: name, parents: [folderId], mimeType: item.mimeType, appProperties: Object.assign(marker, { sourceRecordId: record.id, sourceAttachmentId: item.id, assetType: item.assetType, queuedAt: String(manifest.queuedAt || "") }) };
  var sessionUrl = item.sessionUrl || "";
  var session;
  if (!sessionUrl) session = UrlFetchApp.fetch(VAUP.DRIVE_UPLOAD_API + "?uploadType=resumable", { method: "post", contentType: "application/json", payload: JSON.stringify(metadata), headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "X-Upload-Content-Type": item.mimeType, "X-Upload-Content-Length": String(item.size) }, muteHttpExceptions: true });
  if (!sessionUrl) {
    requireStatus_(session, 200, "Drive session initiation");
    sessionUrl = header_(session.getAllHeaders(), "Location");
    if (!sessionUrl) throw new Error("DRIVE_SESSION_URL_MISSING");
    item.sessionUrl = sessionUrl;
    writeProgress_(record.id, record.fields[VAUP.FIELDS.WORKER_RUN_ID], manifest, null, null);
  }
  var offset = Number(item.offset || 0);
  while (offset < item.size && Date.now() - started < VAUP.DEADLINE_MS) {
    var current = getAsset_(record.id).fields;
    var currentAttachment = freshAttachment_(current, item.id);
    if (!currentAttachment || Number(currentAttachment.size) !== Number(item.size)) throw new Error("ATTACHMENT_CHANGED_AFTER_SNAPSHOT");
    var end = Math.min(offset + VAUP.CHUNK_SIZE, item.size) - 1;
    var source = fetchSourceRange_(currentAttachment.url, offset, end, item.size);
    var response = UrlFetchApp.fetch(sessionUrl, { method: "put", contentType: item.mimeType, payload: source.bytes, headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "Content-Range": "bytes " + offset + "-" + end + "/" + item.size }, muteHttpExceptions: true });
    var status = response.getResponseCode();
    if (status === 200 || status === 201) {
      var uploadedId = JSON.parse(response.getContentText()).id;
      verifyDriveParent_(uploadedId, folderId);
      return uploadedId;
    }
    if (status === 308) offset = acknowledgedOffset_(response.getAllHeaders(), end + 1);
    else {
      offset = queryOffset_(sessionUrl, item.size);
      if (offset >= item.size) {
        var recovered = findManagedFile_(record.id, item.id, folderId);
        if (recovered) return recovered.id;
      }
    }
    item.offset = offset;
    writeProgress_(record.id, record.fields[VAUP.FIELDS.WORKER_RUN_ID], manifest, null, null);
  }
  throw new Error("WORK_DEADLINE_OR_INCOMPLETE");
}

function completeRecord_(recordId, runId, manifest, ventureId) {
  var completedAt = new Date().toISOString();
  var fields = { [VAUP.FIELDS.STATUS]: "Complete", [VAUP.FIELDS.COMPLETED_AT]: completedAt, [VAUP.FIELDS.LAST_PROGRESS_AT]: completedAt, [VAUP.FIELDS.WORKER_RUN_ID]: null, [VAUP.FIELDS.MANIFEST]: JSON.stringify(manifest) };
  manifest.attachments.forEach(function (item) {
    if (item.assetType === "pitch_deck") fields[VAUP.FIELDS.PITCH_URL] = item.driveUrl;
    if (item.assetType === "tech_demo") fields[VAUP.FIELDS.DEMO_URL] = item.driveUrl;
  });
  patchAsset_(recordId, fields);
  manifest.attachments.forEach(function (item) {
    if (item.assetType === "pitch_deck" || item.assetType === "tech_demo") promoteLatestIfNewest_(recordId, ventureId, item);
  });
}

function promoteLatestIfNewest_(recordId, ventureId, item) {
  var current = getAsset_(recordId);
  var queuedAt = current.fields[VAUP.FIELDS.QUEUED_AT] || "";
  var records = listAllAssetRecords_();
  var newest = { id: recordId, queuedAt: queuedAt, url: item.driveUrl };
  records.forEach(function (record) {
    var links = record.fields[VAUP.FIELDS.VENTURE_LINK] || [];
    if (!Array.isArray(links) || !links.some(function (link) { return linkedRecordId_(link) === ventureId; })) return;
    if (selectName_(record.fields[VAUP.FIELDS.STATUS]) !== "Complete") return;
    var manifest = safeManifest_(record.fields[VAUP.FIELDS.MANIFEST]);
    (manifest && manifest.attachments || []).forEach(function (candidate) {
      if (candidate.assetType !== item.assetType || !candidate.completed || !candidate.driveUrl) return;
      if (compareSubmissionOrder_(record.fields[VAUP.FIELDS.QUEUED_AT], record.id, newest.queuedAt, newest.id) > 0) newest = { id: record.id, queuedAt: record.fields[VAUP.FIELDS.QUEUED_AT] || "", url: candidate.driveUrl };
    });
  });
  if (newest.id !== recordId) return;
  var ventureFields = item.assetType === "pitch_deck" ? { [VAUP.VENTURE_FIELDS.PITCH_URL]: item.driveUrl } : { [VAUP.VENTURE_FIELDS.DEMO_URL]: item.driveUrl };
  patchVenture_(ventureId, ventureFields);
}

function listAllAssetRecords_() {
  var url = airtableUrl_(VAUP.ASSETS_TABLE_ID) + "?pageSize=100&returnFieldsByFieldId=true";
  return JSON.parse(airtableFetch_(url, "get").getContentText()).records || [];
}

function safeManifest_(value) {
  try { return value ? JSON.parse(value) : null; } catch (error) { return null; }
}

function compareSubmissionOrder_(leftQueuedAt, leftId, rightQueuedAt, rightId) {
  var left = Date.parse(leftQueuedAt || "") || 0;
  var right = Date.parse(rightQueuedAt || "") || 0;
  return left - right || String(leftId).localeCompare(String(rightId));
}

function writeProgress_(recordId, runId, manifest, url, assetType) {
  var fields = { [VAUP.FIELDS.MANIFEST]: JSON.stringify(manifest), [VAUP.FIELDS.LAST_PROGRESS_AT]: new Date().toISOString(), [VAUP.FIELDS.WORKER_RUN_ID]: runId };
  if (url && assetType === "pitch_deck") fields[VAUP.FIELDS.PITCH_URL] = url;
  if (url && assetType === "tech_demo") fields[VAUP.FIELDS.DEMO_URL] = url;
  patchAsset_(recordId, fields);
}

function fail_(recordId, runId, code) {
  var record = getAsset_(recordId);
  var attempts = Number(record.fields[VAUP.FIELDS.ATTEMPTS] || 0);
  patchAsset_(recordId, { [VAUP.FIELDS.STATUS]: attempts >= VAUP.MAX_ATTEMPTS ? "Error" : "Queued", [VAUP.FIELDS.ERROR]: sanitize_(code), [VAUP.FIELDS.WORKER_RUN_ID]: null, [VAUP.FIELDS.STARTED_AT]: null });
}

function parseManifest_(value, recordId, ventureId) {
  var manifest = value ? JSON.parse(value) : null;
  if (!manifest || manifest.version !== 1 || manifest.recordId !== recordId || manifest.ventureManagementRecordId !== ventureId || !Array.isArray(manifest.attachments)) throw new Error("INVALID_MANIFEST");
  return manifest;
}

function freshAttachment_(fields, attachmentId) {
  var ids = [VAUP.FIELDS.LOGOS, VAUP.FIELDS.HEADSHOTS, VAUP.FIELDS.PITCH_DECK, VAUP.FIELDS.TECH_DEMO];
  for (var i = 0; i < ids.length; i += 1) {
    var list = fields[ids[i]] || [];
    for (var j = 0; j < list.length; j += 1) if (list[j].id === attachmentId) return list[j];
  }
  return null;
}

function findManagedFile_(recordId, attachmentId, folderId) {
  var marker = isTestMode_() ? "vaupTest" : "vaup";
  var q = "trashed = false and '" + escapeQuery_(folderId) + "' in parents and appProperties has { key = '" + marker + "' and value = 'true' } and appProperties has { key = 'sourceRecordId' and value = '" + escapeQuery_(recordId) + "' } and appProperties has { key = 'sourceAttachmentId' and value = '" + escapeQuery_(attachmentId) + "' }";
  var url = VAUP.DRIVE_FILES_API + "?q=" + encodeURIComponent(q) + "&pageSize=10&fields=files(id)";
  var response = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  requireStatus_(response, 200, "Drive idempotency lookup");
  var files = JSON.parse(response.getContentText()).files || [];
  return files[0] || null;
}

function fetchSourceRange_(url, start, end, total) {
  var response = UrlFetchApp.fetch(url, { headers: { Range: "bytes=" + start + "-" + end }, muteHttpExceptions: true });
  var bytes = response.getBlob().getBytes();
  var range = header_(response.getAllHeaders(), "Content-Range");
  if (response.getResponseCode() !== 206 || bytes.length !== end - start + 1 || !range) throw new Error("SOURCE_RANGE_FAILED");
  return { bytes: bytes, range: range };
}

function verifyDriveParent_(fileId, folderId) {
  var url = VAUP.DRIVE_FILES_API + "/" + encodeURIComponent(fileId) + "?fields=id,parents";
  var response = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  requireStatus_(response, 200, "Drive parent verification");
  var file = JSON.parse(response.getContentText());
  if (!Array.isArray(file.parents) || file.parents.indexOf(folderId) < 0) throw new Error("DRIVE_PARENT_MISMATCH");
}

function queryOffset_(sessionUrl, total) {
  var response = UrlFetchApp.fetch(sessionUrl, { method: "put", payload: "", headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "Content-Range": "bytes */" + total }, muteHttpExceptions: true });
  var status = response.getResponseCode();
  if (status === 200 || status === 201) return total;
  if (status !== 308) throw new Error("DRIVE_SESSION_QUERY_FAILED");
  return acknowledgedOffset_(response.getAllHeaders(), 0);
}

function acknowledgedOffset_(headers, fallback) {
  var match = /bytes=0-(\d+)/i.exec(header_(headers, "Range"));
  return match ? Number(match[1]) + 1 : fallback;
}

function getAsset_(id) { return JSON.parse(airtableFetch_(airtableUrl_(VAUP.ASSETS_TABLE_ID) + "/" + encodeURIComponent(id) + "?returnFieldsByFieldId=true", "get").getContentText()); }
function getVenture_(id) {
  try {
    return JSON.parse(airtableFetch_(airtableUrl_(VAUP.VENTURES_TABLE_ID) + "/" + encodeURIComponent(id) + "?returnFieldsByFieldId=true", "get").getContentText());
  } catch (error) {
    throw new Error("VENTURE_RECORD_READ_FAILED id=" + id + " " + error.message);
  }
}
function patchAsset_(id, fields) { airtableFetch_(airtableUrl_(VAUP.ASSETS_TABLE_ID) + "/" + encodeURIComponent(id), "patch", { fields: fields, typecast: false }); }
function patchVenture_(id, fields) { airtableFetch_(airtableUrl_(VAUP.VENTURES_TABLE_ID) + "/" + encodeURIComponent(id), "patch", { fields: fields, typecast: false }); }

function airtableFetch_(url, method, body) {
  var pat = PropertiesService.getScriptProperties().getProperty("AIRTABLE_PAT");
  if (!pat) throw new Error("Missing Script Property: AIRTABLE_PAT");
  var options = { method: method, headers: { Authorization: "Bearer " + pat }, muteHttpExceptions: true };
  if (body) { options.contentType = "application/json"; options.payload = JSON.stringify(body); }
  var response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    var detail = sanitize_(response.getContentText());
    throw new Error("AIRTABLE_HTTP_" + response.getResponseCode() + (detail ? " " + detail : ""));
  }
  return response;
}

function isTestMode_() { return PropertiesService.getScriptProperties().getProperty(VAUP.TEST_MODE_PROPERTY) === "true"; }
function airtableUrl_(tableId) { return VAUP.AIRTABLE_API + "/" + encodeURIComponent(VAUP.BASE_ID) + "/" + encodeURIComponent(tableId); }
function selectName_(value) { return value && typeof value === "object" && value.name ? value.name : String(value || ""); }
function linkedRecordId_(value) { return typeof value === "string" ? value : value && typeof value.id === "string" ? value.id : null; }
function parseDriveFolderId_(value) { var match = /\/folders\/([a-zA-Z0-9_-]+)/.exec(String(value || "")); return match ? match[1] : null; }
function header_(headers, name) { var key = Object.keys(headers || {}).filter(function (x) { return x.toLowerCase() === name.toLowerCase(); })[0]; var value = key ? headers[key] : ""; return Array.isArray(value) ? value[0] : String(value || ""); }
function requireStatus_(response, expected, operation) { if (response.getResponseCode() !== expected) throw new Error(operation + " failed with HTTP " + response.getResponseCode()); }
function escapeQuery_(value) { return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function safeName_(value) { return String(value || "asset").replace(/[\u0000-\u001F\u007F]/g, "_").slice(0, 240); }
function sanitize_(value) { return String(value || "").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 300); }
