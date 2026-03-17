import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import './App.css'
import { formatDuration, resolveBitrateKbps } from './shared/session-utils'
import {
  DEFAULT_EXPORT_SETTINGS,
  type CaptureSource,
  type ExportSettings,
  type RecorderStreamType,
  type SessionMetadata,
} from './shared/types'

type RecorderStatus = 'idle' | 'recording' | 'stopped'
type ViewState = 'setup' | 'recording' | 'complete'
type ScreenCaptureMode = 'preview' | 'recording'
type AudioInputDevice = Pick<MediaDeviceInfo, 'deviceId' | 'label'>

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

const getSupportedMimeType = (): string | undefined =>
  MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate))

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong.'

const stopTracks = (stream: MediaStream | null): void => {
  if (!stream) {
    return
  }

  stream.getTracks().forEach((track) => track.stop())
}

const mapWebcamError = (error: unknown): string => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return 'Camera access was blocked. Allow camera permission for this app in system settings.'
    }

    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return 'No webcam device was detected on this machine.'
    }

    if (error.name === 'NotReadableError') {
      return 'Camera is busy in another app. Close other camera apps and retry.'
    }

    if (error.name === 'OverconstrainedError') {
      return 'Camera constraints were not supported. Retrying with a simpler mode can help.'
    }
  }

  return toErrorMessage(error)
}

const hasLiveVideoTrack = (stream: MediaStream | null): boolean =>
  Boolean(stream?.getVideoTracks().some((track) => track.readyState === 'live'))

const attachPreview = async (
  videoElement: HTMLVideoElement | null,
  stream: MediaStream | null,
): Promise<void> => {
  if (!videoElement) {
    return
  }

  videoElement.muted = true
  videoElement.playsInline = true
  videoElement.srcObject = stream

  if (!stream) {
    return
  }

  try {
    await videoElement.play()
  } catch {
    // Ignore autoplay race conditions; controls still allow recording.
  }
}

const getBaseName = (filePath?: string): string =>
  filePath ? filePath.split(/[\\/]/).pop() ?? filePath : 'Not available'

const formatStatus = (status: RecorderStatus): string =>
  `${status.charAt(0).toUpperCase()}${status.slice(1)}`

const statusTone = (status: RecorderStatus): 'idle' | 'recording' | 'stopped' => status

const getAudioLabel = (device: AudioInputDevice, index: number): string =>
  device.label.trim() || `Microphone ${index + 1}`

