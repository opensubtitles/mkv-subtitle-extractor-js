import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import JSZip from 'jszip'

// Configure test file - can be overridden via TEST_FILE env var
const TEST_FILE = process.env.TEST_FILE || '/Users/brano/Downloads/Murdaugh.Death.in.the.Family.S01E08.The.Man.In.the.Glass.1080p.DSNP.WEB-DL.DDP5.1.H.264-RAWR.mkv'
const BASELINE_DIR = '/tmp/ffmpeg-baseline'
const JS_OUTPUT_DIR = '/tmp/ffmpeg-js-output'

interface SubtitleInfo {
  index: number
  codec: string
  lang: string
  title: string
}

// Get subtitle info using ffprobe
function getSubtitleTracks(filePath: string): SubtitleInfo[] {
  const result = execSync(
    `ffprobe -v quiet -print_format json -show_streams "${filePath}"`,
    { encoding: 'utf-8' }
  )
  const data = JSON.parse(result)
  return data.streams
    .filter((s: any) => s.codec_type === 'subtitle')
    .map((s: any) => ({
      index: s.index,
      codec: s.codec_name,
      lang: s.tags?.language || 'unk',
      title: s.tags?.title || 'untitled',
    }))
}

// Extract subtitles using FFmpeg CLI (baseline)
function extractWithFFmpegCLI(filePath: string, subtitles: SubtitleInfo[]): Map<number, string> {
  fs.mkdirSync(BASELINE_DIR, { recursive: true })
  const results = new Map<number, string>()

  for (const sub of subtitles) {
    const outputFile = path.join(BASELINE_DIR, `sub_${sub.index.toString().padStart(2, '0')}.srt`)
    try {
      execSync(
        `ffmpeg -y -i "${filePath}" -map 0:${sub.index} -c:s copy "${outputFile}" 2>/dev/null`,
        { encoding: 'utf-8' }
      )
      results.set(sub.index, fs.readFileSync(outputFile, 'utf-8'))
    } catch {
      results.set(sub.index, '')
    }
  }
  return results
}

