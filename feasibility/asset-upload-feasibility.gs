/**
 * CDL Venture Asset Upload feasibility harness.
 *
 * Run runFeasibilityTest() from a standalone Apps Script project owned by the
 * durable automation account. This intentionally creates one disposable Drive
 * file in the configured test folder and leaves it there for inspection.
 *
 * Required Script Properties:
 *   AIRTABLE_PAT
 *   AIRTABLE_BASE_ID             (defaults to the production base below)
 *   VENTURE_ASSETS_TABLE_ID      (defaults to Venture Assets below)
 *   TEST_ASSET_RECORD_ID         (defaults to the prepared test record)
 *   TEST_ATTACHMENT_ID            (defaults to the prepared attachment)
 *   TEST_DRIVE_FOLDER_ID          (defaults to the prepared disposable folder)
 */

var CONFIG = Object.freeze({
  BASE_ID: "appb5aIrV0KGucNfX",
  ASSETS_TABLE_ID: "tblKhEC1EGewGvyrS",
  RECORD_ID: "recpO4vsdpQ20oHOQ",
  ATTACHMENT_ID: "attZZAOFd8n9aO6T7",
  DRIVE_FOLDER_ID: "1itWSZvLzBv4MQ6m1F0IpNyx0IgpdBqv8",
  CHUNK_SIZE: 4 * 1024 * 1024,
  RANGE_PROBE_SIZE: 1024 * 1024,
  DRIVE_API: "https://www.googleapis.com/upload/drive/v3/files",
  DRIVE_FILES_API: "https://www.googleapis.com/drive/v3/files",
  AIRTABLE_API: "https://api.airtable.com/v0",
  TIME_ZONE: "America/Toronto",
});

function runFeasibilityTest() {
  var props = PropertiesService.getScriptProperties();
  var cfg = {
    baseId: props.getProperty("AIRTABLE_BASE_ID") || CONFIG.BASE_ID,
    tableId: props.getProperty("VENTURE_ASSETS_TABLE_ID") || CONFIG.ASSETS_TABLE_ID,
    recordId: props.getProperty("TEST_ASSET_RECORD_ID") || CONFIG.RECORD_ID,
    attachmentId: props.getProperty("TEST_ATTACHMENT_ID") || CONFIG.ATTACHMENT_ID,
    folderId: props.getProperty("TEST_DRIVE_FOLDER_ID") || CONFIG.DRIVE_FOLDER_ID,
    pat: props.getProperty("AIRTABLE_PAT"),
  };
  if (!cfg.pat) throw new Error("Missing Script Property: AIRTABLE_PAT");

  var attachment = readAttachment_(cfg);
  var sourceEvidence = probeRanges_(cfg, attachment);
  var fileId = uploadResumable_(cfg, attachment);
  var metadata = verifyDriveFile_(fileId, cfg.folderId, attachment.size);

  var evidence = {
    test: "venture-asset-upload-feasibility",
    passed: sourceEvidence.passed && metadata.passed,
    attachmentId: cfg.attachmentId,
    sourceSize: attachment.size,
    sourceRangeEvidence: sourceEvidence,
    driveEvidence: metadata,
    completedAt: Utilities.formatDate(new Date(), CONFIG.TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
  };
  Logger.log(JSON.stringify(evidence));
  return evidence;
}

function readAttachment_(cfg) {
  var url = CONFIG.AIRTABLE_API + "/" + encodeURIComponent(cfg.baseId) + "/" + encodeURIComponent(cfg.tableId) + "/" + encodeURIComponent(cfg.recordId);
  var response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + cfg.pat },
    muteHttpExceptions: true,
  });
  requireStatus_(response, 200, "Airtable record read");
  var fields = JSON.parse(response.getContentText()).fields || {};
  var attachments = [];
  ["Company Logo(s)", "Founder's HeadShot(s)", "Non-Confidential Pitch Deck", "Tech Demo"].forEach(function (name) {
    if (Array.isArray(fields[name])) attachments = attachments.concat(fields[name]);
  });
  var match = attachments.filter(function (item) { return item.id === cfg.attachmentId; })[0];
  if (!match || !match.url || !Number.isFinite(match.size)) throw new Error("Configured attachment was not found or is malformed");
  return { id: match.id, url: match.url, size: Number(match.size), filename: match.filename, mimeType: match.type || "application/octet-stream" };
}

function probeRanges_(cfg, attachment) {
  var first = fetchRange_(attachment.url, 0, CONFIG.RANGE_PROBE_SIZE - 1, attachment.size);
  var secondStart = Math.min(attachment.size - CONFIG.RANGE_PROBE_SIZE, 50 * 1024 * 1024);
  var second = fetchRange_(attachment.url, secondStart, secondStart + CONFIG.RANGE_PROBE_SIZE - 1, attachment.size);
  var refreshedAttachment = readAttachment_(cfg);
  var refreshedStart = Math.max(0, attachment.size - CONFIG.RANGE_PROBE_SIZE);
  var refreshed = fetchRange_(refreshedAttachment.url, refreshedStart, attachment.size - 1, attachment.size);
  return {
    passed: first.status === 206 && second.status === 206 && refreshed.status === 206 && first.hash !== second.hash,
    probes: [first, second, refreshed],
  };
}

