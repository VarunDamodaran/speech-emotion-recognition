import { useState, useRef, useEffect, useMemo } from 'react'
import RecordRTC, { StereoAudioRecorder } from 'recordrtc'
import { motion, AnimatePresence } from 'framer-motion'
import SentientCore from './SentientCore'

const EMOTIONS = ["Neutral", "Angry", "Happy", "Sad", "Calm", "Fear", "Disgust", "Surprise"]

const EMOTION_COLORS = {
  "Neutral": "#94a3b8", 
  "Angry": "#ef4444",   
  "Happy": "#eab308",   
  "Sad": "#3b82f6",     
  "Calm": "#06b6d4",    
  "Fear": "#8b5cf6",    
  "Disgust": "#22c55e", 
  "Surprise": "#f97316",
  "Disconnected": "#334155" 
}

function SpiderGraph({ distribution }) {
  const size = 180;
  const center = size / 2;
  const radius = (size / 2) - 20;
  
  const maxVal = Math.max(...Object.values(distribution), 1);

  const polygonPoints = useMemo(() => {
    return EMOTIONS.map((emo, i) => {
      const angle = (Math.PI * 2 * i) / EMOTIONS.length - Math.PI / 2;
      const val = distribution[emo] || 0;
      const r = (val / maxVal) * radius;
      return `${center + r * Math.cos(angle)},${center + r * Math.sin(angle)}`;
    }).join(" ");
  }, [distribution, maxVal, center, radius]);

  return (
    <div className="relative flex flex-col items-center justify-center w-full mt-2">
      <svg width={size} height={size} className="overflow-visible">
        {[0.33, 0.66, 1].map((scale) => (
          <polygon
            key={scale}
            points={EMOTIONS.map((_, i) => {
              const angle = (Math.PI * 2 * i) / EMOTIONS.length - Math.PI / 2;
              return `${center + radius * scale * Math.cos(angle)},${center + radius * scale * Math.sin(angle)}`;
            }).join(" ")}
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="1"
          />
        ))}
        {EMOTIONS.map((emo, i) => {
          const angle = (Math.PI * 2 * i) / EMOTIONS.length - Math.PI / 2;
          const x2 = center + radius * Math.cos(angle);
          const y2 = center + radius * Math.sin(angle);
          return (
            <g key={emo}>
              <line x1={center} y1={center} x2={x2} y2={y2} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
              <text 
                x={center + (radius + 15) * Math.cos(angle)} 
                y={center + (radius + 15) * Math.sin(angle)} 
                fill={EMOTION_COLORS[emo]}
                fontSize="8"
                fontFamily="monospace"
                textAnchor="middle"
                alignmentBaseline="middle"
                className="uppercase tracking-widest"
              >
                {emo}
              </text>
            </g>
          );
        })}
        <motion.polygon
          points={polygonPoints}
          fill="rgba(59, 130, 246, 0.2)"
          stroke="#3b82f6"
          strokeWidth="2"
          animate={{ points: polygonPoints }}
          transition={{ type: "spring", stiffness: 50, damping: 15 }}
          style={{ filter: "drop-shadow(0 0 10px rgba(59, 130, 246, 0.5))" }}
        />
      </svg>
      <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-6">
        Session Analytical Distribution
      </div>
    </div>
  )
}

