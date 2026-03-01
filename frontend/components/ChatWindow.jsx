'use client';

import { useEffect, useRef } from 'react';

export default function ChatWindow({ messages }) {
    const bottomRef = useRef(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    return (
        <div className="flex h-full flex-col overflow-y-auto px-6 py-8 scroll-smooth">
            {messages.length === 0 && (
                <div className="flex flex-1 flex-col items-center justify-center space-y-6 text-center animate-fade-in">
                    <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-primary-500/10 text-4xl shadow-2xl shadow-primary-500/20 ring-1 ring-primary-500/20">
                        <span>👋</span>
                    </div>
                    <div className="max-w-sm space-y-2">
                        <h3 className="text-xl font-bold text-white">How can I help you?</h3>
                        <p className="text-sm text-slate-400 leading-relaxed">
                            I'm your AI receptionist. I can help you book a table, a room, or a meeting.
                        </p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-2">
                        {['Book a table for 2', 'Reserve a room', 'Schedule a meeting'].map((hint) => (
                            <span key={hint} className="rounded-full bg-slate-800/50 px-4 py-2 text-xs font-medium text-slate-300 border border-slate-700/50">
                                "{hint}"
                            </span>
                        ))}
                    </div>
                </div>
            )}

            <div className="flex flex-col space-y-6">
                {messages.map((msg, i) => (
                    <div
                        key={i}
                        className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}
                        style={{ animationDelay: `${i * 0.05}s` }}
                    >
                        <div className={`flex max-w-[80%] items-start space-x-3 ${msg.role === 'user' ? 'flex-row-reverse space-x-reverse' : 'flex-row'}`}>
                            {msg.role === 'assistant' && (
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-600 text-sm shadow-lg shadow-primary-500/20">
                                    🏨
                                </div>
                            )}
                            <div
                                className={`rounded-2xl px-5 py-3.5 text-sm leading-relaxed shadow-sm ${msg.role === 'user'
                                        ? 'bg-primary-600 text-white rounded-tr-none'
                                        : 'glass-card text-slate-200 rounded-tl-none'
                                    }`}
                            >
                                {msg.content}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
            <div ref={bottomRef} className="h-4" />
        </div>
    );
}

