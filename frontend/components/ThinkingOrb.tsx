'use client';

import { useEffect, useRef, useState } from 'react';
import { useAudioProcessor } from '../lib/useAudioProcessor';

interface ThinkingOrbProps {
    isThinking: boolean;
    isListening?: boolean;
    trigger?: 'voice' | 'text';
}

const VOICE_TASKS = [
    'transcribing speech..',
    'parsing intent..',
    'searching archives..',
    'analyzing context..',
    'optimizing response..',
    'refining tone..',
    'synthesizing output..',
];

const TEXT_TASKS = [
    'analyzing context..',
    'searching archives..',
    'optimizing response..',
    'running semantic match..',
    'fetching memory..',
    'synthesizing output..',
];

export default function ThinkingOrb({ isThinking, isListening = false, trigger = 'text' }: ThinkingOrbProps) {
    const { volume, frequency } = useAudioProcessor(isListening);
    const volumeRef = useRef(0);
    const lerpedVolRef = useRef(0);
    const freqRef = useRef<number[]>([]);

    useEffect(() => {
        volumeRef.current = volume;
        freqRef.current = frequency;
    }, [volume, frequency]);

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const taskIdxRef = useRef(0);
    const taskIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const [currentTask, setCurrentTask] = useState("");
    const [taskOpacity, setTaskOpacity] = useState(0);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let W = canvas.width;
        let H = canvas.height;
        let CX = W / 2;
        let CY = H / 2;
        const baseR = Math.min(W, H) * 0.25;

        let t = 0;

        const resize = () => {
            W = canvas.width = canvas.offsetWidth * window.devicePixelRatio;
            H = canvas.height = canvas.offsetHeight * window.devicePixelRatio;
            CX = W / 2;
            CY = H / 2;
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
            // Adjusted coordinates for scaled context
            CX /= window.devicePixelRatio;
            CY /= window.devicePixelRatio;
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(canvas);

        const draw = () => {
            const currentW = canvas.width / window.devicePixelRatio;
            const currentH = canvas.height / window.devicePixelRatio;
            ctx.clearRect(0, 0, currentW, currentH);

            lerpedVolRef.current += (volumeRef.current - lerpedVolRef.current) * 0.15;
            const v = lerpedVolRef.current;
            const freqs = freqRef.current;

            // 1. Central Glow Circle
            const coreSize = baseR * (0.9 + v * 0.3);
            const coreGradient = ctx.createRadialGradient(CX, CY, 0, CX, CY, coreSize);
            coreGradient.addColorStop(0, `rgba(201, 169, 110, ${0.15 + v * 0.25})`);
            coreGradient.addColorStop(0.6, `rgba(201, 169, 110, ${0.05 + v * 0.1})`);
            coreGradient.addColorStop(1, 'rgba(0,0,0,0)');
            
            ctx.beginPath();
            ctx.arc(CX, CY, coreSize, 0, Math.PI * 2);
            ctx.fillStyle = coreGradient;
            ctx.fill();

            // 2. Vibrating Strings (Sine Waves)
            const numStrings = 6;
            for (let i = 0; i < numStrings; i++) {
                ctx.beginPath();
                const alpha = (0.4 - i * 0.05 + v * 0.5);
                ctx.strokeStyle = `rgba(201, 169, 110, ${Math.max(0.1, alpha).toFixed(2)})`;
                ctx.lineWidth = 1.2 + v * 3;
                
                const stringR = baseR * (0.95 + i * 0.08);
                const segments = 150;
                
                for (let s = 0; s <= segments; s++) {
                    const angle = (s / segments) * Math.PI * 2;
                    
                    // Wave modulation based on time, string index, and audio
                    const freqIdx = Math.floor((s / segments) * 16) % 32;
                    const fVal = (freqs[freqIdx] || 0) / 255;
                    
                    const baseNoise = Math.sin(angle * (3 + i % 2) + t * (1.5 + i * 0.5));
                    const jitter = Math.cos(angle * 8 - t * 4) * 0.5;
                    const audioBoost = isListening ? fVal * 45 * (v + 0.2) : v * 15;
                    
                    const dist = stringR + (baseNoise + jitter) * (4 + v * 20) + audioBoost;
                    const x = CX + Math.cos(angle) * dist;
                    const y = CY + Math.sin(angle) * dist;
                    
                    if (s === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.closePath();
                ctx.stroke();
            }

            // 3. Inner stable ring
            ctx.beginPath();
            ctx.arc(CX, CY, baseR * 0.9, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(201, 169, 110, ${0.1 + v * 0.2})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();

            t += 0.015 + v * 0.04;
            rafRef.current = requestAnimationFrame(draw);
        };

        rafRef.current = requestAnimationFrame(draw);
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            ro.disconnect();
        };
    }, [isListening]);

    useEffect(() => {
        if (isListening || !isThinking) {
            setTaskOpacity(0);
            return;
        }
        
        const tasks = trigger === 'voice' ? VOICE_TASKS : TEXT_TASKS;
        taskIdxRef.current = 0;
        setCurrentTask(tasks[0]);
        setTaskOpacity(1);

        taskIntervalRef.current = setInterval(() => {
            setTaskOpacity(0);
            setTimeout(() => {
                taskIdxRef.current = (taskIdxRef.current + 1) % tasks.length;
                setCurrentTask(tasks[taskIdxRef.current]);
                setTaskOpacity(1);
            }, 400);
        }, 2200);

        return () => {
            if (taskIntervalRef.current) clearInterval(taskIntervalRef.current);
        };
    }, [trigger, isThinking, isListening]);

    return (
        <div
            aria-hidden={!isThinking}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 150,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
                opacity: isThinking ? 1 : 0,
                transition: 'opacity 0.6s ease, transform 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
                transform: isThinking ? 'scale(1)' : 'scale(0.95)',
                background: isThinking ? 'rgba(249, 247, 242, 0.4)' : 'transparent',
                backdropFilter: isThinking ? 'blur(8px)' : 'none',
            }}
        >
            <canvas ref={canvasRef} style={{ width: '100%', maxWidth: '480px', aspectRatio: '1/1' }} />
            <div
                style={{
                    marginTop: '-64px',
                    color: '#c9a96e',
                    fontFamily: "'Instrument Serif', serif",
                    fontSize: '24px',
                    transition: 'opacity 0.4s ease',
                    opacity: isThinking || isListening ? 1 : 0,
                    userSelect: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '8px',
                }}
            >
                {isListening ? (
                    <div className="flex flex-col items-center">
                        <div className="flex space-x-1 mb-2">
                             {[0, 1, 2].map(i => (
                                <span key={i} className="h-1 w-1 rounded-full bg-gold animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                             ))}
                        </div>
                        <span className="tracking-tight lowercase text-ink/40 font-bold text-xs uppercase tracking-widest not-italic">Listening...</span>
                    </div>
                ) : (
                    <span 
                        className="lowercase first-letter:uppercase"
                        style={{ opacity: taskOpacity, transition: 'opacity 0.4s ease' }}
                    >
                        {trigger === 'voice' ? 'Transcribing...' : (currentTask || 'Thinking...')}
                    </span>
                )}
            </div>
        </div>
    );
}
