'use client';

import React, { ReactNode, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useMotionValue, useSpring } from 'framer-motion';
import { ArrowUpRight, Check, Menu, X } from 'lucide-react';

const NAV_LINKS = [
    { label: 'Features', href: '#features' },
    { label: 'How it works', href: '#how' },
    { label: 'Pricing', href: '#pricing' },
    { label: 'FAQ', href: '/faq' },
];

const FEATURES = [
    {
        title: 'Conversations',
        body: 'Guests ask in their own words. The receptionist understands intent, asks for what is missing and confirms before it books.',
    },
    {
        title: 'Voice first',
        body: 'Speech recognition in, natural speech out. Guests can talk to your front desk instead of typing into a form.',
    },
    {
        title: 'Smart bookings',
        body: 'Restaurant tables, hotel rooms and meeting spaces, checked against live availability and inventory before anything is promised.',
    },
    {
        title: 'Calendar sync',
        body: 'Every confirmed booking lands in Google Calendar automatically, so your team keeps working from the tools it already uses.',
    },
    {
        title: 'Analytics',
        body: 'A dashboard for booking volume, demand by type and occupancy, so you can see what guests actually ask for.',
    },
    {
        title: 'Hardened',
        body: 'Rate limiting on every tier, secure headers, validated input and role-based admin access from the first day.',
    },
];

const STEPS = [
    { title: 'Connect', body: 'Add your rooms, tables and meeting spaces, then link your Google Calendar.' },
    { title: 'Converse', body: 'Guests chat or speak. The receptionist collects details and checks availability.' },
    { title: 'Confirm', body: 'The booking is saved, synced to your calendar and the guest is notified.' },
];

const PLANS = [
    {
        name: 'Starter',
        monthly: 49,
        blurb: 'For a single restaurant or guesthouse getting started.',
        features: ['1 venue', '300 conversations / month', 'Text chat receptionist', 'Restaurant & room bookings', 'Email notifications'],
        cta: 'Start free trial',
        href: '/login',
    },
    {
        name: 'Pro',
        monthly: 149,
        featured: true,
        blurb: 'For busy venues that want voice, sync and insight.',
        features: ['Up to 3 venues', '2,000 conversations / month', 'Voice in and out', 'Google Calendar sync', 'Analytics dashboard', 'Inventory & availability rules'],
        cta: 'Start free trial',
        href: '/login',
    },
    {
        name: 'Enterprise',
        monthly: null,
        blurb: 'For hotel groups and multi-property operators.',
        features: ['Unlimited venues', 'Custom conversation volume', 'Role-based admin access', 'Dedicated onboarding', 'Priority support & SLA'],
        cta: 'Talk to us',
        href: 'mailto:hello@example.com',
    },
];

const MARQUEE = ['Hotels', 'Restaurants', 'Meeting rooms', 'Voice', 'Chat', 'Calendar sync', 'Analytics'];

const ANNUAL_DISCOUNT = 0.2;

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Dot that trails the pointer and expands into a label over [data-cursor] elements
 */
function Cursor() {
    const x = useMotionValue(-100);
    const y = useMotionValue(-100);
    const sx = useSpring(x, { stiffness: 350, damping: 30, mass: 0.4 });
    const sy = useSpring(y, { stiffness: 350, damping: 30, mass: 0.4 });
    const [label, setLabel] = useState<string | null>(null);
    const [enabled, setEnabled] = useState(false);

    useEffect(() => {
        if (!window.matchMedia('(pointer: fine)').matches) return;
        setEnabled(true);
        const onMove = (e: MouseEvent) => {
            x.set(e.clientX);
            y.set(e.clientY);
            const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-cursor]');
            setLabel(target ? target.dataset.cursor ?? '' : null);
        };
        window.addEventListener('mousemove', onMove);
        return () => window.removeEventListener('mousemove', onMove);
    }, [x, y]);

    if (!enabled) return null;
    const active = label !== null;

    return (
        <motion.div
            aria-hidden
            className="pointer-events-none fixed left-0 top-0 z-[100] mix-blend-difference"
            style={{ x: sx, y: sy }}
        >
            <motion.div
                className="flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-xs font-medium text-black"
                animate={{ width: active ? (label ? 88 : 56) : 12, height: active ? (label ? 88 : 56) : 12 }}
                transition={{ type: 'spring', stiffness: 300, damping: 24 }}
            >
                {label}
            </motion.div>
        </motion.div>
    );
}

