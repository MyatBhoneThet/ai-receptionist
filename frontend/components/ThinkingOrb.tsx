'use client';

import { useEffect, useRef, useState } from 'react';
import { useAudioProcessor } from '../lib/useAudioProcessor';

interface ThinkingOrbProps {
    isThinking: boolean;
    isListening?: boolean;
    trigger?: 'voice' | 'text';
}

const VOICE_TASKS = [
    'Transcribing speech..',
    'Parsing intent..',
    'Searching vector space..',
    'Analyzing context..',
    'Optimizing response..',
    'Collapsing attention heads..',
    'Synthesizing output..',
    'Refining token probabilities..',
];

const TEXT_TASKS = [
    'Analyzing context..',
    'Searching vector space..',
    'Optimizing response..',
    'Running semantic match..',
    'Fetching memory embeddings..',
    'Refining token probabilities..',
    'Synthesizing output..',
    'Cross-referencing knowledge graph..',
];

export default function ThinkingOrb({ isThinking, isListening = false, trigger = 'text' }: ThinkingOrbProps) {
    const { volume, frequency } = useAudioProcessor(isListening);
    const volumeRef = useRef(0);
    const lerpedVolRef = useRef(0);
    const freqRef = useRef<number[]>([]);

    // Smooth volume updates
    useEffect(() => {
        volumeRef.current = volume;
        freqRef.current = frequency;
    }, [volume, frequency]);

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number | null>(null);
    const taskIdxRef = useRef(0);
    const taskIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const overlayRef = useRef<HTMLDivElement>(null);

    // Task state
    const [currentTask, setCurrentTask] = useState("");
    const [taskOpacity, setTaskOpacity] = useState(0);

    // Canvas animation
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let W = canvas.width;
        let H = canvas.height;
        let CX = W / 2;
        let CY = H / 2;
        const R = Math.min(W, H) * 0.28;

        // Fibonacci sphere dots
        const NUM_DOTS = 320;
        const golden = Math.PI * (3 - Math.sqrt(5));
        const baseDots: { ox: number; oy: number; oz: number }[] = [];
        for (let i = 0; i < NUM_DOTS; i++) {
            const y = 1 - (i / (NUM_DOTS - 1)) * 2;
            const r = Math.sqrt(1 - y * y);
            const theta = golden * i;
            baseDots.push({ ox: Math.cos(theta) * r, oy: y, oz: Math.sin(theta) * r });
        }

        // Pulses
        const NUM_PULSES = 6;
        const pulses = Array.from({ length: NUM_PULSES }, (_, i) => ({
            lat: Math.random() * Math.PI,
            lon: Math.random() * Math.PI * 2,
            phase: (i / NUM_PULSES) * Math.PI * 2,
            speed: 0.38 + Math.random() * 0.25,
        }));

        // Orbital rings
        const rings = [
            { tilt: 0.3, speed: 0.7, r: R * 1.18, dotCount: 18 },
            { tilt: 1.1, speed: -0.5, r: R * 1.28, dotCount: 14 },
            { tilt: 2.0, speed: 0.9, r: R * 1.08, dotCount: 22 },
        ];

        function rotateY(x: number, y: number, z: number, a: number) {
            return { x: x * Math.cos(a) + z * Math.sin(a), y, z: -x * Math.sin(a) + z * Math.cos(a) };
        }
        function rotateX(x: number, y: number, z: number, a: number) {
            return { x, y: y * Math.cos(a) - z * Math.sin(a), z: y * Math.sin(a) + z * Math.cos(a) };
        }

        let t = 0;

        const resize = () => {
            W = canvas.width = canvas.offsetWidth;
            H = canvas.height = canvas.offsetHeight;
            CX = W / 2;
            CY = H / 2;
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(canvas);

        const draw = () => {
            ctx.clearRect(0, 0, W, H);

            // Light radial background glow (much subtler on transparent)
            const bg = ctx.createRadialGradient(CX, CY, 0, CX, CY, Math.min(W, H) * 0.5);
            bg.addColorStop(0, 'rgba(10,30,80,0.2)');
            bg.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, W, H);

            // Smoothing
            lerpedVolRef.current += (volumeRef.current - lerpedVolRef.current) * 0.15;
            const v = lerpedVolRef.current;
            const freqs = freqRef.current;

            const ry = t * (0.28 + v * 0.4);
            const rx = t * (0.13 + v * 0.2);
            const scaledR = Math.min(W, H) * (0.28 + v * 0.08);

            // Orb dots
            const dotData = baseDots.map((d, idx) => {
                // Frequency-based displacement (morphing)
                // Map dot index to frequency bins (0..9)
                const freqIdx = Math.floor((idx / NUM_DOTS) * 10);
                const fVal = (freqs[freqIdx] || 0) / 255;
                const dist = scaledR * (1 + fVal * 0.25 * (isListening ? 1 : 0.1));

                let { x, y, z } = rotateY(d.ox * dist, d.oy * dist, d.oz * dist, ry);
                ({ x, y, z } = rotateX(x, y, z, rx));

                const depth = (z + scaledR) / (2 * scaledR);
                const sx = CX + x;
                const sy = CY + y;

                let pulse = 0;
                for (const p of pulses) {
                    const dotLat = Math.acos(Math.max(-1, Math.min(1, d.oy)));
                    const dotLon = Math.atan2(d.oz, d.ox);
                    const pLat = p.lat + t * (0.6 + v * 1.2);
                    const pLon = p.lon + t * (p.speed + v * 0.8);
                    const angle = Math.acos(Math.max(-1, Math.min(1,
                        Math.cos(dotLat) * Math.cos(pLat % Math.PI) +
                        Math.sin(dotLat) * Math.sin(pLat % Math.PI) * Math.cos(dotLon - pLon)
                    )));
                    const wave = Math.cos(angle * 4 - t * 3 + p.phase);
                    pulse += Math.max(0, wave) * (0.5 + v * 2.0);
                }
                pulse = Math.min(1.2, pulse);
                return { sx, sy, depth, pulse, z, fVal };
            });
            dotData.sort((a, b) => a.z - b.z);

            for (const d of dotData) {
                const voiceBoost = isListening ? v * 0.4 : 0;
                const alpha = (0.12 + d.depth * 0.58 + d.pulse * 0.3 + voiceBoost);
                const radius = 1.0 + d.depth * 1.8 + d.pulse * (1.5 + v * 3.5);

                // Color morphing
                const r = Math.round(80 + d.depth * 80 + d.pulse * (155 + v * 100));
                const g = Math.round(180 + d.depth * 40 + d.pulse * 75 + v * 30);
                const b = 255;

                if (d.pulse > 0.15 || (isListening && v > 0.1)) {
                    const glowRadius = radius * (4 + v * 12 + d.fVal * 10);
                    const glow = ctx.createRadialGradient(d.sx, d.sy, 0, d.sx, d.sy, glowRadius);
                    const glowAlpha = Math.min(0.8, (alpha * 0.5) + v * 0.5);
                    glow.addColorStop(0, `rgba(${r},${g},${b},${glowAlpha.toFixed(2)})`);
                    glow.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.beginPath();
                    ctx.arc(d.sx, d.sy, glowRadius, 0, Math.PI * 2);
                    ctx.fillStyle = glow;
                    ctx.fill();
                }

                ctx.beginPath();
                ctx.arc(d.sx, d.sy, radius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, alpha).toFixed(2)})`;
                ctx.fill();
            }

            // Orbital rings
            for (const ring of rings) {
                const ringSpeed = ring.speed * (1 + v * 2);
                const ringAngle = t * ringSpeed;
                const scaledRingR = ring.r * (scaledR / (Math.min(W, H) * 0.28));
                for (let i = 0; i < ring.dotCount; i++) {
                    const phi = (i / ring.dotCount) * Math.PI * 2 + ringAngle;
                    let rx2 = Math.cos(phi) * scaledRingR;
                    let ry2 = 0;
                    let rz = Math.sin(phi) * scaledRingR;
                    const cosT = Math.cos(ring.tilt), sinT = Math.sin(ring.tilt);
                    const newY = ry2 * cosT - rz * sinT;
                    const newZ = ry2 * sinT + rz * cosT;
                    ry2 = newY; rz = newZ;
                    let p = rotateY(rx2, ry2, rz, ry);
                    p = rotateX(p.x, p.y, p.z, rx);
                    const depth = (p.z + scaledRingR) / (2 * scaledRingR);
                    const alpha = 0.12 + depth * 0.5;
                    const ripple = Math.sin(phi * 3 - t * (2.5 + v * 5)) * 0.5 + 0.5;
                    const pr = Math.round(100 + ripple * 155);
                    const pg = Math.round(200 + ripple * 55);
                    const pb = 255;
                    const pa = alpha + ripple * (0.25 + v * 0.5);
                    const rAdj = (1.4 + depth * 1.4) * (1 + v * 1.5);
                    ctx.beginPath();
                    ctx.arc(CX + p.x, CY + p.y, rAdj + ripple * (1.2 + v * 3), 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(${pr},${pg},${pb},${Math.min(1, pa).toFixed(2)})`;
                    ctx.fill();
                }
            }

            // Core inner glow (liquid center)
            const coreBreath = 0.82 + Math.sin(t * (1.4 + v * 3)) * 0.18 + v * 0.25;
            const coreSize = scaledR * (0.55 + v * 0.6);
            const core = ctx.createRadialGradient(CX, CY, 0, CX, CY, coreSize * coreBreath);
            core.addColorStop(0, `rgba(200,245,255,${(0.12 * coreBreath + v * 0.15).toFixed(3)})`);
            core.addColorStop(0.5, `rgba(80,160,255,${(0.06 * coreBreath + v * 0.08).toFixed(3)})`);
            core.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.beginPath();
            ctx.arc(CX, CY, coreSize, 0, Math.PI * 2);
            ctx.fillStyle = core;
            ctx.fill();

            // Outer halo
            const halo = ctx.createRadialGradient(CX, CY, scaledR * 0.88, CX, CY, scaledR * (1.35 + v * 0.5));
            halo.addColorStop(0, `rgba(50,150,255,${(0.07 + v * 0.05).toFixed(2)})`);
            halo.addColorStop(0.4, `rgba(30,100,220,${(0.03 + v * 0.02).toFixed(2)})`);
            halo.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.beginPath();
            ctx.arc(CX, CY, scaledR * (1.35 + v * 0.5), 0, Math.PI * 2);
            ctx.fillStyle = halo;
            ctx.fill();

            t += 0.012;
            rafRef.current = requestAnimationFrame(draw);
        };

        rafRef.current = requestAnimationFrame(draw);
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            ro.disconnect();
        };
    }, []);

    // Task text cycling
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
            ref={overlayRef}
            aria-hidden={!isThinking}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 50,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none', // Allow clicking through to the chat
                opacity: isThinking ? 1 : 0,
                transition: 'opacity 0.45s ease, transform 0.45s ease',
                transform: isThinking ? 'scale(1)' : 'scale(0.9)',
            }}
        >
            <canvas
                ref={canvasRef}
                style={{
                    width: '100%',
                    maxWidth: '520px',
                    aspectRatio: '1 / 1',
                }}
            />
            <div
                style={{
                    marginTop: '-48px',
                    color: '#7efff5',
                    fontFamily: "'Inter', system-ui, sans-serif",
                    fontSize: '14px',
                    fontWeight: 500,
                    letterSpacing: '0.05em',
                    textShadow: '0 0 15px rgba(126,255,245,0.4)',
                    transition: 'opacity 0.4s ease',
                    opacity: isThinking || isListening ? 1 : 0,
                    userSelect: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                }}
            >
                {isListening ? (
                    <>
                        <span className="flex h-2 w-2 relative">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                        </span>
                        <span className="tracking-widest uppercase text-xs opacity-80">Listening to your voice...</span>
                    </>
                ) : (
                    <span 
                        className="italic opacity-90 animate-pulse"
                        style={{ opacity: taskOpacity, transition: 'opacity 0.4s ease' }}
                    >
                        {trigger === 'voice' ? 'Transcribing...' : (currentTask || 'Thinking...')}
                    </span>
                )}
            </div>
        </div>
    );
}
