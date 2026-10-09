const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const filename = path.resolve(__dirname, '../components/BookingSummary.tsx');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
}).outputText;
const loaded = new Module(filename, module);
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
const originalRequire = loaded.require.bind(loaded);
loaded.require = (id) => id === '../lib/api' ? { checkAvailability: async () => null } : originalRequire(id);
loaded._compile(compiled, filename);
const BookingSummary = loaded.exports.default;

for (const service of ['hotel', 'meeting', 'restaurant']) {
    for (const step of ['awaiting_lookup', 'awaiting_verification', 'awaiting_selection']) {
        test(`${service} ${step} displays only the four identification fields`, () => {
            const html = renderToStaticMarkup(React.createElement(BookingSummary, {
                data: { service_type: service, modify_mode: 'modify_booking', modify_step: step, date: '13-10-2026', reservation_name: 'Sally' },
                intent: 'modify_booking', confidence: 0.9,
            }));
            for (const label of ['Reservation Type', 'Reservation Name', 'Reservation Date', 'Phone Number']) assert.ok(html.includes(label));
            assert.doesNotMatch(html, /Start Time|End Time|Guests|Check-Out|Add start time|Add attendee count/);
            assert.match(html, /Original booking phone number/);
        });
    }
}

test('pending lookup stays in search mode even if a stale intent says book_meeting', () => {
    const html = renderToStaticMarkup(React.createElement(BookingSummary, {
        data: { service_type: 'meeting', modify_mode: 'modify_booking', modify_step: 'awaiting_verification' },
        intent: 'book_meeting', confidence: 0.9,
    }));
    assert.match(html, /Reservation Type/);
    assert.match(html, /Reservation Date/);
    assert.match(html, /Phone Number/);
    assert.doesNotMatch(html, /Start Time|End Time|Guests/);
});
