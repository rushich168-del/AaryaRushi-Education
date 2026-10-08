import * as pdfjsLib from 'pdfjs-dist'
import { supabase } from '../lib/supabaseClient.js'
import { draftPaperService } from './draftPaperService.js'
import { classifyExtractedText } from './draftPaperMapping.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

export const pdfAnalyzer = {
  reconstructLayout(bands, viewportWidth) {
    const W = viewportWidth || 600
    const M = W / 2
    const gapThreshold = Math.max(35, W * 0.05)
    const pageSegments = []

    bands.forEach(band => {
      band.items.sort((a, b) => a.x - b.x)
      
      if (band.items.length === 0) return
      let currentSegment = [band.items[0]]
      for (let i = 1; i < band.items.length; i++) {
        const prev = currentSegment[currentSegment.length - 1]
        const curr = band.items[i]
        const gap = curr.x - prev.right
        if (gap > gapThreshold) {
          pageSegments.push(currentSegment)
          currentSegment = [curr]
        } else {
          currentSegment.push(curr)
        }
      }
      pageSegments.push(currentSegment)
    })

    const processedSegments = pageSegments.map(items => {
      const minX = items[0].x
      const maxX = items[items.length - 1].right
      const text = items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim()
      const y = items[0].y
      
      let col = 'FULL'
      if (maxX <= M + (W * 0.05)) col = 'LEFT'
      else if (minX >= M - (W * 0.05)) col = 'RIGHT'
      
      return { text, y, minX, maxX, col }
    })

    processedSegments.sort((a, b) => b.y - a.y)

    const orderedLines = []
    let leftCol = []
    let rightCol = []

    const flushColumns = () => {
      leftCol.sort((a, b) => b.y - a.y).forEach(s => orderedLines.push(s))
      rightCol.sort((a, b) => b.y - a.y).forEach(s => orderedLines.push(s))
      leftCol = []
      rightCol = []
    }

    for (const seg of processedSegments) {
      if (seg.col === 'FULL') {
        flushColumns()
        orderedLines.push(seg)
      } else if (seg.col === 'LEFT') {
        leftCol.push(seg)
      } else {
        rightCol.push(seg)
      }
    }
    flushColumns()

    return orderedLines
  },

  fillNumberingGaps(candidates) {
    let lastQNum = -1
    
    for (const c of candidates) {
      const num = parseInt(c.question_number, 10)
      if (!isNaN(num)) {
        if (lastQNum !== -1 && num > lastQNum + 1) {
          c.warnings.push(`QUESTION_ORDER_SUSPICIOUS: Follows Q${lastQNum}, jumping to Q${num}. Preceding questions may have failed extraction.`)
        }
        lastQNum = num
      }
    }
    
    return candidates
  },

  async runPrototypeAnalysis(importRecord) {
    console.log("[pdfAnalyzer] Starting analysis for import:", importRecord.id)
    
    // 1. Get a secure signed URL for the source PDF
    const { data, error: signError } = await supabase.storage
      .from('ksc-source-documents')
      .createSignedUrl(importRecord.storage_path, 300) // 5 minutes

    if (signError) {
      console.error("[pdfAnalyzer] Signed URL error:", signError)
      throw new Error('Could not access source document: ' + signError.message)
    }

    const signedUrl = data?.signedUrl

    console.log('[PDF Analyze] storage path present:', Boolean(importRecord.storage_path))
    console.log('[PDF Analyze] signed URL present:', Boolean(signedUrl))
    console.log('[PDF Analyze] signed URL type:', typeof signedUrl)

    if (!signedUrl || typeof signedUrl !== 'string') {
      throw new Error('Could not create a valid signed PDF URL.')
    }

    console.log('[PDF Analyze] loading PDF')

    // 2. Load the PDF
    const loadingTask = pdfjsLib.getDocument({
      url: signedUrl
    })
    
    const pdf = await loadingTask.promise
    
    console.log('[PDF Analyze] PDF loaded:', pdf.numPages)
    
    const numPages = pdf.numPages
    const candidates = []
    const materials = []
    
    const getPageLayout = async (pageNum) => {
      const page = await pdf.getPage(pageNum)
      const viewport = page.getViewport({ scale: 1.0 })
      const content = await page.getTextContent()
      
      const bands = []
      content.items.forEach(item => {
        if (!item.str.trim()) return
        const x = item.transform[4]
        const y = item.transform[5]
        const width = item.width || 0
        
        let band = bands.find(b => Math.abs(b.y - y) < 6)
        if (!band) {
          band = { y, items: [] }
          bands.push(band)
        }
        band.items.push({ text: item.str, x, width, right: x + width })
      })

      return pdfAnalyzer.reconstructLayout(bands, viewport.width)
    }

    try {
      console.log("[pdfAnalyzer] Extracting layout-aware text from first pages...")
      
      let currentCandidate = null
      let currentOptBuffer = []
      let activeMaterialId = null
      
      const pushCandidate = () => {
        if (!currentCandidate) return
        
        if (currentOptBuffer.length > 0) {
           const optStr = currentOptBuffer.join(' ')
           const splits = optStr.split(/(?:\s|^)([1-4A-D])[\.\)]\s+/)
           const parsedOpts = []
           for (let j = 1; j < splits.length; j += 2) {
             parsedOpts.push(splits[j+1]?.trim() || '')
           }
           if (parsedOpts.length === 4) {
             currentCandidate.options = parsedOpts
           } else {
             currentCandidate.status = 'UNRESOLVED'
             currentCandidate.warnings.push('OPTIONS_INCOMPLETE_OR_AMBIGUOUS: Could not confidently parse exactly 4 options. Found: ' + parsedOpts.length)
           }
        } else {
           currentCandidate.status = 'UNRESOLVED'
           currentCandidate.warnings.push('OPTIONS_INCOMPLETE_OR_AMBIGUOUS: No options found for this question.')
        }

        const allText = (currentCandidate.question_text + ' ' + currentCandidate.options.join(' ')).toLowerCase()
        // Legacy (non-Unicode) Indic glyph encodings carry no readable text. Detected from
        // code points, not font names: this paper reports only generic font families.
        const legacy = classifyExtractedText(currentCandidate.question_text + ' ' + currentCandidate.options.join(' '))
        if (legacy.legacyUnreliable) {
           currentCandidate.warnings.push(`TELUGU_EXTRACTION_UNRELIABLE: Non-Unicode glyph encoding (${legacy.reason}); the extracted characters are not readable text. Capture the source region and enter the text manually.`)
        }
        
        if (allText.includes('figure') || allText.includes('diagram') || allText.includes('triangle')) {
           currentCandidate.status = 'UNRESOLVED'
           currentCandidate.warnings.push('VISUAL_CONTENT_REQUIRES_REVIEW: Contains visual keywords. No visual was captured automatically; attach the source region if the question depends on it.')
        }

        candidates.push(currentCandidate)
        currentCandidate = null
        currentOptBuffer = []
      }

      for (let i = 1; i <= Math.min(3, numPages); i++) {
        const lines = await getPageLayout(i)
        
        let startIndex = 0
        while (startIndex < Math.min(4, lines.length) && !/^\s*\d+\s*[\.\)]/.test(lines[startIndex].text) && !/^directions\s*:/i.test(lines[startIndex].text)) {
           startIndex++
        }

        for (let j = startIndex; j < lines.length; j++) {
          const line = lines[j].text
          
          if (/^directions\s*:/i.test(line)) {
            pushCandidate()
            activeMaterialId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx'.replace(/[xy]/g, c => (Math.random() * 16 | 0).toString(16))
            materials.push({
              id: activeMaterialId,
              material_type: 'PASSAGE',
              content_text: line,
              source_page: i
            })
            continue
          }
          
          const qMatch = /^\s*(\d+)\s*[\.\)]\s*(.*)/.exec(line)
          if (qMatch) {
            pushCandidate()
            currentCandidate = {
              question_number: qMatch[1],
              question_text: qMatch[2].trim(),
              options: [],
              source_page: i,
              status: 'NEEDS_REVIEW',
              warnings: [],
              material_id: activeMaterialId
            }
            if (activeMaterialId) {
              currentCandidate.warnings.push('Linked to shared passage material.')
            }
            continue
          }

          if (currentCandidate) {
            if (/^\s*[1-4A-D]\s*[\.\)]/.test(line) || currentOptBuffer.length > 0) {
              currentOptBuffer.push(line)
            } else {
              currentCandidate.question_text += '\n' + line
            }
          } else if (activeMaterialId) {
             const lastMat = materials[materials.length - 1]
             if (lastMat && lastMat.id === activeMaterialId) {
                lastMat.content_text += '\n' + line
             }
          }
        }
      }
      
      pushCandidate()

      if (candidates.length === 0) {
        candidates.push({
          question_number: '?',
          question_text: 'Failed to extract any structured questions.',
          options: [],
          source_page: 1,
          status: 'UNRESOLVED',
          warnings: ['Layout parser failed to find any valid question numbers.']
        })
      }

      // 3. Answer Key detection (Case D) - Check last 2 pages
      let keyText = ''
      for (let i = Math.max(1, numPages - 1); i <= numPages; i++) {
         keyText += (await getPageLayout(i)).map(l => l.text).join('\n') + '\n'
      }
      
      const keyTextLower = keyText.toLowerCase()
      const hasKeySection = keyTextLower.includes('key') || keyTextLower.includes('answers')
      this.applyAnswerKeyMappings(keyText, hasKeySection, candidates)

      // Consistency Check: flag non-sequential question numbers. fillNumberingGaps
      // mutates candidates in place, so it must not be cleared/re-copied here.
      this.fillNumberingGaps(candidates)

      console.log("[pdfAnalyzer] Answer keys mapped and sequence verified. Proceeding to save.")

    } catch (e) {
      console.error("[pdfAnalyzer] Extraction error:", e)
      throw e
    }

    // 4. Save to staging tables atomically
    try {
      console.log(`[pdfAnalyzer] Calling RPC ksc_replace_test_import_analysis with ${materials.length} materials, ${candidates.length} candidates`)
      const { error: rpcError } = await supabase.rpc('ksc_replace_test_import_analysis', {
        p_import_id: importRecord.id,
        p_materials: materials,
        p_candidates: candidates
      })
      
      if (rpcError) {
        console.error("[pdfAnalyzer] RPC Error:", rpcError)
        throw rpcError
      }
      
      console.log("[pdfAnalyzer] DB save successful.")
    } catch (e) {
      console.error("[pdfAnalyzer] DB Save caught error:", e)
      throw e
    }

    // P0-A: write the same analysis into the durable normalized Draft Paper.
    // This is the canonical preparation state for the new path. The legacy
    // candidate write above is left untouched for backward compatibility with
    // the existing Import Summary counts.
    let draftPaperId = null
    try {
      draftPaperId = await draftPaperService.replaceAnalysis(importRecord, {
        candidates,
        materials,
        source_page_count: numPages,
      })
      console.log("[pdfAnalyzer] Draft Paper persisted:", draftPaperId)
    } catch (e) {
      console.error("[pdfAnalyzer] Draft Paper write failed:", e)
      throw e
    }

    return { candidates, materials, draftPaperId }
  },

  applyAnswerKeyMappings(keyText, hasKeySection, candidates) {
    const keyMappingRegex = /(\d+)\s*(?:-|->|:|=)\s*([A-D1-4])/ig
    let keyMatch
    const mappedKeys = {}
    while ((keyMatch = keyMappingRegex.exec(keyText)) !== null) {
       mappedKeys[keyMatch[1]] = keyMatch[2]
    }

    candidates.forEach(c => {
      if (mappedKeys[c.question_number]) {
        const ansStr = mappedKeys[c.question_number]
        let index = parseInt(ansStr, 10) - 1
        if (isNaN(index)) {
          if (ansStr.toUpperCase() === 'A') index = 0
          if (ansStr.toUpperCase() === 'B') index = 1
          if (ansStr.toUpperCase() === 'C') index = 2
          if (ansStr.toUpperCase() === 'D') index = 3
        }
        if (index >= 0 && index < 4) {
          c.proposed_correct_index = index
          c.warnings = c.warnings || []
          c.warnings.push(`Proposed answer (${ansStr}) explicitly mapped from detected key.`)
        }
      }
      
      if (c.proposed_correct_index === undefined || c.proposed_correct_index === null) {
        c.proposed_correct_index = null
        c.status = 'UNRESOLVED'
        c.warnings = c.warnings || []
        c.warnings.push(hasKeySection 
          ? 'Answer Key section detected, but no explicit mapping found for this question.' 
          : 'No obvious answer key detected in document. Teacher verification required.')
      }
    })
  }
}