/**
 * Pulls its child toward the pointer while hovered
 */
function Magnetic({ children }: { children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    const x = useSpring(0, { stiffness: 200, damping: 15 });
    const y = useSpring(0, { stiffness: 200, damping: 15 });

    const onMove = (e: React.MouseEvent) => {
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        x.set((e.clientX - rect.left - rect.width / 2) * 0.3);
        y.set((e.clientY - rect.top - rect.height / 2) * 0.3);
    };
    const onLeave = () => {
        x.set(0);
        y.set(0);
    };

    return (
        <motion.div ref={ref} className="inline-block" style={{ x, y }} onMouseMove={onMove} onMouseLeave={onLeave}>
            {children}
        </motion.div>
    );
}

interface PillProps {
    href: string;
    children: ReactNode;
    variant?: 'primary' | 'secondary' | 'gold';
    className?: string;
}

const PILL_STYLES = {
    primary: { base: 'border-ink bg-ink text-parchment', fill: 'bg-gold', hover: 'group-hover:text-ink' },
    secondary: { base: 'border-ink/20 text-ink', fill: 'bg-ink', hover: 'group-hover:text-parchment' },
    gold: { base: 'border-gold bg-gold text-ink', fill: 'bg-parchment', hover: 'group-hover:text-ink' },
};

/**
 * Rounded button whose hover fill rises from the bottom
 */
function Pill({ href, children, variant = 'secondary', className = '' }: PillProps) {
    const style = PILL_STYLES[variant];
    return (
        <Link
            href={href}
            data-cursor=""
            className={`group relative inline-flex items-center justify-center overflow-hidden rounded-full border px-7 py-4 text-base font-medium ${style.base} ${className}`}
        >
            <span className={`absolute inset-0 translate-y-full rounded-full transition-transform duration-500 ease-out group-hover:translate-y-0 ${style.fill}`} />
            <span className={`relative flex items-center gap-2 transition-colors duration-300 ${style.hover}`}>{children}</span>
        </Link>
    );
}

function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
    return (
        <motion.div
            className={className}
            initial={{ opacity: 0, y: 48 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.8, delay, ease: EASE }}
        >
            {children}
        </motion.div>
    );
}

function Marquee({ items, className = '' }: { items: string[]; className?: string }) {
    const row = [...items, ...items];
    return (
        <div className={`overflow-hidden whitespace-nowrap ${className}`}>
            <motion.div
                className="inline-flex"
                animate={{ x: ['0%', '-50%'] }}
                transition={{ duration: 28, ease: 'linear', repeat: Infinity }}
            >
                {row.map((item, i) => (
                    <span key={i} className="flex items-center">
                        <span className="px-5 md:px-10">{item}</span>
                        <span className="h-2 w-2 rounded-full bg-gold md:h-3 md:w-3" />
                    </span>
                ))}
            </motion.div>
        </div>
    );
}