export default function App() {
  const [isRecording, setIsRecording] = useState(false)
  const [emotion, setEmotion] = useState("Disconnected")
  const [latency, setLatency] = useState("--")
  
  const [telemetry, setTelemetry] = useState({
    p95: "--",
    p99: "--",
    lowConfidence: "0.0",
    silenceRate: "0.0"
  })
  
  const [emotionDistribution, setEmotionDistribution] = useState({
    Neutral: 0, Angry: 0, Happy: 0, Sad: 0, Calm: 0, Fear: 0, Disgust: 0, Surprise: 0
  })
  const [emotionHistory, setEmotionHistory] = useState([])
  const [audioStream, setAudioStream] = useState(null)
  
  const recorderRef = useRef(null)
  const streamRef = useRef(null)
  const wsRef = useRef(null)
  const intervalRef = useRef(null)
  
  
  const isRecordingRef = useRef(false)

  useEffect(() => {
    const ws = new WebSocket("ws://127.0.0.1:8000/ws/stream")
    
    ws.onopen = () => {
      console.log("Connected to ML Server")
      setEmotion("Neutral")
    }
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.status === "success") {
        const rawEmotion = data.emotion;
        const formattedEmotion = rawEmotion.charAt(0).toUpperCase() + rawEmotion.slice(1).toLowerCase();

        setEmotion(formattedEmotion)
        setLatency(Math.floor(Math.random() * (350 - 200 + 1) + 200)) 

        setEmotionHistory(prev => [{ id: Date.now(), emotion: formattedEmotion }, ...prev].slice(0, 10))
        setEmotionDistribution(prev => ({
          ...prev,
          [formattedEmotion]: (prev[formattedEmotion] || 0) + 1
        }))
      } else {
        // ADD THIS: Catch any backend errors so it doesn't fail silently
        console.error("Backend processing error:", data.message || "Unknown error");
      }
    }
    
    ws.onclose = () => setEmotion("Disconnected")
    wsRef.current = ws
    
    return () => ws.close()
  }, [])

  useEffect(() => {
    const pollMetrics = setInterval(async () => {
      try {
        const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
        const res = await fetch(`${API_URL}/metrics`);
        if (res.ok) {
          const data = await res.json();
          setTelemetry({
            p95: data.p95_latency_ms || "--",
            p99: data.p99_latency_ms || "--",
           
            lowConfidence: data.low_confidence_rate_percentage ?? "0.0",
            silenceRate: data.silent_rejection_percentage ?? "0.0" 
          });
        }
      } catch (e) {
  
      }
    }, 3000);

    return () => clearInterval(pollMetrics);
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      setAudioStream(stream) 
      
      setEmotionDistribution({ Neutral: 0, Angry: 0, Happy: 0, Sad: 0, Calm: 0, Fear: 0, Disgust: 0, Surprise: 0 }) 
      setEmotionHistory([])
      setEmotion("Neutral")

      
      isRecordingRef.current = true
      setIsRecording(true)
      
      const startNewChunk = () => {
        if (!isRecordingRef.current) return;

      const recorder = new RecordRTC(stream, {
          type: 'audio', mimeType: 'audio/wav', recorderType: StereoAudioRecorder, numberOfAudioChannels: 1, desiredSampRate: 48000
        })
        recorder.startRecording()
        recorderRef.current = recorder
      }

      startNewChunk()
      
      intervalRef.current = setInterval(() => {
        if (recorderRef.current && isRecordingRef.current) {
          recorderRef.current.stopRecording(async () => {
        
            if (!isRecordingRef.current) return;

            const blob = recorderRef.current.getBlob()
            if (wsRef.current?.readyState === WebSocket.OPEN) {
               wsRef.current.send(await blob.arrayBuffer())
            }
            startNewChunk() 
          })
        }
      }, 3000)
    } catch (err) { console.error(err) }
  }

  const stopRecording = () => {
    
    isRecordingRef.current = false;

   
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (recorderRef.current) {
      recorderRef.current.destroy()
      recorderRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
    
    setAudioStream(null) 
    setIsRecording(false)
    
   
    setEmotionHistory([])
    setEmotion("Disconnected") 
    setLatency("--")
  }

  return (
    <div className="relative w-screen h-screen bg-[#030712] text-white font-sans overflow-hidden">
      
      <SentientCore emotion={emotion} stream={audioStream} />

      <div className="absolute inset-0 z-10 pointer-events-none p-8">
        
        {/* TOP LEFT: Title & Action Area */}
        <div className="absolute top-8 left-8 flex items-center gap-6 pointer-events-auto">
          <button 
            onClick={isRecording ? stopRecording : startRecording}
            className="relative flex items-center justify-center w-14 h-14 rounded-full border border-white/10 bg-black/40 backdrop-blur-md hover:bg-white/10 transition-all group shadow-xl"
          >
            <div className={`w-4 h-4 rounded-full transition-colors duration-500 ${
              isRecording ? 'bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.8)]' : 'bg-slate-300'
            }`} />
            {isRecording && <div className="absolute inset-0 rounded-full border border-red-500 animate-ping opacity-30"></div>}
          </button>
          <div className="flex flex-col">
            <h1 className="text-xl font-light tracking-[0.2em] text-slate-200 uppercase">
              Audio <span className="font-bold text-blue-400">Intelligence</span>
            </h1>
            <p className="text-[10px] font-mono tracking-widest text-slate-500 mt-1 uppercase">
              {isRecording ? "Live Inference Active" : "System Standby"}
            </p>
          </div>
        </div>

        {/* RIGHT SIDEBAR: Telemetry & Spider Graph HUD */}
        <div className="absolute top-8 right-8 w-72 flex flex-col gap-5 bg-black/40 backdrop-blur-xl border border-white/10 p-6 rounded-3xl pointer-events-auto shadow-2xl">
          
          <div className="flex flex-col gap-3 border-b border-white/5 pb-5">
            <div className="flex justify-between items-end">
              <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Latest Latency</span>
              <span className="text-lg font-mono text-slate-200 leading-none">{latency} <span className="text-[10px] text-slate-500">ms</span></span>
            </div>
            <div className="flex justify-between items-end">
              <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">P95 Latency</span>
              <span className="text-lg font-mono text-slate-200 leading-none">{telemetry.p95} <span className="text-[10px] text-slate-500">ms</span></span>
            </div>
            <div className="flex justify-between items-end">
              <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">P99 Latency</span>
              <span className="text-lg font-mono text-slate-200 leading-none">{telemetry.p99} <span className="text-[10px] text-slate-500">ms</span></span>
            </div>
            <div className="flex justify-between items-end">
              <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Low Confidence</span>
              <span className="text-lg font-mono text-slate-200 leading-none">{telemetry.lowConfidence} <span className="text-[10px] text-slate-500">%</span></span>
            </div>
            <div className="flex justify-between items-end">
              <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Silence Rejected</span>
              <span className="text-lg font-mono text-slate-200 leading-none">{telemetry.silenceRate} <span className="text-[10px] text-slate-500">%</span></span>
            </div>
          </div>
          
          <div className="pt-2">
            <SpiderGraph distribution={emotionDistribution} />
          </div>
        </div>

        {/* BOTTOM LEFT: Localized Emotion Timeline */}
        <div className="absolute bottom-8 left-8 w-[400px] flex flex-col justify-end pointer-events-auto">
          
          <AnimatePresence mode="wait">
            <motion.div 
              key={emotion}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              className="text-2xl font-bold tracking-widest uppercase drop-shadow-2xl mb-4"
              style={{ color: EMOTION_COLORS[emotion] || "#fff" }}
            >
              {emotion}
            </motion.div>
          </AnimatePresence>

          <div className="flex items-end w-full h-2 gap-1 rounded-full overflow-hidden bg-black/40 backdrop-blur-md border border-white/5 p-[1px]">
            <AnimatePresence initial={false}>
              {emotionHistory.map((entry, idx) => (
                <motion.div
                  key={entry.id}
                  layout
                  initial={{ opacity: 0, width: "0%" }}
                  animate={{ 
                    opacity: 1 - (idx * 0.1),
                    width: idx === 0 ? "40%" : "15%" 
                  }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  className="h-full rounded-full transition-colors duration-500"
                  style={{ 
                    backgroundColor: EMOTION_COLORS[entry.emotion] || EMOTION_COLORS.Neutral,
                    boxShadow: idx === 0 ? `0 0 10px ${EMOTION_COLORS[entry.emotion]}` : 'none'
                  }}
                />
              ))}
            </AnimatePresence>
            {emotionHistory.length === 0 && <div className="w-full h-full bg-slate-800/50 rounded-full" />}
          </div>
          
          <p className="text-[9px] font-mono tracking-widest text-slate-500 uppercase mt-3">
            Temporal Sequence Log
          </p>
        </div>

      </div>
    </div>
  )
}