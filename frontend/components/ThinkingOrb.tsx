'use client';

import { useEffect, useRef } from 'react';
import { useAudioProcessor } from '../lib/useAudioProcessor';

interface ThinkingOrbProps {
    isThinking: boolean;
    isListening?: boolean;
}

/** Inline voice feedback keeps the conversation and composer accessible. */
export default function ThinkingOrb({ isThinking, isListening = false }: ThinkingOrbProps) {
    const { volume, frequency } = useAudioProcessor(isListening);
    const volumeRef = useRef(0);
    const frequencyRef = useRef<number[]>([]);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        volumeRef.current = volume;
        frequencyRef.current = frequency;
    }, [volume, frequency]);

    useEffect(() => {
        if (!isThinking) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;

        let frame = 0;
        let phase = 0;
        let smoothedVolume = 0;
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const resize = () => {
            const ratio = window.devicePixelRatio || 1;
            canvas.width = canvas.offsetWidth * ratio;
            canvas.height = canvas.offsetHeight * ratio;
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(canvas);

        const draw = () => {
            const width = canvas.offsetWidth;
            const height = canvas.offsetHeight;
            const centerX = width / 2;
            const centerY = height / 2;
            const radius = Math.min(width, height) * 0.25;
            context.clearRect(0, 0, width, height);
            smoothedVolume += (volumeRef.current - smoothedVolume) * 0.2;
            const level = Math.min(smoothedVolume * 2, 1);

            const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 1.6);
            glow.addColorStop(0, `rgba(201, 169, 110, ${0.15 + level * 0.25})`);
            glow.addColorStop(1, 'rgba(201, 169, 110, 0)');
            context.fillStyle = glow;
            context.fillRect(0, 0, width, height);

            for (let ring = 0; ring < 6; ring++) {
                context.beginPath();
                context.strokeStyle = `rgba(201, 169, 110, ${0.6 - ring * 0.06 + level * 0.2})`;
                context.lineWidth = 0.8 + level * 1.5;
                for (let point = 0; point <= 100; point++) {
                    const angle = point / 100 * Math.PI * 2;
                    const spectrum = (frequencyRef.current[point % 32] || 0) / 255;
                    const wave = Math.sin(angle * (3 + ring % 2) + phase * (1 + ring * 0.2));
                    const movement = reduceMotion ? 0 : wave * (1.5 + level * 4);
                    const sound = isListening ? spectrum * radius * 0.2 * level : 0;
                    const distance = radius * (0.85 + ring * 0.08) + movement + sound;
                    const x = centerX + Math.cos(angle) * distance;
                    const y = centerY + Math.sin(angle) * distance;
                    if (point === 0) context.moveTo(x, y);
                    else context.lineTo(x, y);
                }
                context.closePath();
                context.stroke();
            }
            phase += 0.02 + level * 0.04;
            frame = requestAnimationFrame(draw);
        };
        frame = requestAnimationFrame(draw);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, [isThinking, isListening]);

    if (!isThinking) return null;

    return (
        <div className="mb-3 flex items-center gap-3 rounded-2xl border border-gold/20 bg-white/70 px-3 py-1 shadow-sm sm:gap-4" data-testid="speech-feedback">
            <canvas ref={canvasRef} className="h-20 w-20 shrink-0 sm:h-24 sm:w-24" aria-hidden="true" />
            <div className="min-w-0 py-3">
                <p className="text-sm font-semibold text-ink" role="status" aria-live="polite">
                    {isListening ? 'Listening…' : 'Preparing your reply…'}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-ink/60">
                    {isListening
                        ? 'Speak naturally. Review your words below, then send.'
                        : 'Your concierge will respond shortly.'}
                </p>
            </div>
        </div>
    );
}
