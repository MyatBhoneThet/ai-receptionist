'use client';

import React, { useEffect, useRef } from 'react';

interface Message {
    role: 'user' | 'assistant';
    content: string;
}

interface ChatWindowProps {
    messages: Message[];
}

export default function ChatWindow({ messages }: ChatWindowProps) {
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    return (
        <div className="flex h-full flex-col overflow-y-auto px-10 py-12 scroll-smooth custom-scrollbar">
            {messages.length === 0 && (
                <div className="flex flex-1 flex-col items-center justify-center space-y-8 text-center animate-slide-up">
                    <div className="flex h-24 w-24 items-center justify-center rounded-full bg-white shadow-sm border border-parchment animate-scale-in">
                        <span className="text-4xl">✨</span>
                    </div>
                    <div className="max-w-md space-y-3">
                        <h3 className="text-4xl font-light text-ink serif lowercase">
                            Welcome back
                        </h3>
                        <p className="text-sm text-ink/40 font-medium tracking-tight">
                            how can I assist you at Lumière today?
                        </p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-3 max-w-sm">
                        {['Book a suite for tomorrow', 'Dinner for three tonight', 'Executive meeting room'].map((hint) => (
                            <span key={hint} className="rounded-full bg-white/50 px-5 py-2.5 text-[11px] font-bold text-ink/60 border border-parchment cursor-pointer hover:bg-white hover:border-gold transition-all hover:text-gold uppercase tracking-widest leading-none">
                                {hint}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            <div className="flex flex-col space-y-8 max-w-4xl mx-auto w-full">
                {messages.map((msg, i) => (
                    <div
                        key={i}
                        className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-slide-up`}
                        style={{ animationDelay: `${i * 0.05}s` }}
                    >
                        <div className={`flex max-w-[85%] items-end space-x-3 ${msg.role === 'user' ? 'flex-row-reverse space-x-reverse' : 'flex-row'}`}>
                            {msg.role === 'assistant' && (
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white border border-parchment shadow-sm overflow-hidden mb-1">
                                    <img src="https://api.dicebear.com/7.x/notionists/svg?seed=Anya&backgroundColor=f9f7f2" alt="Anya" className="w-6 h-6" />
                                </div>
                            )}
                            
                            <div className="flex flex-col space-y-1">
                                <div
                                    className={`rounded-2xl px-6 py-4 text-[15px] leading-relaxed shadow-sm ${msg.role === 'user'
                                        ? 'bg-ink text-white rounded-br-none'
                                        : 'bg-white text-ink border border-parchment rounded-bl-none serif'
                                        }`}
                                >
                                    {msg.content}
                                </div>
                                <span className={`text-[10px] font-bold uppercase tracking-widest opacity-30 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                                    {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
            <div ref={bottomRef} className="h-8" />
        </div>
    );
}
