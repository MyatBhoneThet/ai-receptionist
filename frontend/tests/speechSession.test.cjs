const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Exercise the browser-independent session lifecycle without a real microphone.
const filename = path.resolve(__dirname, '../lib/speechSession.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = new Module(filename, module);
loaded._compile(compiled, filename);
const { createSpeechSession } = loaded.exports;

function setup(options = {}) {
    const calls = { listening: [], transcripts: [], interim: [], errors: [], ends: 0 };
    const recognition = {
        starts: 0, stops: 0, aborts: 0,
        start() { this.starts++; this.onstart?.(); },
        stop() { this.stops++; },
        abort() { this.aborts++; },
        result(text, isFinal = false) { this.onresult?.({ results: [{ isFinal, 0: { transcript: text } }] }); },
    };
    const session = createSpeechSession(recognition, {
        lang: 'en-US',
        onTranscript: (text) => calls.transcripts.push(text),
        onInterimTranscript: (text) => calls.interim.push(text),
        onListeningChange: (next) => calls.listening.push(next),
        onEnd: () => calls.ends++,
        onError: (error) => calls.errors.push(error),
        ...options,
    });
    return { session, recognition, calls };
}

test('a final utterance stops listening and is delivered exactly once', () => {
    const { session, recognition, calls } = setup();
    session.start();
    assert.equal(recognition.continuous, false);
    recognition.result('change it to tomorrow');
    const staleResult = recognition.onresult;
    recognition.result(' change it to tomorrow ', true);
    staleResult({ results: [{ isFinal: true, 0: { transcript: 'duplicate result' } }] });
    recognition.onend();
    assert.deepEqual(calls.transcripts, ['change it to tomorrow']);
    assert.deepEqual(calls.listening, [true, false]);
    assert.equal(recognition.stops, 1);
    assert.equal(recognition.starts, 1);
    assert.equal(calls.ends, 1);
});

test('natural recognition end retains an interim draft and never restarts', () => {
    const { session, recognition, calls } = setup();
    session.start();
    recognition.result('table for five');
    recognition.onend();
    assert.deepEqual(calls.transcripts, ['table for five']);
    assert.deepEqual(calls.listening, [true, false]);
    assert.equal(recognition.starts, 1);
    assert.equal(recognition.onresult, null);
});

test('manual stop and speech-end wait for the last final result without duplication', () => {
    const { session, recognition, calls } = setup();
    session.start();
    recognition.result('October seven');
    recognition.onspeechend();
    session.stop();
    recognition.result('October seventh', true);
    recognition.onend();
    assert.deepEqual(calls.transcripts, ['October seventh']);
    assert.deepEqual(calls.listening, [true, false]);
    assert.equal(recognition.stops, 1);
});

for (const error of ['no-speech', 'network', 'not-allowed', 'aborted']) {
    test(`${error} releases listening state without retrying or submitting`, () => {
        const { session, recognition, calls } = setup();
        session.start();
        recognition.result('incomplete');
        recognition.onerror({ error });
        assert.deepEqual(calls.errors, [error]);
        assert.deepEqual(calls.listening, [true, false]);
        assert.deepEqual(calls.transcripts, []);
        assert.equal(recognition.starts, 1);
        assert.equal(recognition.aborts, 1);
        assert.equal(recognition.onend, null);
    });
}

test('disposing a session rejects late transcript events and releases recognition', () => {
    const { session, recognition, calls } = setup();
    session.start();
    const staleResult = recognition.onresult;
    const staleEnd = recognition.onend;
    session.dispose();
    staleResult({ results: [{ isFinal: true, 0: { transcript: 'late result' } }] });
    staleEnd();
    assert.deepEqual(calls.transcripts, []);
    assert.deepEqual(calls.listening, [true, false]);
    assert.equal(recognition.aborts, 1);
    assert.equal(calls.ends, 0);
});

test('a browser that omits speech-end still stops after transcript silence', async () => {
    const { session, recognition, calls } = setup({ silenceMs: 5, maxDurationMs: 1000 });
    session.start();
    recognition.result('next Friday');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(recognition.stops, 1);
    assert.deepEqual(calls.listening, [true, false]);
    recognition.onend();
    assert.deepEqual(calls.transcripts, ['next Friday']);
});

test('a start failure ends cleanly and does not leave a restart timer', () => {
    const { session, recognition, calls } = setup();
    recognition.start = () => { throw new Error('browser recognition unavailable'); };
    session.start();
    assert.deepEqual(calls.errors, ['start-failed']);
    assert.deepEqual(calls.listening, []);
    assert.equal(calls.ends, 1);
    assert.equal(recognition.aborts, 1);
});