function Nav() {
    const [open, setOpen] = useState(false);
    const [hidden, setHidden] = useState(false);

    // Hide on scroll down, reveal on scroll up
    useEffect(() => {
        let last = window.scrollY;
        const onScroll = () => {
            const y = window.scrollY;
            setHidden(y > last && y > 120);
            last = y;
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    useEffect(() => {
        document.body.style.overflow = open ? 'hidden' : '';
        return () => {
            document.body.style.overflow = '';
        };
    }, [open]);

    return (
        <>
            <motion.header
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.6 }}
                className={`fixed inset-x-0 top-0 z-50 flex items-center justify-between px-5 py-5 text-white mix-blend-difference transition-transform duration-500 md:px-12 md:py-7 ${hidden ? '-translate-y-full' : ''}`}
            >
                <Link href="/landing" className="text-lg font-bold tracking-tight">
                    AI Receptionist
                </Link>
                <nav className="hidden items-center gap-9 md:flex">
                    {NAV_LINKS.map(link => (
                        <Link key={link.label} href={link.href} data-cursor="" className="text-sm font-medium hover:opacity-60">
                            {link.label}
                        </Link>
                    ))}
                    <Magnetic>
                        <Link href="/" data-cursor="" className="block rounded-full bg-white px-5 py-2.5 text-sm font-medium text-black">
                            Live demo
                        </Link>
                    </Magnetic>
                </nav>
                <button aria-label="Open menu" className="md:hidden" onClick={() => setOpen(true)}>
                    <Menu size={26} />
                </button>
            </motion.header>

            <AnimatePresence>
                {open && (
                    <motion.div
                        className="fixed inset-0 z-[60] flex flex-col bg-ink px-5 py-5 text-parchment md:hidden"
                        initial={{ y: '-100%' }}
                        animate={{ y: 0 }}
                        exit={{ y: '-100%' }}
                        transition={{ duration: 0.5, ease: EASE }}
                    >
                        <div className="flex items-center justify-between">
                            <span className="text-lg font-bold tracking-tight">AI Receptionist</span>
                            <button aria-label="Close menu" onClick={() => setOpen(false)}>
                                <X size={26} />
                            </button>
                        </div>
                        <nav className="mt-16 flex flex-col gap-6">
                            {[...NAV_LINKS, { label: 'Live demo', href: '/' }].map(link => (
                                <Link key={link.label} href={link.href} onClick={() => setOpen(false)} className="serif text-4xl">
                                    {link.label}
                                </Link>
                            ))}
                        </nav>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}

function Hero() {
    const line = {
        hidden: { y: '70%', opacity: 0 },
        show: (i: number) => ({ y: 0, opacity: 1, transition: { duration: 0.9, delay: 0.1 * i, ease: EASE } }),
    };

    return (
        <section className="flex min-h-screen flex-col justify-center px-5 pb-16 pt-32 md:px-12 md:pb-24">
            <h1 className="text-[clamp(2.75rem,12vw,4.5rem)] leading-[1.02] tracking-tight md:text-[clamp(4.5rem,8vw,8rem)]">
                <motion.span className="block" variants={line} custom={0} initial="hidden" animate="show">
                    The front desk
                </motion.span>
                <motion.span className="flex items-center gap-[2vw]" variants={line} custom={1} initial="hidden" animate="show">
                    <span className="relative inline-block h-[0.62em] w-[1.5em] shrink-0 overflow-hidden rounded-full bg-gradient-to-r from-gold via-primary-500 to-gold">
                        <motion.span
                            className="absolute -top-[20%] h-[140%] w-[60%] rounded-full bg-white/55 blur-xl"
                            animate={{ left: ['-60%', '100%', '-60%'] }}
                            transition={{ duration: 8, ease: 'easeInOut', repeat: Infinity }}
                        />
                    </span>
                    that never
                </motion.span>
                <motion.span className="block italic" variants={line} custom={2} initial="hidden" animate="show">
                    sleeps.
                </motion.span>
            </h1>

            <div className="mt-12 flex flex-col gap-8 md:mt-16 md:flex-row md:items-end md:justify-between">
                <motion.p
                    className="max-w-md text-base leading-relaxed text-ink/70 md:text-lg"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, delay: 0.6, ease: EASE }}
                >
                    An AI receptionist for hotels and restaurants. It answers guests by voice or chat, books tables,
                    rooms and meetings, and keeps your calendar in sync.
                </motion.p>
                <motion.div
                    className="flex flex-col gap-3 sm:flex-row"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.8, delay: 0.7, ease: EASE }}
                >
                    <Magnetic>
                        <Pill href="/" variant="primary" className="w-full">
                            Try the live demo <ArrowUpRight size={18} />
                        </Pill>
                    </Magnetic>
                    <Magnetic>
                        <Pill href="#pricing" className="w-full">
                            See pricing
                        </Pill>
                    </Magnetic>
                </motion.div>
            </div>
        </section>
    );
}

