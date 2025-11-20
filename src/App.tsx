import { useState, useCallback, useRef } from 'react'
import JSZip from 'jszip'
import './App.css'

function App() {
  const [status, setStatus] = useState<'idle' | 'processing' | 'success' | 'error'>('idle')
  const [progress, setProgress] = useState('')
  const [progressPercent, setProgressPercent] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
          worker.postMessage({
            type: 'run',
            arguments: args,
            mounts: [{ type: 'WORKERFS', opts: { files: [file] }, mountpoint: '/data' }]
          })
        } else if (type === 'stdout') {
          stdout += data + '\n'
        } else if (type === 'stderr') {
          stderr += data + '\n'
        } else if (type === 'done') {
          if (progressInterval) clearInterval(progressInterval)
          onProgress?.(100)
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

  const processFile = useCallback(async (file: File) => {
    setStatus('processing')
    setProgress('Parsing MKV file...')
    setProgressPercent(0)

    try {
      const baseUrl = import.meta.env.BASE_URL
      const parsed = await runWorker(`${baseUrl}ffprobe-worker-mkve.js`, file, [
        `/data/${file.name}`, '-print_format', 'json', '-show_streams', '-show_format'
      ])

      const subtitles = parsed.streams?.filter((s: any) => s.codec_type === 'subtitle')
      if (!subtitles?.length) throw new Error('No subtitle tracks found in this video file')

      setProgress(`Extracting ${subtitles.length} subtitle(s)...`)
      setProgressPercent(10)

      const args = subtitles.flatMap((s: any) => {
        const lang = s.tags?.language || 'unk'
        const title = s.tags?.title || 'untitled'
        const ext = s.codec_name === 'subrip' ? 'srt' : s.codec_name
        const baseName = file.name.replace(/\.(mkv|mp4)$/i, '')
        return ['-i', `/data/${file.name}`, '-map', `0:${s.index}`, '-codec', 'copy',
                `${baseName}_${lang}_${title}.${ext}`]
      })

      const files = await runWorker(`${baseUrl}ffmpeg-worker-mkve.js`, file, args, setProgressPercent)
      if (!files?.length) throw new Error('Extraction failed')

      setProgress('Creating ZIP...')
      setProgressPercent(95)
      const zip = new JSZip()
      files.forEach((f: any) => zip.file(f.name, f.data))

      const blob = await zip.generateAsync({ type: 'blob' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      const baseName = file.name.replace(/\.(mkv|mp4)$/i, '')
      a.download = `${baseName}_subtitles.zip`
      a.click()
      URL.revokeObjectURL(a.href)

      setProgress('Done!')
      setProgressPercent(100)
      setStatus('success')
    } catch (err: any) {
      setProgress(err.message)
      setStatus('error')
    }
  }, [])

  const handleFile = (file: File | undefined) => {
    const fileName = file?.name.toLowerCase()
    if (fileName?.endsWith('.mkv') || fileName?.endsWith('.mp4')) {
      setStatus('idle')
      setProgress('')
      setProgressPercent(0)
      setTimeout(() => processFile(file), 100)
    } else {
      alert('Please select a valid MKV or MP4 file')
    }
  }

  const icons = { processing: '⏳', success: '✅', error: '⚠️', idle: '📁' }

  return (
    <div className="container">
      <h1 className="title">Video Subtitle Extractor</h1>
      <p className="subtitle">Drop an MKV or MP4 file to extract all subtitles</p>

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
          accept=".mkv,.mp4"
          onChange={(e) => {
            handleFile(e.target.files?.[0])
            e.target.value = ''
          }}
          disabled={status === 'processing'}
          style={{ display: 'none' }}
        />
      </div>

      <div className="tech-stack">
        <p>React 19 + TypeScript + Vite + FFmpeg.js</p>
      </div>
    </div>
  )
}

export default App