function App() {
  const [view, setView] = useState<ViewState>('setup')
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [shareSystemAudio, setShareSystemAudio] = useState(true)
  const [shareMicrophone, setShareMicrophone] = useState(true)
  const [microphones, setMicrophones] = useState<AudioInputDevice[]>([])
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState('')
  const [webcamEnabled, setWebcamEnabled] = useState(false)
  const [saveRoot, setSaveRoot] = useState('')
  const [exportSettings, setExportSettings] = useState<ExportSettings>(
    DEFAULT_EXPORT_SETTINGS,
  )
  const [screenStatus, setScreenStatus] = useState<RecorderStatus>('idle')
  const [webcamStatus, setWebcamStatus] = useState<RecorderStatus>('idle')
  const [webcamIssue, setWebcamIssue] = useState('')
  const [session, setSession] = useState<SessionMetadata | null>(null)
  const [sessionNameDraft, setSessionNameDraft] = useState('')
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null)
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [isLoadingSources, setIsLoadingSources] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')

  const [elapsedBaseMs, setElapsedBaseMs] = useState(0)
  const [activeSince, setActiveSince] = useState<number | null>(null)
  const [clockMs, setClockMs] = useState(Date.now())

  const screenVideoRef = useRef<HTMLVideoElement | null>(null)
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const webcamStreamRef = useRef<MediaStream | null>(null)

  const screenRecorderRef = useRef<MediaRecorder | null>(null)
  const webcamRecorderRef = useRef<MediaRecorder | null>(null)
  const screenRecordingStreamRef = useRef<MediaStream | null>(null)
  const webcamRecordingStreamRef = useRef<MediaStream | null>(null)
  const screenSystemAudioStreamRef = useRef<MediaStream | null>(null)
  const screenMicrophoneStreamRef = useRef<MediaStream | null>(null)
  const screenAudioContextRef = useRef<AudioContext | null>(null)
  const screenAudioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const screenPreviewSourceRef = useRef('')
  const screenChunkQueueRef = useRef<Promise<void>>(Promise.resolve())
  const webcamChunkQueueRef = useRef<Promise<void>>(Promise.resolve())
  const screenStopPromiseRef = useRef<Promise<void>>(Promise.resolve())
  const webcamStopPromiseRef = useRef<Promise<void>>(Promise.resolve())
  const resolveScreenStopRef = useRef<(() => void) | null>(null)
  const resolveWebcamStopRef = useRef<(() => void) | null>(null)

  const selectedSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId),
    [sources, selectedSourceId],
  )
  const safeFallbackSource = useMemo(() => {
    const safeScreen = sources.find(
      (source) =>
        source.type === 'screen' &&
        source.captureRisk === 'safe' &&
        source.id !== selectedSourceId,
    )

    if (safeScreen) {
      return safeScreen
    }

    return sources.find(
      (source) =>
        source.captureRisk === 'safe' && source.id !== selectedSourceId,
    )
  }, [selectedSourceId, sources])

  const hasActiveRecording =
    screenStatus === 'recording' || webcamStatus === 'recording'
  const isSelfCaptureSource = selectedSource?.captureRisk === 'warning'
  const isSelfCaptureRecording = isSelfCaptureSource && screenStatus === 'recording'
  const shouldSuppressScreenPreview = isSelfCaptureRecording
  const isCleanMode = isSelfCaptureRecording
  const canShareMicrophone = microphones.length > 0
  const selectedMicrophoneName =
    microphones.find((device) => device.deviceId === selectedMicrophoneId)?.label ?? ''
  const webcamPreviewMessage = !webcamEnabled
    ? 'Webcam is disabled. Enable it to start preview.'
    : webcamIssue || 'Webcam preview unavailable.'

  const elapsedMs =
    elapsedBaseMs + (activeSince !== null ? Math.max(0, clockMs - activeSince) : 0)

  useEffect(() => {
    if (hasActiveRecording && activeSince === null) {
      setActiveSince(Date.now())
      return
    }

    if (!hasActiveRecording && activeSince !== null) {
      setElapsedBaseMs((value) => value + (Date.now() - activeSince))
      setActiveSince(null)
    }
  }, [activeSince, hasActiveRecording])

  useEffect(() => {
    if (activeSince === null) {
      return
    }

    const intervalId = window.setInterval(() => {
      setClockMs(Date.now())
    }, 250)

    return () => window.clearInterval(intervalId)
  }, [activeSince])

  useEffect(() => {
    void attachPreview(screenVideoRef.current, screenStream)
  }, [screenStream])

  useEffect(() => {
    void attachPreview(webcamVideoRef.current, webcamStream)
  }, [webcamStream])

  useEffect(() => {
    screenStreamRef.current = screenStream
  }, [screenStream])

  useEffect(() => {
    webcamStreamRef.current = webcamStream
  }, [webcamStream])

  const cleanupScreenAudioGraph = useCallback((): void => {
    stopTracks(screenSystemAudioStreamRef.current)
    stopTracks(screenMicrophoneStreamRef.current)
    screenSystemAudioStreamRef.current = null
    screenMicrophoneStreamRef.current = null

    const audioContext = screenAudioContextRef.current
    if (audioContext) {
      void audioContext.close()
      screenAudioContextRef.current = null
    }

    screenAudioDestinationRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      stopTracks(screenStreamRef.current)
      stopTracks(webcamStreamRef.current)
      stopTracks(screenRecordingStreamRef.current)
      stopTracks(webcamRecordingStreamRef.current)
      cleanupScreenAudioGraph()
    }
  }, [cleanupScreenAudioGraph])

  const refreshAudioInputs = useCallback(async () => {
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices?.enumerateDevices) {
      setMicrophones([])
      setSelectedMicrophoneId('')
      return
    }

    try {
      const devices = await mediaDevices.enumerateDevices()
      const audioInputs = devices
        .filter((device): device is MediaDeviceInfo => device.kind === 'audioinput')
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label,
        }))

      setMicrophones(audioInputs)
      setSelectedMicrophoneId((current) => {
        if (audioInputs.length === 0) {
          return ''
        }

        if (current && audioInputs.some((device) => device.deviceId === current)) {
          return current
        }

        return audioInputs[0].deviceId
      })
    } catch (error) {
      setErrorMessage(`Could not enumerate microphones: ${toErrorMessage(error)}`)
    }
  }, [])

  const refreshSources = useCallback(async () => {
    setIsLoadingSources(true)
    setErrorMessage('')

    try {
      const nextSources = await window.recorderApi.listSources()
      setSources(nextSources)

      if (nextSources.length > 0) {
        const safeDefault =
          nextSources.find(
            (source) =>
              source.type === 'screen' && source.captureRisk === 'safe',
          ) ??
          nextSources.find((source) => source.captureRisk === 'safe') ??
          nextSources[0]

        setSelectedSourceId((current) =>
          current && nextSources.some((source) => source.id === current)
            ? current
            : safeDefault.id,
        )
      }
    } catch (error) {
      setErrorMessage(`Could not load capture sources: ${toErrorMessage(error)}`)
    } finally {
      setIsLoadingSources(false)
    }
  }, [])

  useEffect(() => {
    void refreshSources()
    void refreshAudioInputs()
  }, [refreshAudioInputs, refreshSources])

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices?.addEventListener) {
      return
    }

    const handleDeviceChange = (): void => {
      void refreshAudioInputs()
    }

    mediaDevices.addEventListener('devicechange', handleDeviceChange)
    return () => {
      mediaDevices.removeEventListener('devicechange', handleDeviceChange)
    }
  }, [refreshAudioInputs])

  const resetTimer = (): void => {
    setElapsedBaseMs(0)
    setActiveSince(null)
    setClockMs(Date.now())
  }

  const cleanupRecordingStreams = useCallback((): void => {
    stopTracks(screenRecordingStreamRef.current)
    stopTracks(webcamRecordingStreamRef.current)
    screenRecordingStreamRef.current = null
    webcamRecordingStreamRef.current = null
    cleanupScreenAudioGraph()
  }, [cleanupScreenAudioGraph])

  const cleanupPreviewStreams = useCallback((): void => {
    stopTracks(screenStream)
    stopTracks(webcamStream)
    setScreenStream(null)
    setWebcamStream(null)
    screenPreviewSourceRef.current = ''
  }, [screenStream, webcamStream])

  const ensureSession = useCallback(async (): Promise<SessionMetadata> => {
    if (session) {
      return session
    }

    if (!selectedSource) {
      throw new Error('Select a screen or window before recording.')
    }

    const created = await window.recorderApi.createSession({
      sourceId: selectedSource.id,
      sourceName: selectedSource.name,
      webcamEnabled,
      saveRoot: saveRoot.trim() || undefined,
      exportSettings,
    })

    setSession(created)
    setSessionNameDraft(created.name)
    setView('recording')
    resetTimer()
    return created
  }, [session, selectedSource, webcamEnabled, saveRoot, exportSettings])

  const getScreenMediaStream = async (
    sourceId: string,
    options: { mode?: ScreenCaptureMode; withAudio?: boolean } = {},
  ): Promise<MediaStream> => {
    const { mode = 'preview', withAudio = false } = options
    const constraints = {
      audio: withAudio
        ? ({
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
            },
          } as unknown as MediaTrackConstraints)
        : false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: mode === 'preview' ? 24 : 30,
        },
      } as unknown as MediaTrackConstraints,
    }

    return navigator.mediaDevices.getUserMedia(constraints)
  }

  const getWebcamMediaStream = useCallback(async (): Promise<MediaStream> => {
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices?.getUserMedia) {
      throw new Error('Camera APIs are unavailable in this runtime.')
    }

    try {
      return await mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 360, max: 720 },
          frameRate: { ideal: 15, max: 24 },
          facingMode: 'user',
        },
        audio: false,
      })
    } catch (firstError) {
      if (firstError instanceof DOMException && firstError.name === 'NotAllowedError') {
        throw firstError
      }

      const devices = await mediaDevices.enumerateDevices().catch(() => [])
      const videoDevices = devices.filter((device) => device.kind === 'videoinput')

      if (videoDevices.length === 0) {
        throw new Error('No webcam device was detected on this machine.')
      }

      return mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: videoDevices[0].deviceId },
          width: { ideal: 640, max: 1280 },
          height: { ideal: 360, max: 720 },
          frameRate: { ideal: 15, max: 24 },
        },
        audio: false,
      })
    }
  }, [])

  const getMicrophoneMediaStream = useCallback(async (): Promise<MediaStream> => {
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices?.getUserMedia) {
      throw new Error('Microphone APIs are unavailable in this runtime.')
    }

    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }

    if (selectedMicrophoneId) {
      audioConstraints.deviceId = { exact: selectedMicrophoneId }
    }

    return mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    })
  }, [selectedMicrophoneId])

  const buildScreenRecordingStream = useCallback(async (): Promise<MediaStream> => {
    cleanupScreenAudioGraph()
    const screenCaptureStream = await getScreenMediaStream(selectedSourceId, {
      mode: 'recording',
      withAudio: shareSystemAudio,
    })
    screenSystemAudioStreamRef.current = screenCaptureStream

    const [videoTrack] = screenCaptureStream.getVideoTracks()
    if (!videoTrack) {
      stopTracks(screenCaptureStream)
      screenSystemAudioStreamRef.current = null
      throw new Error('Selected source is missing a live video track.')
    }

    const outputStream = new MediaStream([videoTrack])
    const screenAudioTracks = screenCaptureStream
      .getAudioTracks()
      .filter((track) => track.readyState === 'live')
    const hasSystemAudioTrack = screenAudioTracks.length > 0

    if (shareSystemAudio && !hasSystemAudioTrack) {
      setStatusMessage(
        'System audio is unavailable for this source. Use Entire screen or enable audio in the share picker.',
      )
    }

    // Fast path: keep native screen capture audio track with screen video for best sync.
    if (hasSystemAudioTrack && !shareMicrophone) {
      outputStream.addTrack(screenAudioTracks[0])
      return outputStream
    }

    const audioInputs: MediaStream[] = []
    if (hasSystemAudioTrack) {
      audioInputs.push(new MediaStream(screenAudioTracks))
    }

    if (shareMicrophone) {
      try {
        const microphoneStream = await getMicrophoneMediaStream()
        const hasMicAudio = microphoneStream
          .getAudioTracks()
          .some((track) => track.readyState === 'live')
        if (hasMicAudio) {
          screenMicrophoneStreamRef.current = microphoneStream
          audioInputs.push(microphoneStream)
        } else {
          stopTracks(microphoneStream)
          setStatusMessage('Microphone did not return a live audio track.')
        }
      } catch (error) {
        setStatusMessage(`Microphone unavailable: ${toErrorMessage(error)}`)
      }
    }

    if (audioInputs.length === 0) {
      return outputStream
    }

    const audioContext = new AudioContext()
    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    const destination = audioContext.createMediaStreamDestination()
    audioInputs.forEach((stream) => {
      const sourceNode = audioContext.createMediaStreamSource(stream)
      const gainNode = audioContext.createGain()
      gainNode.gain.value = 1
      sourceNode.connect(gainNode)
      gainNode.connect(destination)
    })

    const [mixedTrack] = destination.stream.getAudioTracks()
    if (mixedTrack) {
      outputStream.addTrack(mixedTrack)
      screenAudioContextRef.current = audioContext
      screenAudioDestinationRef.current = destination
      return outputStream
    }

    await audioContext.close()
    setStatusMessage('Audio mix could not be created. Continuing with video only.')
    cleanupScreenAudioGraph()
    return outputStream
  }, [
    cleanupScreenAudioGraph,
    getMicrophoneMediaStream,
    selectedSourceId,
    shareMicrophone,
    shareSystemAudio,
  ])

  const refreshSession = async (sessionId: string): Promise<void> => {
    const next = await window.recorderApi.getSession(sessionId)
    setSession(next)
  }

  const startScreenPreview = useCallback(async () => {
    if (!selectedSourceId) {
      return
    }

    if (shouldSuppressScreenPreview) {
      if (screenStream) {
        stopTracks(screenStream)
        setScreenStream(null)
        screenPreviewSourceRef.current = ''
      }
      return
    }

    if (
      screenStream &&
      screenPreviewSourceRef.current === selectedSourceId &&
      hasLiveVideoTrack(screenStream)
    ) {
      return
    }

    if (screenStream) {
      stopTracks(screenStream)
      setScreenStream(null)
    }

    try {
      const stream = await getScreenMediaStream(selectedSourceId, { mode: 'preview' })
      setScreenStream(stream)
      screenPreviewSourceRef.current = selectedSourceId
    } catch (error) {
      setErrorMessage(`Could not load screen preview: ${toErrorMessage(error)}`)
    }
  }, [screenStream, selectedSourceId, shouldSuppressScreenPreview])

  const startWebcamPreview = useCallback(async (force = false) => {
    if (
      !webcamEnabled ||
      (webcamStream && hasLiveVideoTrack(webcamStream))
    ) {
      return
    }

    if (!force && webcamIssue) {
      return
    }

    try {
      setWebcamIssue('')
      const stream = await getWebcamMediaStream()
      setWebcamStream(stream)
    } catch (error) {
      const mappedMessage = mapWebcamError(error)
      setWebcamIssue(mappedMessage)
      setErrorMessage(`Could not load webcam preview: ${mappedMessage}`)
    }
  }, [getWebcamMediaStream, webcamEnabled, webcamIssue, webcamStream])

  useEffect(() => {
    if (view !== 'recording') {
      if (screenStatus !== 'recording' && screenStream) {
        stopTracks(screenStream)
        setScreenStream(null)
        screenPreviewSourceRef.current = ''
      }

      if (webcamStatus !== 'recording' && webcamStream) {
        stopTracks(webcamStream)
        setWebcamStream(null)
      }
      return
    }

    void startScreenPreview()
    void startWebcamPreview()
  }, [
    screenStatus,
    screenStream,
    startScreenPreview,
    startWebcamPreview,
    view,
    webcamStatus,
    webcamStream,
  ])

  useEffect(() => {
    if (!webcamEnabled && webcamStatus !== 'recording' && webcamStream) {
      stopTracks(webcamStream)
      setWebcamStream(null)
    }
  }, [webcamEnabled, webcamStatus, webcamStream])

  useEffect(() => {
    if (!webcamEnabled || webcamStream) {
      setWebcamIssue('')
    }
  }, [webcamEnabled, webcamStream])

  useEffect(() => {
    if (!screenStream) {
      return
    }

    const [track] = screenStream.getVideoTracks()
    if (!track) {
      return
    }

    const handleEnded = (): void => {
      setScreenStream((current) => (current === screenStream ? null : current))
      screenPreviewSourceRef.current = ''
    }

    track.addEventListener('ended', handleEnded)
    return () => {
      track.removeEventListener('ended', handleEnded)
    }
  }, [screenStream])

  useEffect(() => {
    if (!webcamStream) {
      return
    }

    const [track] = webcamStream.getVideoTracks()
    if (!track) {
      return
    }

    const handleEnded = (): void => {
      setWebcamIssue('Webcam stream ended. Click retry webcam.')
      setWebcamStream((current) => (current === webcamStream ? null : current))
    }

    track.addEventListener('ended', handleEnded)
    return () => {
      track.removeEventListener('ended', handleEnded)
    }
  }, [webcamStream])

  const startScreenRecording = useCallback(async () => {
    if (screenRecorderRef.current?.state === 'recording') {
      return
    }

    setErrorMessage('')
    setStatusMessage('')

    let recordingStream: MediaStream | null = null

    try {
      const activeSession = await ensureSession()
      if (shareMicrophone && !canShareMicrophone) {
        setStatusMessage('No microphone detected. Continuing with system audio only.')
      }

      recordingStream = await buildScreenRecordingStream()
      const mimeType = getSupportedMimeType()
      screenRecordingStreamRef.current = recordingStream

      await window.recorderApi.startRecorder(activeSession.id, 'screen', {
        mimeType,
        bitrateKbps: resolveBitrateKbps(exportSettings),
      })

      screenStopPromiseRef.current = new Promise((resolve) => {
        resolveScreenStopRef.current = resolve
      })
      screenChunkQueueRef.current = Promise.resolve()

      const recorder = new MediaRecorder(
        recordingStream,
        mimeType ? { mimeType } : undefined,
      )
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) {
          return
        }

        screenChunkQueueRef.current = screenChunkQueueRef.current
          .then(async () => {
            const payload = new Uint8Array(await event.data.arrayBuffer())
            await window.recorderApi.appendChunk(activeSession.id, 'screen', payload)
          })
          .catch((error) => {
            setErrorMessage(`Failed writing screen data: ${toErrorMessage(error)}`)
          })
      }

      recorder.onstop = () => {
        void (async () => {
          try {
            await screenChunkQueueRef.current
            await window.recorderApi.stopRecorder(activeSession.id, 'screen')
            await refreshSession(activeSession.id)
          } catch (error) {
            setErrorMessage(`Failed stopping screen recorder: ${toErrorMessage(error)}`)
          } finally {
            setScreenStatus('stopped')
            screenRecorderRef.current = null
            stopTracks(screenRecordingStreamRef.current)
            screenRecordingStreamRef.current = null
            cleanupScreenAudioGraph()
            resolveScreenStopRef.current?.()
            resolveScreenStopRef.current = null
          }
        })()
      }

      recorder.onerror = () => {
        setErrorMessage('Screen recorder encountered an error.')
      }

      recordingStream.getVideoTracks().forEach((track) => {
        track.addEventListener(
          'ended',
          () => {
            if (recorder.state === 'recording') {
              recorder.stop()
            }
          },
          { once: true },
        )
      })

      recorder.start(1000)
      screenRecorderRef.current = recorder
      setScreenStatus('recording')
      setView('recording')
    } catch (error) {
      stopTracks(recordingStream)
      screenRecordingStreamRef.current = null
      cleanupScreenAudioGraph()
      setErrorMessage(`Could not start screen recording: ${toErrorMessage(error)}`)
    }
  }, [
    buildScreenRecordingStream,
    canShareMicrophone,
    cleanupScreenAudioGraph,
    ensureSession,
    exportSettings,
    shareMicrophone,
  ])

  const startWebcamRecording = useCallback(async () => {
    if (!webcamEnabled) {
      setErrorMessage('Enable webcam recording first.')
      return
    }

    if (webcamRecorderRef.current?.state === 'recording') {
      return
    }

    setErrorMessage('')
    setStatusMessage('')

    let recordingStream: MediaStream | null = null
    let webcamMicStreamRef: MediaStream | null = null
    let webcamAudioContextRef: AudioContext | null = null

    try {
      const activeSession = await ensureSession()

      // Acquire raw webcam video stream (preview stream is video-only to avoid
      // demanding mic permission before the user hits record)
      const rawVideoStream =
        webcamStream && hasLiveVideoTrack(webcamStream)
          ? webcamStream.clone()
          : await getWebcamMediaStream()

      setWebcamIssue('')

      // Build the recording stream: video track always, + mic audio when enabled
      const [videoTrack] = rawVideoStream.getVideoTracks()
      const outputStream = new MediaStream(videoTrack ? [videoTrack] : [])

      if (shareMicrophone && canShareMicrophone) {
        try {
          webcamMicStreamRef = await getMicrophoneMediaStream()
          const micTracks = webcamMicStreamRef
            .getAudioTracks()
            .filter((t) => t.readyState === 'live')

          if (micTracks.length > 0) {
            // Route through AudioContext so gain control is consistent with
            // the screen recording audio graph.
            const audioContext = new AudioContext()
            if (audioContext.state === 'suspended') {
              await audioContext.resume()
            }
            webcamAudioContextRef = audioContext
            const destination = audioContext.createMediaStreamDestination()
            const sourceNode = audioContext.createMediaStreamSource(
              new MediaStream(micTracks),
            )
            const gainNode = audioContext.createGain()
            gainNode.gain.value = 1
            sourceNode.connect(gainNode)
            gainNode.connect(destination)
            const [mixedTrack] = destination.stream.getAudioTracks()
            if (mixedTrack) {
              outputStream.addTrack(mixedTrack)
            }
          } else {
            stopTracks(webcamMicStreamRef)
            webcamMicStreamRef = null
            setStatusMessage('Microphone did not return a live audio track. Recording webcam video only.')
          }
        } catch (micError) {
          setStatusMessage(`Microphone unavailable for webcam: ${toErrorMessage(micError)}. Recording webcam video only.`)
        }
      } else if (shareMicrophone && !canShareMicrophone) {
        setStatusMessage('No microphone detected. Recording webcam video only.')
      }

      recordingStream = outputStream
      const mimeType = getSupportedMimeType()
      webcamRecordingStreamRef.current = recordingStream

      await window.recorderApi.startRecorder(activeSession.id, 'webcam', {
        mimeType,
        bitrateKbps: resolveBitrateKbps(exportSettings),
      })

      webcamStopPromiseRef.current = new Promise((resolve) => {
        resolveWebcamStopRef.current = resolve
      })
      webcamChunkQueueRef.current = Promise.resolve()

      const recorder = new MediaRecorder(
        recordingStream,
        mimeType ? { mimeType } : undefined,
      )
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) {
          return
        }

        webcamChunkQueueRef.current = webcamChunkQueueRef.current
          .then(async () => {
            const payload = new Uint8Array(await event.data.arrayBuffer())
            await window.recorderApi.appendChunk(activeSession.id, 'webcam', payload)
          })
          .catch((error) => {
            setErrorMessage(`Failed writing webcam data: ${toErrorMessage(error)}`)
          })
      }

      recorder.onstop = () => {
        void (async () => {
          try {
            await webcamChunkQueueRef.current
            await window.recorderApi.stopRecorder(activeSession.id, 'webcam')
            await refreshSession(activeSession.id)
          } catch (error) {
            setErrorMessage(`Failed stopping webcam recorder: ${toErrorMessage(error)}`)
          } finally {
            setWebcamStatus('stopped')
            webcamRecorderRef.current = null
            stopTracks(webcamRecordingStreamRef.current)
            webcamRecordingStreamRef.current = null
            // Clean up webcam-specific mic + audio context
            stopTracks(webcamMicStreamRef)
            webcamMicStreamRef = null
            if (webcamAudioContextRef) {
              void webcamAudioContextRef.close()
              webcamAudioContextRef = null
            }
            resolveWebcamStopRef.current?.()
            resolveWebcamStopRef.current = null
          }
        })()
      }

      recorder.onerror = () => {
        setErrorMessage('Webcam recorder encountered an error.')
      }

      recordingStream.getVideoTracks().forEach((track) => {
        track.addEventListener(
          'ended',
          () => {
            if (recorder.state === 'recording') {
              recorder.stop()
            }
          },
          { once: true },
        )
      })

      recorder.start(1000)
      webcamRecorderRef.current = recorder
      setWebcamStatus('recording')
      setView('recording')
    } catch (error) {
      stopTracks(recordingStream)
      webcamRecordingStreamRef.current = null
      stopTracks(webcamMicStreamRef)
      webcamMicStreamRef = null
      if (webcamAudioContextRef) {
        void webcamAudioContextRef.close()
        webcamAudioContextRef = null
      }
      const mappedMessage = mapWebcamError(error)
      setWebcamIssue(mappedMessage)
      setErrorMessage(
        `Could not start webcam recording. Camera permission may be blocked: ${mappedMessage}`,
      )
    }
  }, [
    canShareMicrophone,
    ensureSession,
    exportSettings,
    getMicrophoneMediaStream,
    getWebcamMediaStream,
    shareMicrophone,
    webcamEnabled,
    webcamStream,
  ])

  const retryWebcamPreview = useCallback(async (): Promise<void> => {
    if (!webcamEnabled) {
      setWebcamIssue('Enable webcam in settings first.')
      return
    }

    if (webcamStream) {
      stopTracks(webcamStream)
      setWebcamStream(null)
    }

    setWebcamIssue('')
    await startWebcamPreview(true)
  }, [startWebcamPreview, webcamEnabled, webcamStream])

  const stopRecorder = useCallback(async (streamType: RecorderStreamType) => {
    const recorder =
      streamType === 'screen' ? screenRecorderRef.current : webcamRecorderRef.current
    const stopPromise =
      streamType === 'screen'
        ? screenStopPromiseRef.current
        : webcamStopPromiseRef.current

    if (!recorder || recorder.state !== 'recording') {
      return
    }

    recorder.stop()
    await stopPromise
  }, [])

  const finishSession = useCallback(async () => {
    if (!session) {
      setErrorMessage('No active session to finish.')
      return
    }

    setIsBusy(true)
    setErrorMessage('')

    try {
      await Promise.all([stopRecorder('screen'), stopRecorder('webcam')])
      const finalized = await window.recorderApi.finalizeSession(
        session.id,
        Math.round(elapsedMs),
      )
      setSession(finalized)
      setSessionNameDraft(finalized.name)
      setView('complete')
      cleanupPreviewStreams()
      cleanupRecordingStreams()

      // Auto-export final.mp4 immediately after session finishes.
      // Respects the user's bitrate profile and merge preference but
      // always targets mp4 so final.mp4 is ready without an extra click.
      setStatusMessage('Recording complete. Generating final.mp4…')
      try {
        const mp4Settings = { ...exportSettings, format: 'mp4' as const }
        const exported = await window.recorderApi.exportSession(finalized.id, mp4Settings)
        setSession(exported)
        if (exported.exportStatus.state === 'failed') {
          setStatusMessage(
            `Recording saved. MP4 export failed: ${exported.exportStatus.message ?? 'unknown error'}`,
          )
        } else {
          setStatusMessage('Recording complete. final.mp4 is ready.')
        }
      } catch (exportError) {
        // Non-fatal — .webm files are already saved. Just inform the user.
        setStatusMessage(
          `Recording saved. Could not auto-generate final.mp4: ${toErrorMessage(exportError)}`,
        )
      }
    } catch (error) {
      setErrorMessage(`Could not finish session: ${toErrorMessage(error)}`)
    } finally {
      setIsBusy(false)
    }
  }, [cleanupPreviewStreams, cleanupRecordingStreams, elapsedMs, exportSettings, session, stopRecorder])

  const chooseSaveLocation = async (): Promise<void> => {
    setErrorMessage('')
    const chosen = await window.recorderApi.chooseSaveRoot()
    if (chosen) {
      setSaveRoot(chosen)
      setExportSettings((previous) => ({
        ...previous,
        customSaveRoot: chosen,
      }))
    }
  }

  const exportCurrentSession = async (): Promise<void> => {
    if (!session) {
      setErrorMessage('Create a session before exporting.')
      return
    }

    setIsBusy(true)
    setErrorMessage('')

    try {
      const updated = await window.recorderApi.exportSession(session.id, exportSettings)
      setSession(updated)
      if (updated.exportStatus.state === 'failed') {
        setErrorMessage(updated.exportStatus.message ?? 'Export failed.')
      } else {
        setStatusMessage(updated.exportStatus.message ?? 'Export completed.')
      }
    } catch (error) {
      setErrorMessage(`Export failed: ${toErrorMessage(error)}`)
    } finally {
      setIsBusy(false)
    }
  }

  const renameCurrentSession = async (): Promise<void> => {
    if (!session) {
      return
    }

    setIsBusy(true)
    setErrorMessage('')

    try {
      const renamed = await window.recorderApi.renameSession(session.id, sessionNameDraft)
      setSession(renamed)
      setSessionNameDraft(renamed.name)
      setStatusMessage('Session renamed.')
    } catch (error) {
      setErrorMessage(`Rename failed: ${toErrorMessage(error)}`)
    } finally {
      setIsBusy(false)
    }
  }

  const openSessionFolder = async (): Promise<void> => {
    if (!session) {
      return
    }

    await window.recorderApi.openSessionFolder(session.id)
  }

  const resetToSetup = (): void => {
    cleanupPreviewStreams()
    cleanupRecordingStreams()
    screenPreviewSourceRef.current = ''
    setSession(null)
    setScreenStatus('idle')
    setWebcamStatus('idle')
    setSessionNameDraft('')
    resetTimer()
    setStatusMessage('')
    setErrorMessage('')
    setWebcamIssue('')
    setView('setup')
  }

  const switchToSafeSource = (): void => {
    if (!safeFallbackSource || hasActiveRecording) {
      return
    }

    setSelectedSourceId(safeFallbackSource.id)
    setStatusMessage(`Switched to ${safeFallbackSource.name}.`)
    setErrorMessage('')
  }

  return (
    <main className="app-shell">
      <div className="ambient-gradient" aria-hidden="true" />

      <section className={`glass minimal-surface ${isCleanMode ? 'clean-mode' : ''}`}>
        <header className="surface-head">
          <div className="brand">
            <div className="brand-mark">◌</div>
            <div>
              <p className="eyebrow">Capture Workspace</p>
              <h1>Screen + Webcam Recorder</h1>
            </div>
          </div>

          <div className="head-right">
            <div className="timer-card">
              <span>Live Timer</span>
              <strong>{formatDuration(elapsedMs)}</strong>
            </div>
            <button
              type="button"
              className="ghost"
              onClick={() => void refreshSources()}
              disabled={isLoadingSources}
            >
              {isLoadingSources ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </header>

        <nav className="view-switch" aria-label="View stages">
          <button
            type="button"
            className={`pill ${view === 'setup' ? 'active' : ''}`}
            onClick={() => setView('setup')}
            disabled={hasActiveRecording}
          >
            Setup
          </button>
          <button
            type="button"
            className={`pill ${view === 'recording' ? 'active' : ''}`}
            onClick={() => setView('recording')}
            disabled={!selectedSource || hasActiveRecording}
          >
            Recorder
          </button>
          <button
            type="button"
            className={`pill ${view === 'complete' ? 'active' : ''}`}
            onClick={() => setView('complete')}
            disabled={!session || hasActiveRecording}
          >
            Complete
          </button>
        </nav>

        {!isCleanMode && (
          <section className="source-strip">
            {sources.length > 0 ? (
              sources.map((source) => (
                <button
                  type="button"
                  key={source.id}
                  className={`source-pill ${source.id === selectedSourceId ? 'selected' : ''}`}
                  onClick={() => setSelectedSourceId(source.id)}
                  disabled={hasActiveRecording}
                >
                  <img src={source.thumbnailDataUrl} alt={source.name} />
                  <div>
                    <span>{source.name}</span>
                    <small>
                      {source.type} · {source.captureRisk === 'warning' ? 'mirror risk' : 'safe'}
                    </small>
                  </div>
                </button>
              ))
            ) : (
              <p className="empty-line">No capture sources found.</p>
            )}
          </section>
        )}

        {isSelfCaptureSource && (
          <section className="capture-warning">
            <p>
              Selected source includes this recorder window. Mirror recursion may appear.
            </p>
            {safeFallbackSource ? (
              <button
                type="button"
                className="ghost"
                onClick={switchToSafeSource}
                disabled={hasActiveRecording}
              >
                Switch to {safeFallbackSource.name}
              </button>
            ) : (
              <span className="warning-note">
                Pick another source (prefer Entire screen) for cleaner output.
              </span>
            )}
          </section>
        )}

        {!isCleanMode && (
          <details className="glass settings-drawer">
            <summary>Settings</summary>
            <div className="drawer-grid">
              <label className="field switch-row">
                <span>Enable webcam</span>
                <input
                  type="checkbox"
                  checked={webcamEnabled}
                  onChange={(event) => setWebcamEnabled(event.target.checked)}
                />
              </label>

              <label className="field switch-row">
                <span>Share system audio</span>
                <input
                  type="checkbox"
                  checked={shareSystemAudio}
                  onChange={(event) => setShareSystemAudio(event.target.checked)}
                />
              </label>

              <label className="field switch-row">
                <span>Share microphone</span>
                <input
                  type="checkbox"
                  checked={shareMicrophone}
                  onChange={(event) => setShareMicrophone(event.target.checked)}
                />
              </label>

              {shareMicrophone && (
                <label className="field">
                  <span>Microphone</span>
                  <div className="input-row">
                    <select
                      value={selectedMicrophoneId}
                      onChange={(event) => setSelectedMicrophoneId(event.target.value)}
                      disabled={microphones.length === 0}
                    >
                      {microphones.length === 0 ? (
                        <option value="">No microphone found</option>
                      ) : (
                        microphones.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {getAudioLabel(device, index)}
                          </option>
                        ))
                      )}
                    </select>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void refreshAudioInputs()}
                    >
                      Refresh
                    </button>
                  </div>
                  {microphones.length > 0 && !selectedMicrophoneName && (
                    <small className="hint-text">
                      Microphone labels appear after granting mic permission once.
                    </small>
                  )}
                </label>
              )}

              <label className="field">
                <span>Save root</span>
                <div className="input-row">
                  <input
                    value={saveRoot}
                    onChange={(event) => setSaveRoot(event.target.value)}
                    placeholder="Default videos folder"
                  />
                  <button type="button" className="ghost" onClick={chooseSaveLocation}>
                    Browse
                  </button>
                </div>
              </label>

              <label className="field">
                <span>Format</span>
                <select
                  value={exportSettings.format}
                  onChange={(event) =>
                    setExportSettings((prev) => ({
                      ...prev,
                      format: event.target.value as ExportSettings['format'],
                    }))
                  }
                >
                  <option value="webm">webm</option>
                  <option value="mp4">mp4</option>
                </select>
              </label>

              <label className="field">
                <span>Bitrate</span>
                <select
                  value={exportSettings.bitrateProfile}
                  onChange={(event) =>
                    setExportSettings((prev) => ({
                      ...prev,
                      bitrateProfile: event.target.value as ExportSettings['bitrateProfile'],
                    }))
                  }
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="custom">custom</option>
                </select>
              </label>

              {exportSettings.bitrateProfile === 'custom' && (
                <label className="field">
                  <span>Custom bitrate (kbps)</span>
                  <input
                    type="number"
                    min={250}
                    value={exportSettings.customBitrateKbps ?? ''}
                    onChange={(event) =>
                      setExportSettings((prev) => ({
                        ...prev,
                        customBitrateKbps: Number(event.target.value),
                      }))
                    }
                  />
                </label>
              )}

              <label className="field switch-row">
                <span>Merge screen + webcam</span>
                <input
                  type="checkbox"
                  checked={exportSettings.mergeStreams}
                  onChange={(event) =>
                    setExportSettings((prev) => ({
                      ...prev,
                      mergeStreams: event.target.checked,
                    }))
                  }
                />
              </label>
            </div>
          </details>
        )}

        {view === 'setup' && (
          <section className="stage-card">
            <div className="hero-canvas">
              {selectedSource ? (
                <img src={selectedSource.thumbnailDataUrl} alt={selectedSource.name} />
              ) : (
                <div className="placeholder">Select a source to begin.</div>
              )}
            </div>
            <div className="action-row">
              <span className={`status-tag ${statusTone(screenStatus)}`}>
                Screen {formatStatus(screenStatus)}
              </span>
              <span className={`status-tag ${statusTone(webcamStatus)}`}>
                Webcam {formatStatus(webcamStatus)}
              </span>
              <button
                type="button"
                className="primary"
                onClick={() => setView('recording')}
                disabled={!selectedSource}
              >
                Open Recorder
              </button>
            </div>
          </section>
        )}

        {view === 'recording' && (
          <section className="stage-card">
            {isCleanMode && (
              <p className="clean-mode-note">
                Clean mode is active while recording this source. Preview is simplified to
                prevent mirror recursion.
              </p>
            )}
            <div className="preview-grid">
              <article className="feed-card">
                <header>
                  <h3>Screen</h3>
                  <span className={`status-tag mini ${statusTone(screenStatus)}`}>
                    {formatStatus(screenStatus)}
                  </span>
                </header>
                <div className="media-frame">
                  {shouldSuppressScreenPreview ? (
                    <div className="placeholder compact-placeholder">
                      Preview hidden while self-capturing this app.
                    </div>
                  ) : screenStream ? (
                    <video ref={screenVideoRef} autoPlay muted playsInline />
                  ) : (
                    <div className="placeholder compact-placeholder">
                      Screen preview unavailable. Re-select source or refresh.
                    </div>
                  )}
                </div>
                <div className="button-group compact">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void startScreenRecording()}
                    disabled={screenStatus === 'recording'}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void stopRecorder('screen')}
                    disabled={screenStatus !== 'recording'}
                  >
                    Stop
                  </button>
                </div>
              </article>

              <article className="feed-card">
                <header>
                  <h3>Webcam</h3>
                  <span className={`status-tag mini ${statusTone(webcamStatus)}`}>
                    {formatStatus(webcamStatus)}
                  </span>
                </header>
                <div className="media-frame">
                  {webcamStream ? (
                    <video
                      ref={webcamVideoRef}
                      className="mirrored-preview"
                      autoPlay
                      muted
                      playsInline
                    />
                  ) : (
                    <div className="placeholder compact-placeholder">
                      <div className="placeholder-stack">
                        <p>{webcamPreviewMessage}</p>
                        {!webcamEnabled && (
                          <button
                            type="button"
                            className="ghost tiny-button"
                            onClick={() => setWebcamEnabled(true)}
                          >
                            Enable webcam
                          </button>
                        )}
                        {webcamEnabled && (
                          <button
                            type="button"
                            className="ghost tiny-button"
                            onClick={() => void retryWebcamPreview()}
                          >
                            Retry webcam
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="button-group compact">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void startWebcamRecording()}
                    disabled={!webcamEnabled || webcamStatus === 'recording'}
                  >
                    Start
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void stopRecorder('webcam')}
                    disabled={webcamStatus !== 'recording'}
                  >
                    Stop
                  </button>
                </div>
              </article>
            </div>

            <div className="action-row">
              <button
                type="button"
                className="primary"
                onClick={() => void finishSession()}
                disabled={!session || isBusy}
              >
                Finish Session
              </button>
              {!isCleanMode && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void exportCurrentSession()}
                  disabled={!session || isBusy}
                >
                  Export
                </button>
              )}
            </div>
          </section>
        )}

        {view === 'complete' && session && (
          <section className="stage-card complete">
            <h2>Recording Complete</h2>

            <p className="path-text">{session.folderPath}</p>
            <p className="duration">Duration: {formatDuration(session.durationMs)}</p>

            <ul className="file-list">
              <li>screen.webm: {getBaseName(session.files.screenPath)}</li>
              <li>webcam.webm: {getBaseName(session.files.webcamPath)}</li>
              <li>final.mp4: {getBaseName(session.files.finalPath)}</li>
            </ul>

            <div className="input-row">
              <input
                value={sessionNameDraft}
                onChange={(event) => setSessionNameDraft(event.target.value)}
                placeholder="Rename session"
              />
              <button type="button" className="ghost" onClick={() => void renameCurrentSession()}>
                Rename
              </button>
            </div>

            <div className="action-row">
              <button type="button" className="primary" onClick={() => void openSessionFolder()}>
                Open Folder
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => void exportCurrentSession()}
                disabled={isBusy}
              >
                Export Again
              </button>
              <button type="button" className="ghost" onClick={resetToSetup}>
                New Session
              </button>
            </div>
          </section>
        )}
      </section>

      {(errorMessage || statusMessage || session?.exportStatus.message) && (
        <footer className="glass status-strip">
          {errorMessage && <p className="error">{errorMessage}</p>}
          {!errorMessage && statusMessage && <p className="success">{statusMessage}</p>}
          {!errorMessage && !statusMessage && session?.exportStatus.message && (
            <p className={session.exportStatus.state === 'failed' ? 'error' : 'success'}>
              {session.exportStatus.message}
            </p>
          )}
        </footer>
      )}

      <footer className="meta-footer">
        <span>
          Selected source: {selectedSource?.name ?? 'None'} | Save root:{' '}
          {saveRoot || '<default videos root>'} | Audio: system{' '}
          {shareSystemAudio ? 'on' : 'off'}, mic {shareMicrophone ? 'on' : 'off'}
        </span>
      </footer>
    </main>
  )
}

export default App
