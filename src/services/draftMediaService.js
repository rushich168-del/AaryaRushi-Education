import { supabase } from '../lib/supabaseClient.js'
import { buildDraftMediaRecord, draftUuid } from './draftPaperMapping.js'

// P0-B2: teacher-captured Draft visuals. Crops live in the existing PRIVATE source
// bucket under imports/<teacher>/draft-media/<paper>/<media>.png. Only the stable
// path is stored; short-lived signed URLs are generated for display.

const BUCKET = 'ksc-source-documents'
const SIGNED_URL_SECONDS = 300

export const draftMediaService = {
  // Upload the crop, then record it. If the record cannot be saved, the uploaded
  // object is removed (best effort) and the error is surfaced to the caller.
  async attachRegionCrop({ draftPaperId, owner, mediaKind, blob, region, sourcePage,
    pageWidthPt, pageHeightPt, renderScale, widthPx, heightPx, sourceImportId }) {
    const { data: auth, error: authError } = await supabase.auth.getUser()
    if (authError || !auth?.user?.id) throw new Error('You must be signed in as a teacher.')

    const record = buildDraftMediaRecord({
      id: draftUuid(), teacherId: auth.user.id, draftPaperId, owner, mediaKind, region, sourcePage,
      pageWidthPt, pageHeightPt, renderScale, widthPx, heightPx, sourceImportId,
    })

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(record.storage_path, blob, { contentType: 'image/png', upsert: false })
    if (uploadError) throw uploadError

    const { data, error } = await supabase.from('draft_media').insert(record).select().single()
    if (error) {
      const { error: cleanupError } = await supabase.storage.from(BUCKET).remove([record.storage_path])
      if (cleanupError) console.warn('[draftMedia] Uploaded crop could not be removed after a failed save:', record.storage_path, cleanupError)
      throw error
    }
    return data
  },

  // Fresh short-lived signed URLs for display: { [storage_path]: url }.
  async signedUrls(paths) {
    const unique = [...new Set((paths || []).filter(Boolean))]
    if (!unique.length) return {}
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(unique, SIGNED_URL_SECONDS)
    if (error) throw error
    return Object.fromEntries((data || []).filter(d => d.signedUrl).map(d => [d.path, d.signedUrl]))
  },

  // Remove the record first (so no card ever points at a missing object), then
  // the stored crop. A failed object delete leaves only an orphaned private file.
  async removeMedia(media) {
    const { error } = await supabase.from('draft_media').delete().eq('id', media.id)
    if (error) throw error
    const { error: storageError } = await supabase.storage.from(BUCKET).remove([media.storage_path])
    if (storageError) console.warn('[draftMedia] Record removed but crop could not be deleted:', media.storage_path, storageError)
  },
}