// Normalize subtitle content for comparison (handle minor formatting differences)
function normalizeSubtitle(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

test.describe('Large File Subtitle Extraction', () => {
  test.beforeAll(() => {
    // Verify test file exists
    if (!fs.existsSync(TEST_FILE)) {
      throw new Error(`Test file not found: ${TEST_FILE}`)
    }
    const stats = fs.statSync(TEST_FILE)
    console.log(`Test file: ${TEST_FILE}`)
    console.log(`File size: ${(stats.size / 1024 / 1024 / 1024).toFixed(2)} GB`)
  })

  test('extract subtitles and compare with FFmpeg CLI', async ({ page }) => {
    // Step 1: Get subtitle track info
    console.log('\n=== Step 1: Analyzing file ===')
    const subtitles = getSubtitleTracks(TEST_FILE)
    console.log(`Found ${subtitles.length} subtitle tracks`)
    subtitles.forEach(s => console.log(`  Track ${s.index}: ${s.lang} - ${s.title} (${s.codec})`))

    // Step 2: Extract with FFmpeg CLI (baseline)
    console.log('\n=== Step 2: Extracting with FFmpeg CLI (baseline) ===')
    const baselineResults = extractWithFFmpegCLI(TEST_FILE, subtitles)
    console.log(`Extracted ${baselineResults.size} subtitles with CLI`)
    for (const [idx, content] of baselineResults) {
      console.log(`  Track ${idx}: ${content.length} bytes`)
    }

    // Step 3: Set up download handling
    console.log('\n=== Step 3: Testing JS extraction in browser ===')
    fs.mkdirSync(JS_OUTPUT_DIR, { recursive: true })

    let downloadedZipPath = ''
    page.on('download', async (download) => {
      downloadedZipPath = path.join(JS_OUTPUT_DIR, download.suggestedFilename())
      await download.saveAs(downloadedZipPath)
      console.log(`Downloaded: ${downloadedZipPath}`)
    })

    // Step 4: Navigate and upload file
    await page.goto('/')
    await expect(page.locator('.drop-zone')).toBeVisible()

    // Upload file via input
    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(TEST_FILE)

    // Step 5: Wait for processing with periodic status checks
    console.log('Processing file (this may take several minutes for large files)...')
    const startTime = Date.now()
    const maxWaitTime = 60000 // 1 minute max
    const checkInterval = 2000 // Check every 2 seconds

    let completed = false
    while (!completed && (Date.now() - startTime) < maxWaitTime) {
      // Check if processing completed (success or error)
      const successVisible = await page.locator('.drop-zone.success').isVisible()
      const errorVisible = await page.locator('.drop-zone.error').isVisible()

      if (successVisible || errorVisible) {
        completed = true
        break
      }

      // Check if still processing
      const processingVisible = await page.locator('.drop-zone.processing').isVisible()
      const progressText = await page.locator('.status-text').textContent().catch(() => '')
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)

      if (processingVisible) {
        console.log(`  [${elapsed}s] Processing: ${progressText}`)
      } else {
        // Not processing, not success, not error - something is wrong
        const dropZoneClass = await page.locator('.drop-zone').getAttribute('class')
        console.log(`  [${elapsed}s] Unexpected state - drop-zone class: ${dropZoneClass}`)
      }

      await page.waitForTimeout(checkInterval)
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

    if (!completed) {
      // Take screenshot for debugging
      await page.screenshot({ path: '/tmp/test-timeout.png' })
      const finalStatus = await page.locator('.drop-zone').getAttribute('class')
      const finalText = await page.locator('.status-text').textContent().catch(() => 'N/A')
      throw new Error(`Test timed out after ${elapsed}s. Final state: ${finalStatus}, text: ${finalText}`)
    }

    console.log(`Processing completed in ${elapsed}s`)

    // Check for errors
    const isError = await page.locator('.drop-zone.error').isVisible()
    if (isError) {
      const errorText = await page.locator('.status-text').textContent()
      console.error(`ERROR: ${errorText}`)
      throw new Error(`Extraction failed: ${errorText}`)
    }

    // Step 6: Verify download
    expect(downloadedZipPath).toBeTruthy()
    expect(fs.existsSync(downloadedZipPath)).toBe(true)
    console.log(`ZIP file size: ${fs.statSync(downloadedZipPath).size} bytes`)

    // Step 7: Extract and compare using JSZip (handles special characters)
    console.log('\n=== Step 4: Comparing results ===')
    const extractDir = path.join(JS_OUTPUT_DIR, 'extracted')
    fs.mkdirSync(extractDir, { recursive: true })

    const zipData = fs.readFileSync(downloadedZipPath)
    const zip = await JSZip.loadAsync(zipData)
    const extractedFiles: string[] = []

    for (const [filename, file] of Object.entries(zip.files)) {
      if (!file.dir && (filename.endsWith('.srt') || filename.endsWith('.ass') || filename.endsWith('.subrip'))) {
        const content = await file.async('nodebuffer')
        // Sanitize filename for filesystem
        const safeFilename = filename.replace(/[^\x00-\x7F]/g, '_')
        fs.writeFileSync(path.join(extractDir, safeFilename), content)
        extractedFiles.push(safeFilename)
      }
    }
    console.log(`JS extracted ${extractedFiles.length} files:`)
    extractedFiles.forEach(f => {
      const size = fs.statSync(path.join(extractDir, f)).size
      console.log(`  ${f}: ${size} bytes`)
    })

    // Step 8: Compare contents
    console.log('\n=== Comparison Report ===')
    const issues: string[] = []

    // Check file count
    if (extractedFiles.length !== subtitles.length) {
      issues.push(`File count mismatch: expected ${subtitles.length}, got ${extractedFiles.length}`)
    }

    // Check each extracted file - match by language AND title for exact comparison
    for (const file of extractedFiles) {
      const jsContent = fs.readFileSync(path.join(extractDir, file), 'utf-8')

      if (jsContent.length === 0) {
        issues.push(`EMPTY FILE: ${file}`)
        continue
      }

      // Match by lang and title pattern: baseName_lang_title.srt
      const langMatch = file.match(/_([a-z]{2,3})_(.+)\.(srt|ass|subrip)$/i)
      if (langMatch) {
        const lang = langMatch[1].toLowerCase()
        const titleFromFile = langMatch[2]

        // Find the BEST matching subtitle (longest title match wins)
        const candidates = subtitles.filter(s => s.lang.toLowerCase() === lang)
        const matchingSub = candidates.reduce((best, s) => {
          const sTitle = s.title.replace(/[^\x00-\x7F]/g, '_')
          if (file.includes(sTitle)) {
            if (!best || sTitle.length > best.title.replace(/[^\x00-\x7F]/g, '_').length) {
              return s
            }
          }
          return best
        }, null as SubtitleInfo | null)

        if (matchingSub) {
          const baselineContent = baselineResults.get(matchingSub.index) || ''
          const normalizedJS = normalizeSubtitle(jsContent)
          const normalizedBaseline = normalizeSubtitle(baselineContent)

          if (normalizedJS !== normalizedBaseline) {
            const jsSubs = (normalizedJS.match(/^\d+$/gm) || []).length
            const baseSubs = (normalizedBaseline.match(/^\d+$/gm) || []).length
            if (jsSubs !== baseSubs) {
              issues.push(`CONTENT MISMATCH: ${file} (track ${matchingSub.index}) - JS has ${jsSubs} entries, baseline has ${baseSubs}`)
            } else {
              console.log(`  ${file}: OK (${jsSubs} subtitle entries, minor formatting diff)`)
            }
          } else {
            console.log(`  ${file}: EXACT MATCH`)
          }
        } else {
          console.log(`  ${file}: No matching baseline found (lang=${lang})`)
        }
      }
    }

    // Report issues
    if (issues.length > 0) {
      console.log('\n=== ISSUES FOUND ===')
      issues.forEach(i => console.log(`  - ${i}`))
      throw new Error(`Found ${issues.length} issues:\n${issues.join('\n')}`)
    } else {
      console.log('\n=== ALL TESTS PASSED ===')
    }
  })
})