function Features() {
    return (
        <section id="features" className="px-5 py-24 md:px-12 md:py-40">
            <Reveal>
                <h2 className="max-w-5xl text-4xl leading-[1.1] tracking-tight md:text-6xl">
                    Everything a great receptionist does, <em>without the queue.</em>
                </h2>
            </Reveal>
            <ul className="mt-12 border-t border-ink/15 md:mt-24">
                {FEATURES.map((feature, i) => (
                    <li key={feature.title}>
                        <Reveal delay={i * 0.08}>
                            <div
                                data-cursor=""
                                className="group flex flex-col gap-3 border-b border-ink/15 py-8 transition-all duration-500 md:flex-row md:items-center md:gap-0 md:px-6 md:py-12 md:hover:bg-ink md:hover:pl-9 md:hover:text-parchment"
                            >
                                <span className="text-sm font-medium text-ink/40 transition-colors duration-500 md:w-[108px] md:shrink-0 md:group-hover:text-gold">
                                    {String(i + 1).padStart(2, '0')}
                                </span>
                                <h3 className="text-3xl md:w-[40%] md:shrink-0 md:text-4xl">{feature.title}</h3>
                                <p className="text-base leading-relaxed text-ink/70 transition-colors duration-500 md:flex-1 md:text-lg md:group-hover:text-parchment/70">
                                    {feature.body}
                                </p>
                            </div>
                        </Reveal>
                    </li>
                ))}
            </ul>
        </section>
    );
}

function HowItWorks() {
    return (
        <section id="how" className="rounded-t-[2.5rem] bg-ink px-5 py-24 text-parchment md:rounded-t-[4rem] md:px-12 md:py-40">
            <Reveal>
                <h2 className="text-4xl leading-[1.1] tracking-tight md:text-6xl">
                    Live in <em className="text-gold">three steps.</em>
                </h2>
            </Reveal>
            <div className="mt-12 grid gap-5 md:mt-24 md:grid-cols-3 md:gap-6">
                {STEPS.map((step, i) => (
                    <Reveal key={step.title} delay={i * 0.1} className="h-full">
                        <div className="flex h-full min-h-[17.5rem] flex-col justify-between gap-12 rounded-3xl border border-parchment/15 p-8 md:min-h-[22rem] md:p-10">
                            <span className="text-sm font-medium text-gold">{String(i + 1).padStart(2, '0')}</span>
                            <div>
                                <h3 className="text-3xl leading-tight md:text-4xl">{step.title}</h3>
                                <p className="mt-4 text-lg leading-relaxed text-parchment/70">{step.body}</p>
                            </div>
                        </div>
                    </Reveal>
                ))}
            </div>
        </section>
    );
}

