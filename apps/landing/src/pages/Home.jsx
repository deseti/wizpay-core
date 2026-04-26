const APP_URL = 'https://app.wizpay.xyz'
const SOCIAL_URL = 'https://x.com/wizpay_arc'

const valuePills = [
  'Simple wallet payments',
  'Clear status from start to finish',
  'Built for mobile and desktop',
]

const stats = [
  { value: '1 app', label: 'for send, swap, and tracking' },
  { value: 'Few taps', label: 'to finish a payment' },
  { value: '24/7', label: 'visibility on every transfer' },
]

const features = [
  {
    eyebrow: 'Fast',
    title: 'Send money without the usual back and forth',
    description: 'Pay one person or a full list from the same clean flow.',
  },
  {
    eyebrow: 'Flexible',
    title: 'Switch between balances when you need to',
    description: 'Move between digital dollar and euro balances without opening another tool.',
  },
  {
    eyebrow: 'Global',
    title: 'Keep payments moving across networks',
    description: 'Use one app experience even when money needs a longer route.',
  },
  {
    eyebrow: 'Clear',
    title: 'Track every step with less guesswork',
    description: 'See what is ready, sent, or still on the way in plain language.',
  },
]

const steps = [
  {
    number: '01',
    title: 'Open the app',
    description: 'Start from the wallet you already use. No long setup wall.',
  },
  {
    number: '02',
    title: 'Add who gets paid',
    description: 'Choose one contact or paste in a full payment list.',
  },
  {
    number: '03',
    title: 'Review the total',
    description: 'Check the amount, route, and status before you confirm.',
  },
  {
    number: '04',
    title: 'Send and follow it live',
    description: 'Track progress in one place until the payment is done.',
  },
]

function SectionHeading({ badge, title, description }) {
  return (
    <div className="max-w-2xl space-y-4">
      <span className="inline-flex items-center rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-200/85">
        {badge}
      </span>
      <div className="space-y-3">
        <h2 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
          {title}
        </h2>
        <p className="max-w-xl text-sm leading-7 text-slate-300 sm:text-base">
          {description}
        </p>
      </div>
    </div>
  )
}

function FeatureCard({ eyebrow, title, description }) {
  return (
    <article className="surface-card rounded-[28px] p-6">
      <span className="inline-flex rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-200/80">
        {eyebrow}
      </span>
      <div className="mt-5 space-y-3">
        <h3 className="font-display text-xl font-semibold tracking-tight text-white">
          {title}
        </h3>
        <p className="text-sm leading-7 text-slate-300">
          {description}
        </p>
      </div>
    </article>
  )
}

function StepCard({ number, title, description }) {
  return (
    <article className="surface-card rounded-[28px] p-6">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-cyan-300/20 bg-cyan-300/10 text-sm font-semibold text-cyan-100">
        {number}
      </div>
      <div className="mt-5 space-y-3">
        <h3 className="font-display text-xl font-semibold tracking-tight text-white">
          {title}
        </h3>
        <p className="text-sm leading-7 text-slate-300">
          {description}
        </p>
      </div>
    </article>
  )
}

