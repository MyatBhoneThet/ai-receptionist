interface RecognitionResult {
    isFinal: boolean;
    [index: number]: { transcript: string };
}

export interface SpeechRecognitionLike {
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    lang: string;
    onstart: (() => void) | null;
    onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
    onspeechend: (() => void) | null;
    onend: (() => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    start: () => void;
    stop: () => void;
    abort: () => void;
}

interface SpeechSessionOptions {
    lang: string;
    onTranscript: (text: string) => void;
    onInterimTranscript: (text: string) => void;
    onListeningChange: (listening: boolean) => void;
    onEnd: () => void;
    onError?: (error: string) => void;
    silenceMs?: number;
    maxDurationMs?: number;
}

/** One utterance per activation. A browser end/error never restarts the mic. */
export function createSpeechSession(recognition: SpeechRecognitionLike, options: SpeechSessionOptions) {
    let disposed = false;
    let started = false;
    let listening = false;
    let submitted = false;
    let stopped = false;
    let pendingTranscript = '';
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let durationTimer: ReturnType<typeof setTimeout> | null = null;

    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = options.lang;

    const clearTimers = () => {
        if (silenceTimer !== null) clearTimeout(silenceTimer);
        if (durationTimer !== null) clearTimeout(durationTimer);
        silenceTimer = null;
        durationTimer = null;
    };

    const updateListening = (next: boolean) => {
        if (listening === next) return;
        listening = next;
        options.onListeningChange(next);
    };

    const deliver = (text: string) => {
        const trimmed = text.trim();
        if (disposed || submitted || !trimmed) return;
        submitted = true;
        options.onInterimTranscript('');
        options.onTranscript(trimmed);
    };

    const detach = () => {
        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onspeechend = null;
        recognition.onend = null;
        recognition.onerror = null;
    };

    const stop = () => {
        if (disposed || stopped || !started) return;
        stopped = true;
        clearTimers();
        updateListening(false);
        // stop() allows the recognizer to finish its final result before onend.
        try {
            recognition.stop();
        } catch {
            recognition.onend?.();
        }
    };

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimers();
        detach();
        updateListening(false);
        options.onInterimTranscript('');
        try {
            recognition.abort();
        } catch {
            // An already-ended recognizer needs no further cleanup.
        }
    };

    recognition.onstart = () => {
        if (!disposed && !stopped) updateListening(true);
    };

    recognition.onresult = (event) => {
        if (disposed || submitted) return;
        let finalTranscript = '';
        let interimTranscript = '';
        for (let index = 0; index < event.results.length; index++) {
            const result = event.results[index];
            const text = result[0]?.transcript || '';
            if (result.isFinal) finalTranscript += text;
            else interimTranscript += text;
        }
        pendingTranscript = (finalTranscript + interimTranscript).trim();
        if (finalTranscript.trim()) {
            stop();
            deliver(finalTranscript);
            return;
        }
        options.onInterimTranscript(interimTranscript.trim());
        if (!stopped) {
            if (silenceTimer !== null) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(stop, options.silenceMs ?? 2000);
        }
    };

    recognition.onspeechend = stop;

    recognition.onend = () => {
        if (disposed) return;
        clearTimers();
        updateListening(false);
        // Some browsers end with only an interim result. Keep it as editable text.
        deliver(pendingTranscript);
        options.onInterimTranscript('');
        disposed = true;
        detach();
        options.onEnd();
    };

    recognition.onerror = (event) => {
        if (disposed) return;
        dispose();
        options.onError?.(event.error);
        options.onEnd();
    };

    return {
        start() {
            if (disposed || started) return;
            started = true;
            try {
                recognition.start();
                if (!disposed && !stopped) {
                    updateListening(true);
                    durationTimer = setTimeout(stop, options.maxDurationMs ?? 60000);
                }
            } catch {
                dispose();
                options.onError?.('start-failed');
                options.onEnd();
            }
        },
        stop,
        dispose,
    };
}
