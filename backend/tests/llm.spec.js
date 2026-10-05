import { jest } from '@jest/globals';

const withResponse = jest.fn();
const createCompletion = jest.fn(() => ({ withResponse }));

await jest.unstable_mockModule('groq-sdk', () => ({
  default: jest.fn(() => ({
    chat: { completions: { create: createCompletion } },
  })),
}));

const { chat } = await import('../services/llm.js');
const originalModel = process.env.GROQ_MODEL;

function completion(content) {
  return {
    data: { choices: [{ message: { content } }] },
    response: { headers: { get: () => null } },
  };
}

describe('Groq receptionist integration', () => {
  beforeEach(() => {
    delete process.env.GROQ_MODEL;
    createCompletion.mockClear();
    withResponse.mockReset();
    withResponse.mockResolvedValue(completion(JSON.stringify({
      message: 'Welcome!', intent: 'greeting', confidence: 1,
    })));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalModel === undefined) delete process.env.GROQ_MODEL;
    else process.env.GROQ_MODEL = originalModel;
    jest.restoreAllMocks();
  });

  it.each([
    [undefined, 'openai/gpt-oss-120b'],
    ['  ', 'openai/gpt-oss-120b'],
    [' openai/gpt-oss-20b ', 'openai/gpt-oss-20b'],
  ])('uses compatible JSON options for GROQ_MODEL=%s', async (configuredModel, expectedModel) => {
    if (configuredModel !== undefined) process.env.GROQ_MODEL = configuredModel;

    const result = await chat([], 'Hello', '05-10-2026');
    const request = createCompletion.mock.calls[0][0];

    expect(request).toEqual(expect.objectContaining({
      model: expectedModel,
      max_completion_tokens: 2048,
      response_format: { type: 'json_object' },
      include_reasoning: false,
      reasoning_effort: 'low',
    }));
    expect(request).not.toHaveProperty('reasoning_format');
    expect(request).not.toHaveProperty('max_tokens');
    expect(result.message).toBe('Welcome!');
  });

  it('reads a trimmed model override on each call and omits GPT OSS options for other models', async () => {
    await chat([], 'Hello', '05-10-2026');
    process.env.GROQ_MODEL = ' llama-3.1-8b-instant ';
    await chat([], 'Hello again', '05-10-2026');

    const request = createCompletion.mock.calls[1][0];
    expect(request.model).toBe('llama-3.1-8b-instant');
    expect(request).not.toHaveProperty('include_reasoning');
    expect(request).not.toHaveProperty('reasoning_effort');
    expect(request).not.toHaveProperty('reasoning_format');
  });

  it('normalizes valid JSON while preserving booking state and UTC dates', async () => {
    const state = {
      service_type: 'hotel',
      date: new Date('2026-10-08T00:00:00Z'),
      end_date: new Date('2026-10-10T00:00:00Z'),
      start_time: '14:00',
      end_time: '11:00',
      people: 2,
      notes: 'Quiet room',
      reservation_name: 'Avery',
      phone_number: '0800000000',
    };
    withResponse.mockResolvedValue(completion(JSON.stringify({
      message: 'Is that everything?',
      intent: 'book_hotel',
      data: { people: 3 },
      missing_fields: [],
      confidence: 0.9,
    })));

    const result = await chat([], 'Three guests', '05-10-2026', state);

    expect(result).toEqual({
      message: 'Is that everything?',
      speak: 'Is that everything?',
      intent: 'book_hotel',
      data: { ...state, date: '08-10-2026', end_date: '10-10-2026', people: 3 },
      missing_fields: [],
      confidence: 0.9,
    });
    const sentContext = JSON.parse(createCompletion.mock.calls[0][0].messages.at(-1).content);
    expect(sentContext.state.date).toBe('08-10-2026');
    expect(sentContext.state.end_date).toBe('10-10-2026');
  });

  it.each(['provider error', 'malformed JSON', 'empty content'])('returns a safe fallback on %s', async (failure) => {
    if (failure === 'provider error') withResponse.mockRejectedValue(new Error('Model unavailable'));
    else withResponse.mockResolvedValue(completion(failure === 'malformed JSON' ? '{invalid' : ''));

    const result = await chat([], 'Hello', '05-10-2026');

    expect(result).toEqual({
      message: "Sorry, something went wrong. Let's try that again.",
      speak: "Sorry, something went wrong. Let's try that again.",
      intent: 'unknown',
      data: {
        service_type: '', date: '', end_date: '', start_time: '', end_time: '',
        people: null, notes: '', reservation_name: '', phone_number: '',
      },
      missing_fields: [],
      confidence: 0,
    });
  });
});