function Pricing() {
    const [annual, setAnnual] = useState(true);

    return (
        <section id="pricing" className="bg-ink px-3 pb-24 text-ink md:px-12 md:pb-40">
            <div className="rounded-[2.5rem] bg-parchment px-4 py-16 md:rounded-[4rem] md:px-12 md:py-28">
                <Reveal className="flex flex-col gap-10 md:flex-row md:items-end md:justify-between">
                    <div>
                        <h2 className="text-4xl leading-[1.1] tracking-tight md:text-6xl">
                            Simple, <em>honest</em> pricing.
                        </h2>
                        <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink/70 md:mt-6">
                            Priced per venue and by conversation volume. 14-day free trial on every plan, no card required.
                        </p>
                    </div>
                    <div className="inline-flex shrink-0 self-start whitespace-nowrap rounded-full border border-ink/20 p-1 text-sm font-medium md:self-auto">
                        {[false, true].map(value => (
                            <button
                                key={String(value)}
                                onClick={() => setAnnual(value)}
                                aria-pressed={annual === value}
                                className={`relative rounded-full px-5 py-2.5 transition-colors ${annual === value ? 'text-parchment' : 'text-ink'}`}
                            >
                                {annual === value && (
                                    <motion.span layoutId="billing" className="absolute inset-0 rounded-full bg-ink" />
                                )}
                                <span className="relative">{value ? 'Annual · save 20%' : 'Monthly'}</span>
                            </button>
                        ))}
                    </div>
                </Reveal>

                <div className="mt-10 grid gap-5 md:mt-20 lg:grid-cols-3">
                    {PLANS.map((plan, i) => {
                        const price = plan.monthly === null ? null : Math.round(plan.monthly * (annual ? 1 - ANNUAL_DISCOUNT : 1));
                        return (
                            <Reveal key={plan.name} delay={i * 0.1} className="h-full">
                                <div
                                    className={`flex h-full flex-col rounded-3xl border p-7 md:p-10 ${
                                        plan.featured ? 'border-ink bg-ink text-parchment' : 'border-ink/15 bg-white/60'
                                    }`}
                                >
                                    <div className="flex items-center justify-between">
                                        <h3 className="text-3xl">{plan.name}</h3>
                                        {plan.featured && (
                                            <span className="rounded-full bg-gold px-3 py-1.5 text-sm font-medium text-ink">Most popular</span>
                                        )}
                                    </div>
                                    <p className={`mt-3 text-base ${plan.featured ? 'text-parchment/70' : 'text-ink/70'}`}>{plan.blurb}</p>
                                    <div className="mt-8 flex items-baseline gap-2">
                                        <span className="serif text-5xl leading-none md:text-6xl">{price === null ? 'Custom' : `$${price}`}</span>
                                        {price !== null && (
                                            <span className={plan.featured ? 'text-parchment/70' : 'text-ink/70'}>/ month</span>
                                        )}
                                    </div>
                                    <p className={`mt-2 h-5 text-sm ${plan.featured ? 'text-parchment/70' : 'text-ink/40'}`}>
                                        {price !== null && (annual ? 'Billed annually' : 'Billed monthly')}
                                    </p>
                                    <ul className="my-8 flex-1 space-y-3">
                                        {plan.features.map(item => (
                                            <li key={item} className="flex items-center gap-3">
                                                <Check size={18} className="shrink-0 text-gold" />
                                                <span>{item}</span>
                                            </li>
                                        ))}
                                    </ul>
                                    <Pill href={plan.href} variant={plan.featured ? 'gold' : 'secondary'}>
                                        {plan.cta}
                                    </Pill>
                                </div>
                            </Reveal>
                        );
                    })}
                </div>
                <p className="mt-10 text-sm text-ink/40">
                    Extra conversations beyond your plan are billed at $0.08 each. Change or cancel any time.
                </p>
            </div>
        </section>
    );
}

function Footer() {
    return (
        <footer className="bg-ink text-parchment">
            <Link href="/" data-cursor="Try it" className="block border-y border-parchment/15 py-8 md:py-14">
                <Marquee items={['Meet your new receptionist', 'Try the live demo']} className="serif text-4xl md:text-7xl md:leading-none" />
            </Link>
            <div className="flex flex-col gap-6 px-5 py-10 text-sm text-parchment/70 md:flex-row md:items-center md:justify-between md:px-12">
                <span>© {new Date().getFullYear()} AI Receptionist</span>
                <nav className="flex flex-wrap gap-x-8 gap-y-3">
                    {[...NAV_LINKS, { label: 'Sign in', href: '/login' }].map(link => (
                        <Link key={link.label} href={link.href} className="hover:text-gold">
                            {link.label}
                        </Link>
                    ))}
                </nav>
            </div>
        </footer>
    );
}

export default function LandingPage() {
    return (
        <main className="bg-parchment text-ink">
            <Cursor />
            <Nav />
            <Hero />
            <Marquee items={MARQUEE} className="serif border-y border-ink/15 py-6 text-3xl md:py-10 md:text-4xl" />
            <Features />
            <HowItWorks />
            <Pricing />
            <Footer />
        </main>
    );
}