function fetchRange_(url, start, end, totalSize, retainBytes) {
  var response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Range: "bytes=" + start + "-" + end },
    muteHttpExceptions: true,
  });
  var status = response.getResponseCode();
  var headers = response.getAllHeaders();
  var contentRange = header_(headers, "Content-Range");
  var data = response.getBlob().getBytes();
  var bytes = data.length;
  var expected = end - start + 1;
  if (status !== 206 || !/^bytes \d+-\d+\//.test(contentRange) || bytes !== expected) {
    throw new Error("SOURCE_RANGE_FAILED status=" + status + " bytes=" + bytes + " expected=" + expected);
  }
  var result = { status: status, contentRange: contentRange, bytes: bytes, hash: digest_(data) };
  if (retainBytes) result.bytes = data;
  return result;
}

function uploadResumable_(cfg, attachment) {
  var name = "VAUP FEASIBILITY - " + attachment.filename;
  var metadata = { name: name, parents: [cfg.folderId], mimeType: attachment.mimeType, appProperties: { vaupTest: "true", sourceAttachmentId: attachment.id, sourceRecordId: cfg.recordId } };
  var existing = findExistingFile_(cfg, attachment.id);
  if (existing) return existing.id;
  var session = UrlFetchApp.fetch(CONFIG.DRIVE_API + "?uploadType=resumable", {
    method: "post", contentType: "application/json", payload: JSON.stringify(metadata),
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "X-Upload-Content-Type": attachment.mimeType, "X-Upload-Content-Length": String(attachment.size) }, muteHttpExceptions: true,
  });
  requireStatus_(session, 200, "Drive resumable session initiation");
  var sessionUrl = header_(session.getAllHeaders(), "Location");
  if (!sessionUrl) throw new Error("Drive did not return a resumable session URL");
  var offset = 0;
  while (offset < attachment.size) {
    var current = readAttachment_(cfg);
    if (current.id !== attachment.id || current.size !== attachment.size) throw new Error("ATTACHMENT_CHANGED_AFTER_SNAPSHOT");
    var end = Math.min(offset + CONFIG.CHUNK_SIZE, attachment.size) - 1;
    var chunk = fetchRange_(current.url, offset, end, attachment.size, true);
    var response = UrlFetchApp.fetch(sessionUrl, {
      method: "put", contentType: attachment.mimeType, payload: chunk.bytes,
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "Content-Range": "bytes " + offset + "-" + end + "/" + attachment.size }, muteHttpExceptions: true,
    });
    var status = response.getResponseCode();
    if (status === 200 || status === 201) return JSON.parse(response.getContentText()).id;
    if (status === 308) { offset = acknowledgedOffset_(response.getAllHeaders(), end + 1); continue; }
    offset = queryUploadOffset_(sessionUrl, attachment.size);
    if (offset >= attachment.size) {
      var completed = findExistingFile_(cfg, attachment.id);
      if (completed) return completed.id;
    }
    if (offset >= end + 1) continue;
    throw new Error("DRIVE_CHUNK_FAILED status=" + status + " offset=" + offset);
  }
  throw new Error("DRIVE_UPLOAD_INCOMPLETE");
}

function findExistingFile_(cfg, attachmentId) {
  var q = "trashed = false and appProperties has { key = 'vaupTest' and value = 'true' } and appProperties has { key = 'sourceAttachmentId' and value = '" + escapeDriveQuery_(attachmentId) + "' } and appProperties has { key = 'sourceRecordId' and value = '" + escapeDriveQuery_(cfg.recordId) + "' }";
  var url = CONFIG.DRIVE_FILES_API + "?q=" + encodeURIComponent(q) + "&pageSize=10&fields=files(id)";
  var response = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  requireStatus_(response, 200, "Drive idempotency lookup");
  var files = JSON.parse(response.getContentText()).files || [];
  return files.length ? files[0] : null;
}

function queryUploadOffset_(sessionUrl, totalSize) {
  var response = UrlFetchApp.fetch(sessionUrl, { method: "put", payload: "", headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken(), "Content-Range": "bytes */" + totalSize }, muteHttpExceptions: true });
  var status = response.getResponseCode();
  if (status === 200 || status === 201) return totalSize;
  if (status !== 308) throw new Error("DRIVE_SESSION_QUERY_FAILED status=" + status);
  return acknowledgedOffset_(response.getAllHeaders(), 0);
}

function acknowledgedOffset_(headers, fallback) {
  var range = header_(headers, "Range");
  var match = /bytes=0-(\d+)/i.exec(range);
  return match ? Number(match[1]) + 1 : fallback;
}

function escapeDriveQuery_(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function verifyDriveFile_(fileId, folderId, expectedSize) {
  var url = CONFIG.DRIVE_FILES_API + "/" + encodeURIComponent(fileId) + "?fields=id,name,size,parents,appProperties";
  var response = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  requireStatus_(response, 200, "Drive metadata verification");
  var file = JSON.parse(response.getContentText());
  return { passed: String(file.size) === String(expectedSize) && Array.isArray(file.parents) && file.parents.indexOf(folderId) >= 0, id: file.id, name: file.name, size: Number(file.size), parents: file.parents, appProperties: file.appProperties || {} };
}

function requireStatus_(response, expected, operation) {
  if (response.getResponseCode() !== expected) throw new Error(operation + " failed with HTTP " + response.getResponseCode());
}

function header_(headers, name) {
  var key = Object.keys(headers || {}).filter(function (candidate) { return candidate.toLowerCase() === name.toLowerCase(); })[0];
  var value = key ? headers[key] : "";
  return Array.isArray(value) ? value[0] : String(value || "");
}

function digest_(bytes) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)).slice(0, 16);
}
