export function getFriendlyError(error, fallback = 'Something went wrong. Please try again.') {
  const message = String(error?.message || error || '').trim()

  if (!message) {
    return fallback
  }

  // A genuine size failure is flagged explicitly by the validator (see
  // validateSize). Only then do we talk about the 10 MB limit — never as a
  // catch-all, so other failures are not mislabelled as "file too large".
  if (error?.code === 'FILE_TOO_LARGE' || /too large|payload too large|413|exceeds the maximum|maximum allowed size/i.test(message)) {
    return message.startsWith('File is too large') ? message : 'File is too large. Maximum size is 10 MB.'
  }

  if (/supabase|environment|placeholder/i.test(message)) {
    return 'Project Atlas is not connected to Supabase yet. Check the deployment environment settings.'
  }

  if (/jwt|auth|session|row level security|permission|policy|not authorized|unauthorized/i.test(message)) {
    return 'You do not have access to complete that action in this workspace.'
  }

  // Missing product context (product not seeded/enabled in this workspace). The
  // raw guard text ("No product is selected") is technically accurate but reads
  // like a UI mistake; surface a precise, actionable message instead.
  if (/no product is selected|product is not set up|product setup/i.test(message)) {
    return 'This product is not set up in your workspace yet. Please refresh, or contact your workspace admin to enable it.'
  }

  // Database write rejected because the product/record is not fully provisioned in
  // this workspace: surfaced accurately instead of being masked as a size problem.
  // Kept narrow (specific Postgres error phrasing) so it never mis-labels an
  // unrelated storage read/download failure.
  if (/foreign key|violates .*constraint|not-null constraint|null value in column/i.test(message)) {
    return 'This product is not fully set up in your workspace yet, so the file could not be saved. Ask your workspace admin to enable it, then try again.'
  }

  if (/duplicate|already exists|resource already exists/i.test(message)) {
    return 'A file with this name was already uploaded. Rename the file and try again.'
  }

  if (/bucket (?:not found|does not exist)|no such bucket/i.test(message)) {
    return 'Storage is not configured for this product yet. Ask your workspace admin to set it up.'
  }

  if (/network|failed to fetch|fetch/i.test(message)) {
    return 'Network connection failed. Check the connection and try again.'
  }

  return fallback
}

export function getUploadError(error, kind) {
  const technicalDetail = String(error?.message || '').trim()
  // Neutral fallback: it no longer blames file size, because most upload failures
  // are not size-related. Real size failures are handled by the size pattern in
  // getFriendlyError; everything else shows this message plus the technical detail.
  const fallback = kind === 'template'
    ? 'Template upload could not be completed. See the detail below and try again.'
    : 'Excel upload could not be completed. See the detail below and try again.'

  return {
    message: getFriendlyError(error, fallback),
    technicalDetail,
  }
}

export function getStorageError(error) {
  return {
    message: getFriendlyError(error, 'The DOCX was generated locally, but could not be stored in History. You can still download the local file now.'),
    technicalDetail: String(error?.message || '').trim(),
  }
}

export function getDownloadError(error) {
  return {
    message: getFriendlyError(error, 'Download failed. Try again from History in a moment.'),
    technicalDetail: String(error?.message || '').trim(),
  }
}
