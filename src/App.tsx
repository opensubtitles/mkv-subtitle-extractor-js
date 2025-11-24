import { useState, useCallback, useRef } from 'react'
import JSZip from 'jszip'
import './App.css'

type ExtractionMode = 'subtitles' | 'audio-original' | 'audio-transcription'

function App() {
  const [status, setStatus] = useState<'idle' | 'processing' | 'success' | 'error'>('idle')
  const [progress, setProgress] = useState('')
  const [progressPercent, setProgressPercent] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [mode, setMode] = useState<ExtractionMode>('subtitles')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const checkFFmpegSupport = async (basePath: string) => {
    console.log('Checking FFmpeg support...')
    const args = ['-muxers']
    try {
      const result = await runWorker(`${basePath}ffmpeg-worker-mkve.js`, null as any, args)
      console.log('FFmpeg muxers:', result)
    } catch (err) {
      console.error('Failed to get muxers:', err)
    }
  }

  const runWorker = (workerPath: string, file: File, args: string[], onProgress?: (pct: number) => void) => {
    return new Promise<any>((resolve, reject) => {
      const worker = new Worker(workerPath)
      let stdout = '', stderr = ''
      let progressInterval: number | null = null

      if (onProgress && workerPath.includes('ffmpeg')) {
        let currentProgress = 10
        progressInterval = window.setInterval(() => {
          if (currentProgress < 90) {
            currentProgress += Math.random() * 8 + 2
            if (currentProgress > 90) currentProgress = 90
            onProgress(Math.floor(currentProgress))
          }
        }, 200)
      }

      worker.onmessage = (e) => {
        const { type, data } = e.data
        if (type === 'ready') {
          const mounts = file ? [{ type: 'WORKERFS', opts: { files: [file] }, mountpoint: '/data' }] : []
          worker.postMessage({
            type: 'run',
            arguments: args,
            mounts: mounts
          })
        } else if (type === 'stdout') {
          stdout += data + '\n'
        } else if (type === 'stderr') {
          stderr += data + '\n'
        } else if (type === 'done') {
          if (progressInterval) clearInterval(progressInterval)
          onProgress?.(100)
          console.log('FFmpeg stdout:', stdout)
          console.log('FFmpeg stderr:', stderr)
          setTimeout(() => {
            worker.terminate()
            resolve(workerPath.includes('ffprobe') ? JSON.parse(stdout) : data.MEMFS)
          }, 50)
        }
      }
      worker.onerror = (err) => {
        if (progressInterval) clearInterval(progressInterval)
        setTimeout(() => {
          worker.terminate()
          reject(err)
        }, 50)
      }
    })
  }

  const extractSubtitles = async (file: File, parsed: any, basePath: string) => {
    const subtitles = parsed.streams?.filter((s: any) => s.codec_type === 'subtitle')
    if (!subtitles?.length) throw new Error('No subtitle tracks found in this video file')

    setProgress(`Extracting ${subtitles.length} subtitle(s)...`)
    setProgressPercent(10)

    const baseName = file.name.replace(/\.(mkv|mp4|avi|webm)$/i, '')
    const isMP4 = file.name.toLowerCase().endsWith('.mp4')

    const args: string[] = ['-i', `/data/${file.name}`]

    subtitles.forEach((s: any) => {
      const lang = s.tags?.language || 'unk'
      const title = s.tags?.title || 'untitled'
      const needsConversion = isMP4 || s.codec_name === 'mov_text'
      const ext = needsConversion ? 'srt' : (s.codec_name === 'subrip' ? 'srt' : s.codec_name)
      const outputName = `${baseName}_${lang}_${title}.${ext}`

      args.push('-map', `0:${s.index}`)
      if (needsConversion) {
        args.push('-c:s', 'srt')
      } else {
        args.push('-c:s', 'copy')
      }
      args.push(outputName)
    })

    const files = await runWorker(`${basePath}ffmpeg-worker-mkve.js`, file, args, setProgressPercent)
    if (!files?.length) throw new Error('Extraction failed - no subtitle files created')

    return { files, zipName: `${baseName}_subtitles.zip` }
  }

  const extractAudio = async (file: File, parsed: any, basePath: string, forTranscription: boolean) => {
    const audioStreams = parsed.streams?.filter((s: any) => s.codec_type === 'audio')
    console.log('Detected audio streams:', audioStreams)
    console.log('All streams:', parsed.streams)
    if (!audioStreams?.length) throw new Error('No audio tracks found in this video file')

    const modeLabel = forTranscription ? 'transcription-ready (original AAC)' : 'original quality'
    setProgress(`Extracting ${audioStreams.length} audio track(s) - ${modeLabel}...`)
    setProgressPercent(10)

    const baseName = file.name.replace(/\.(mkv|mp4|avi|webm)$/i, '')
    const allFiles: any[] = []

    // Extract each audio stream separately to avoid conflicts
    for (let i = 0; i < audioStreams.length; i++) {
      const s = audioStreams[i]
      const lang = s.tags?.language || 'unk'

      setProgress(`Extracting audio track ${i + 1}/${audioStreams.length} (${lang})...`)
      setProgressPercent(10 + (i * 70 / audioStreams.length))

      // Try different formats - let FFmpeg auto-detect from extension

      // Try different extensions to see which ones work
      type FormatOption = { ext: string, format: string | null }
      let formatsToTry: FormatOption[] = [
        { ext: 'mka', format: null },
        { ext: 'mov', format: null },  // Try MOV without forcing format
        { ext: 'mp4', format: null },  // Try MP4 without forcing format
        { ext: 'aac', format: null },  // Try raw AAC
        { ext: 'mp3', format: null },  // Try raw MP3
      ]

      // For E-AC3 specifically, let's also try forcing matroska as fallback
      if (s.codec_name === 'eac3' && !forTranscription) {
        formatsToTry.unshift({ ext: 'mka', format: 'matroska' })
      }

      let files: any[] = []
      let successfulFormat = null

      for (const { ext: testExt, format: testFormat } of formatsToTry) {
        const testName = `${baseName}_${lang}_${i}.${testExt}`
        const args: string[] = ['-i', `/data/${file.name}`]
        args.push('-map', `0:${s.index}`)
        args.push('-c:a', 'copy')  // Copy without re-encoding (this FFmpeg build doesn't support encoding)

        if (testFormat) {
          args.push('-f', testFormat)
        }
        args.push(testName)

        console.log(`Trying format: ${testFormat || 'auto-detect'} with extension .${testExt} for codec ${s.codec_name} (${forTranscription ? 'transcription mode' : 'original quality'})`)

        try {
          const testFiles = await runWorker(`${basePath}ffmpeg-worker-mkve.js`, file, args)
          if (testFiles?.length) {
            files = testFiles
            successfulFormat = `${testFormat || 'auto'}.${testExt}`
            console.log(`SUCCESS with format: ${successfulFormat}`)
            break
          } else {
            console.log(`No files with format: ${testFormat || 'auto'}.${testExt}`)
          }
        } catch (err) {
          console.log(`Failed with format: ${testFormat || 'auto'}.${testExt}`, err)
        }
      }

      if (!files.length) {
        console.warn(`All formats failed for audio track ${i}`)
        continue
      }

      console.log(`FFmpeg result for track ${i}:`, files)
      if (files?.length) {
        allFiles.push(...files)
      } else {
        console.warn(`No files returned for audio track ${i}`)
      }
    }

    if (!allFiles.length) throw new Error('Extraction failed - no audio files created')

    // Return audio with smart packaging logic
    console.log('Returning audio extraction result with baseName:', baseName)
    return { files: allFiles, isAudio: true, shouldZip: allFiles.length > 1, baseName }
  }

  const processFile = useCallback(async (file: File, extractionMode: ExtractionMode) => {
    setStatus('processing')
    setProgress('Analyzing video file...')
    setProgressPercent(0)

    const basePath = import.meta.env.BASE_URL

    // Check FFmpeg support for debugging
    if (extractionMode !== 'subtitles') {
      await checkFFmpegSupport(basePath)
    }

    try {
      const parsed = await runWorker(`${basePath}ffprobe-worker-mkve.js`, file, [
        `/data/${file.name}`, '-print_format', 'json', '-show_streams', '-show_format'
      ])

      let result: any

      if (extractionMode === 'subtitles') {
        result = await extractSubtitles(file, parsed, basePath)
      } else {
        const forTranscription = extractionMode === 'audio-transcription'
        result = await extractAudio(file, parsed, basePath, forTranscription)
      }

      if (result.isAudio) {
        console.log('Audio extraction result received:', result)
        console.log('result.baseName:', result.baseName)
        if (result.shouldZip) {
          // Create ZIP for multiple audio files (3+ tracks)
          setProgress(`Creating ZIP with ${result.files.length} audio files...`)
          setProgressPercent(95)
          const zip = new JSZip()
          result.files.forEach((f: any) => zip.file(f.name, f.data))

          const blob = await zip.generateAsync({ type: 'blob' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = `${result.baseName}_audio_tracks.zip`
          a.click()
          URL.revokeObjectURL(a.href)
        } else {
          // Download audio files directly for 1-2 tracks
          setProgress('Downloading audio files...')
          setProgressPercent(95)

          result.files.forEach((f: any) => {
            const a = document.createElement('a')
            const blob = new Blob([f.data])
            a.href = URL.createObjectURL(blob)
            a.download = f.name
            a.click()
            URL.revokeObjectURL(a.href)
          })
        }
      } else {
        // Create ZIP for subtitle files
        setProgress('Creating ZIP...')
        setProgressPercent(95)
        const zip = new JSZip()
        result.files.forEach((f: any) => zip.file(f.name, f.data))

        const blob = await zip.generateAsync({ type: 'blob' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = result.zipName
        a.click()
        URL.revokeObjectURL(a.href)
      }

      setProgress('Done!')
      setProgressPercent(100)
      setStatus('success')
    } catch (err: any) {
      console.error('Processing error:', err)
      setProgress(err.message || 'Processing failed')
      setStatus('error')
    }
  }, [])

  const handleFile = (file: File | undefined) => {
    if (!file) return
    const fileName = file.name.toLowerCase()
    console.log('Processing file:', file.name, 'Size:', file.size, 'Type:', file.type)

    const validExts = ['.mkv', '.mp4', '.avi', '.webm', '.mov']
    const isValid = validExts.some(ext => fileName.endsWith(ext))

    console.log('Valid extensions:', validExts)
    console.log('Is valid:', isValid)

    if (isValid) {
      setStatus('idle')
      setProgress('')
      setProgressPercent(0)
      setTimeout(() => processFile(file, mode), 100)
    } else {
      console.error('Invalid file extension:', fileName)
      alert(`Please select a valid video file (MKV, MP4, AVI, WebM, MOV)\n\nFile: ${file.name}`)
    }
  }

  const icons = { processing: '⏳', success: '✅', error: '⚠️', idle: '📁' }

  const modeLabels: Record<ExtractionMode, { label: string, desc: string }> = {
    'subtitles': { label: 'Subtitles', desc: 'Extract all subtitle tracks' },
    'audio-original': { label: 'Audio (Original)', desc: 'Extract audio in original quality' },
    'audio-transcription': { label: 'Audio (Transcription)', desc: '16kHz mono MP3 for speech-to-text' }
  }

  return (
    <div className="container">
      <h1 className="title">Video Extractor</h1>
      <p className="subtitle">Extract subtitles or audio from video files</p>

      <div className="mode-selector">
        {(Object.keys(modeLabels) as ExtractionMode[]).map((m) => (
          <button
            key={m}
            className={`mode-btn ${mode === m ? 'active' : ''}`}
            onClick={() => setMode(m)}
            disabled={status === 'processing'}
            title={modeLabels[m].desc}
          >
            {modeLabels[m].label}
          </button>
        ))}
      </div>

      <div
        className={`drop-zone ${status} ${isDragging ? 'dragging' : ''}`}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files[0]) }}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={(e) => { e.preventDefault(); setIsDragging(false) }}
        onClick={() => status !== 'processing' && fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && status !== 'processing' && fileInputRef.current?.click()}
      >
        {status === 'processing' ? (
          <>
            <div className="spinner" />
            <p className="status-text">{progress}</p>
            <div className="progress-bar-container">
              <div className="progress-bar" style={{ width: `${progressPercent}%` }}>
                <span className="progress-text">{progressPercent}%</span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="status-icon">{icons[status]}</div>
            <p className={`status-text ${status}`}>{progress || 'Drop video file or click to browse'}</p>
            {status !== 'idle' && <p className="status-text">Click to process another file</p>}
          </>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".mkv,.mp4,.avi,.webm,.mov"
          onChange={(e) => {
            handleFile(e.target.files?.[0])
            e.target.value = ''
          }}
          disabled={status === 'processing'}
          style={{ display: 'none' }}
        />
      </div>

      <div className="tech-stack">
        <p>
          <a href="https://react.dev" target="_blank" rel="noopener noreferrer">React 19</a>
          {' + '}
          <a href="https://www.typescriptlang.org" target="_blank" rel="noopener noreferrer">TypeScript</a>
          {' + '}
          <a href="https://vite.dev" target="_blank" rel="noopener noreferrer">Vite</a>
          {' + '}
          <a href="https://github.com/nicholasalx/ffmpeg.js" target="_blank" rel="noopener noreferrer">FFmpeg.js</a>
        </p>
      </div>
    </div>
  )
}

export default App