function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="soft-grid absolute inset-x-0 top-0 h-[42rem] opacity-50" />
        <div className="absolute -left-32 top-24 h-72 w-72 rounded-full bg-cyan-400/12 blur-[120px]" />
        <div className="absolute right-[-5rem] top-12 h-80 w-80 rounded-full bg-sky-500/12 blur-[140px]" />
        <div className="absolute bottom-[-8rem] left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-amber-300/10 blur-[160px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#050816]/75 backdrop-blur-xl">
        <div className="section-shell flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/6 shadow-[0_0_40px_rgba(34,211,238,0.15)]">
              <img
                src="/favicon.ico"
                alt="WizPay"
                width="22"
                height="22"
                className="rounded-md"
              />
            </div>
            <div>
              <p className="font-display text-lg font-semibold tracking-tight text-white">WizPay</p>
              <p className="text-xs text-slate-400">Simple wallet payments</p>
            </div>
          </div>

          <a
            href={APP_URL}
            className="inline-flex items-center justify-center rounded-full border border-cyan-300/20 bg-cyan-300/12 px-4 py-2 text-sm font-semibold text-cyan-50 transition hover:-translate-y-0.5 hover:bg-cyan-300/18"
          >
            Open App
          </a>
        </div>
      </header>

      <main>
        <section className="section-shell grid gap-12 pb-18 pt-12 sm:pb-22 sm:pt-16 lg:grid-cols-[minmax(0,1.02fr)_minmax(0,0.98fr)] lg:items-center lg:pt-24">
          <div className="animate-rise space-y-8">
            <span className="inline-flex items-center rounded-full border border-emerald-300/15 bg-emerald-300/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-100/85">
              Now simpler for everyday payments
            </span>

            <div className="space-y-5">
              <h1 className="font-display max-w-3xl text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl lg:leading-[1.02]">
                Send money from your wallet without the usual mess.
              </h1>
              <p className="max-w-2xl text-base leading-8 text-slate-300 sm:text-lg">
                WizPay turns a complex payment flow into one clear app for sending, switching balances, and following every transfer.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <a
                href={APP_URL}
                className="inline-flex items-center justify-center rounded-full bg-white px-6 py-3.5 text-sm font-semibold text-slate-950 shadow-[0_20px_60px_rgba(255,255,255,0.12)] transition hover:-translate-y-0.5 hover:bg-slate-100"
              >
                Get Started
              </a>
              <a
                href="#how-it-works"
                className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/5 px-6 py-3.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-white/8"
              >
                See How It Works
              </a>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {valuePills.map((item) => (
                <div
                  key={item}
                  className="rounded-2xl border border-white/8 bg-white/5 px-4 py-4 text-sm leading-6 text-slate-200"
                >
                  {item}
                </div>
              ))}
            </div>
          </div>

          <div className="animate-rise delay-1 relative">
            <div className="surface-card rounded-[32px] p-4 sm:p-5">
              <div className="mb-4 flex items-center justify-between rounded-[24px] border border-white/8 bg-white/6 px-4 py-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Payment view
                  </p>
                  <p className="mt-2 font-display text-2xl font-semibold text-white sm:text-3xl">
                    Clear, fast, premium
                  </p>
                </div>
                <div className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs font-semibold text-emerald-100">
                  Ready
                </div>
              </div>

              <div className="overflow-hidden rounded-[28px] border border-white/8 bg-[#0b1120] p-2 shadow-[0_30px_90px_rgba(0,0,0,0.35)]">
                <img
                  src="/hero-mockup.png"
                  alt="WizPay app preview"
                  width="1400"
                  height="980"
                  loading="eager"
                  decoding="async"
                  className="h-auto w-full rounded-[20px] object-cover"
                />
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {stats.map((stat) => (
                  <div
                    key={stat.label}
                    className="rounded-[24px] border border-white/8 bg-white/6 px-4 py-4"
                  >
                    <p className="font-display text-2xl font-semibold text-white">
                      {stat.value}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-slate-400">
                      {stat.label}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="section-shell pb-18 sm:pb-22">
          <SectionHeading
            badge="Benefits"
            title="Everything on the page now talks like a product, not a manual."
            description="The landing page is focused on what people can do right away: send money faster, stay in control, and understand what is happening at a glance."
          />

          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {features.map((feature) => (
              <FeatureCard
                key={feature.title}
                eyebrow={feature.eyebrow}
                title={feature.title}
                description={feature.description}
              />
            ))}
          </div>
        </section>

        <section id="how-it-works" className="section-shell pb-18 sm:pb-22">
          <div className="surface-card rounded-[32px] p-6 sm:p-8 lg:p-10">
            <SectionHeading
              badge="How It Works"
              title="A simple flow that feels familiar from the first tap."
              description="No dense explanation block. Just four steps people can scan quickly on mobile or desktop."
            />

            <div className="mt-8 grid gap-4 lg:grid-cols-4">
              {steps.map((step) => (
                <StepCard
                  key={step.number}
                  number={step.number}
                  title={step.title}
                  description={step.description}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="section-shell pb-24">
          <div className="relative overflow-hidden rounded-[32px] border border-white/10 bg-[linear-gradient(135deg,rgba(18,191,199,0.18),rgba(6,8,22,0.92)_45%,rgba(245,158,11,0.14))] px-6 py-8 sm:px-8 sm:py-10 lg:flex lg:items-center lg:justify-between lg:px-10">
            <div className="absolute right-0 top-0 h-44 w-44 rounded-full bg-white/12 blur-[120px]" />
            <div className="relative max-w-2xl space-y-4">
              <span className="inline-flex items-center rounded-full border border-white/12 bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/80">
                Try WizPay
              </span>
              <h2 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
                Open the app and send your first payment in a few taps.
              </h2>
              <p className="text-sm leading-7 text-slate-100/78 sm:text-base">
                The landing page is now focused on users only: no docs links, no technical wall, and no extra steps before the main action.
              </p>
            </div>

            <div className="relative mt-6 flex flex-col gap-3 sm:flex-row lg:mt-0">
              <a
                href={APP_URL}
                className="inline-flex items-center justify-center rounded-full bg-white px-6 py-3.5 text-sm font-semibold text-slate-950 transition hover:-translate-y-0.5 hover:bg-slate-100"
              >
                Try Now
              </a>
              <a
                href={SOCIAL_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-full border border-white/12 bg-white/6 px-6 py-3.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-white/10"
              >
                Follow Updates
              </a>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

export default Home
