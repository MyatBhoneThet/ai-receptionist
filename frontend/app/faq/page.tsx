'use client';

const faqs = [
  { q: 'What time is check-in and check-out?', a: 'Check-in from 2pm, check-out by 11am. Early/late options are subject to availability.' },
  { q: 'Do you offer airport transfer?', a: 'Yes, private car or shuttle. Please share your flight number and arrival time.' },
  { q: 'Is breakfast included?', a: 'Continental breakfast is available from 6:30–10:30. We can bundle it with your booking as an upsell.' },
  { q: 'Where can I park?', a: 'On-site covered parking is available. Valet can be arranged on request.' },
  { q: 'Can I book a table at the restaurant?', a: 'Absolutely—tell us your preferred time, party size, and dietary preferences.' },
  { q: 'Do you have meeting rooms?', a: 'Yes, from 4 to 40 seats with AV. We can arrange coffee, tea, and snacks.' },
];

const upsells = [
  'Room upgrade to deluxe with balcony',
  'Late checkout until 2pm',
  'Breakfast bundle for two',
  'Champagne and strawberries on arrival',
  'Spa credit add-on',
  'Airport pickup with meet-and-greet',
];

export default function FAQPage() {
  return (
    <main className="min-h-screen bg-parchment">
      <div className="max-w-5xl mx-auto px-6 py-12 space-y-10">
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-[0.3em] text-ink/50 font-bold">Knowledge Base</p>
          <h1 className="text-4xl font-bold text-ink">FAQs & Concierge Picks</h1>
          <p className="text-sm text-ink/60">Share these with guests or let the AI suggest them automatically.</p>
        </header>

        <section className="grid md:grid-cols-2 gap-4">
          {faqs.map((item) => (
            <article key={item.q} className="rounded-2xl border border-parchment bg-white p-5 shadow-sm">
              <h3 className="text-lg font-bold text-ink">{item.q}</h3>
              <p className="text-sm text-ink/70 mt-2">{item.a}</p>
            </article>
          ))}
        </section>

        <section className="rounded-2xl border border-parchment bg-white p-6 shadow-sm">
          <h2 className="text-xl font-bold text-ink mb-3">Upsell Suggestions</h2>
          <div className="flex flex-wrap gap-3">
            {upsells.map((item) => (
              <span key={item} className="px-3 py-2 rounded-full bg-ink text-white text-xs font-bold uppercase tracking-widest">
                {item}
              </span>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
