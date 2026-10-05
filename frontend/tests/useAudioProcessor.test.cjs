const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../lib/useAudioProcessor.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function runHook() {
    let effect;
    const states = [];
    const loaded = new Module(filename, module);
    loaded.require = (name) => name === 'react' ? {
        useState: (initial) => [initial, (next) => states.push(next)],
        useEffect: (callback) => { effect = callback; },
    } : module.require(name);
    loaded._compile(compiled, filename);
    loaded.exports.useAudioProcessor(true);
    return { cleanup: effect(), states };
}

function mockBrowser(getUserMedia, options = {}) {
    const originals = new Map(['navigator', 'window', 'requestAnimationFrame', 'cancelAnimationFrame']
        .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const calls = { contexts: 0, stops: 0, closes: 0, disconnects: 0, frames: 0, cancelledFrames: [] };
    const stream = { getTracks: () => [{ stop: () => calls.stops++ }] };
    class AudioContext {
        constructor() { calls.contexts++; this.state = options.resume ? 'suspended' : 'running'; }
        createAnalyser() {
            return { frequencyBinCount: 128, getByteFrequencyData: (data) => data.fill(64), disconnect: () => calls.disconnects++ };
        }
        createMediaStreamSource() { return { connect() {}, disconnect: () => calls.disconnects++ }; }
        resume() { return options.resume(); }
        close() { calls.closes++; this.state = 'closed'; return Promise.resolve(); }
    }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => getUserMedia(stream) } } });
    globalThis.window = { AudioContext };
    globalThis.requestAnimationFrame = () => { calls.frames++; return 17; };
    globalThis.cancelAnimationFrame = (frame) => calls.cancelledFrames.push(frame);
    return {
        calls, stream,
        restore() {
            for (const [name, descriptor] of originals) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
            }
        },
    };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a microphone permission result arriving after cleanup immediately stops every track', async () => {
    let resolvePermission;
    const browser = mockBrowser(() => new Promise((resolve) => { resolvePermission = resolve; }));
    try {
        const { cleanup } = runHook();
        cleanup();
        resolvePermission(browser.stream);
        await settle();
        assert.equal(browser.calls.stops, 1);
        assert.equal(browser.calls.contexts, 0);
        assert.equal(browser.calls.frames, 0);
    } finally {
        browser.restore();
    }
});

test('active audio uses microphone frequencies and cleanup releases tracks, context, and frame', async () => {
    const browser = mockBrowser((stream) => Promise.resolve(stream));
    try {
        const { cleanup, states } = runHook();
        await settle();
        assert.equal(states.at(-1).volume, 0.5);
        assert.equal(states.at(-1).frequency.length, 32);
        assert.equal(states.at(-1).isSpeaking, true);
        cleanup();
        assert.equal(browser.calls.stops, 1);
        assert.equal(browser.calls.closes, 1);
        assert.equal(browser.calls.disconnects, 2);
        assert.deepEqual(browser.calls.cancelledFrames, [17]);
    } finally {
        browser.restore();
    }
});

test('cleanup during pending audio-context resume never starts an animation afterward', async () => {
    let resolveResume;
    const browser = mockBrowser((stream) => Promise.resolve(stream), {
        resume: () => new Promise((resolve) => { resolveResume = resolve; }),
    });
    try {
        const { cleanup } = runHook();
        await settle();
        cleanup();
        resolveResume();
        await settle();
        assert.equal(browser.calls.stops, 1);
        assert.equal(browser.calls.closes, 1);
        assert.equal(browser.calls.frames, 0);
    } finally {
        browser.restore();
    }
});
