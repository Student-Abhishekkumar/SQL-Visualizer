import { useCallback, useEffect, useLayoutEffect, useRef, useState, type AnimationEvent } from 'react'
import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Database,
  Layers,
  Moon,
  Play,
  ScanSearch,
  Sparkles,
  Sun,
} from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import { themeMode } from '../../theme/themes'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'
import { ThemeRail } from './ThemeRail'
import { finishHomeIntro, useHomeIntroPhase } from './homeIntro'
import './home.css'

interface HomePageProps {
  /** Enters the real application workspace (hash route `#/app`). */
  onEnter: () => void
  /** Optional background warm-up so the workspace opens quickly. */
  onWarm?: () => void
}

const COPYRIGHT_YEAR = new Date().getFullYear()

/** Longest landing beat in home.css (2.86s) plus a small margin. */
const INTRO_SETTLE_MS = 3000

const METHOD_STEPS = [
  {
    title: 'Compose',
    copy: 'Write SQL in a full Monaco editor with syntax highlighting, formatting and instant feedback — the same editor you already trust.',
    icon: Sparkles,
  },
  {
    title: 'Execute',
    copy: 'Run it against a genuine SQLite database compiled to WebAssembly. Real rows, real errors. Nothing is mocked.',
    icon: Play,
  },
  {
    title: 'Reveal',
    copy: 'The canvas animates each stage: sources, filters, joins, grouping and the final rows, assembled step by step.',
    icon: Layers,
  },
  {
    title: 'Inspect',
    copy: 'Open any node to read its real intermediate data, then scrub the playback event by event to see exactly why.',
    icon: ScanSearch,
  },
] as const

/**
 * The public homepage: an art-directed cinematic opening that settles into
 * a complete landing page, then hands off to the real workspace at `#/app`.
 *
 * Motion is CSS-driven and GPU-friendly (transform/opacity only); pointer
 * parallax runs through a single throttled animation frame loop. The whole
 * experience collapses to a calm static composition for reduced motion,
 * and heavy blur/glow is trimmed when "reduced effects" is enabled.
 */
export function HomePage({ onEnter, onWarm }: HomePageProps) {
  const reducedMotion = usePrefersReducedMotion()
  const reducedEffects = useUIStore((state) => state.reducedEffects)
  const theme = useUIStore((state) => state.theme)
  const toggleTheme = useUIStore((state) => state.toggleTheme)
  const isDark = themeMode(theme) === 'dark'

  const homeRef = useRef<HTMLDivElement>(null)
  const heroRef = useRef<HTMLElement>(null)
  const warmedRef = useRef(false)
  const enterTimerRef = useRef<number | null>(null)

  const introPhase = useHomeIntroPhase()
  const [introPlaying, setIntroPlaying] = useState(false)
  const [introDone, setIntroDone] = useState(
    () => reducedMotion || introPhase === 'played',
  )
  const [launching, setLaunching] = useState(false)

  // The landing choreography is armed by the entrance handoff, never by
  // mount: while the cinematic network still owns the screen the page stays
  // at rest, so its reveal can never be spent behind the overlay.
  useLayoutEffect(() => {
    if (introPhase !== 'released' || reducedMotion) return
    // The handoff arrives from the entrance's external store after mount, so
    // this is the documented "subscribe to an external system" case rather
    // than a state value that could have been derived during render.
    // oxlint-disable-next-line react/set-state-in-effect
    setIntroPlaying(true)
    finishHomeIntro()
  }, [introPhase, reducedMotion])

  // The strata fade in last, one after another; when the final line lands the
  // whole landing scene is at rest, so the page can drop its playing state and
  // fall back to the identical resting styles without cutting any beat short.
  const handleStrataSettled = useCallback((event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget.lastElementChild) return
    setIntroPlaying(false)
    setIntroDone(true)
  }, [])

  // A mid-session switch to reduced motion settles the page at once: the
  // phase is derived, so no state has to be written from an effect.
  const introActive = introPlaying && !reducedMotion

  // Safety net for the settle beat above: a tab that never delivers
  // animationend (throttled in the background, animations suppressed by an
  // extension) must still hand the page back at its resting state. The value
  // matches the longest scene beat in home.css (2.86s) plus a small margin; it
  // only ever clears state and never starts or skips the choreography.
  useEffect(() => {
    if (!introActive) return
    const timer = window.setTimeout(() => {
      setIntroPlaying(false)
      setIntroDone(true)
    }, INTRO_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [introActive])

  useEffect(
    () => () => {
      if (enterTimerRef.current !== null) window.clearTimeout(enterTimerRef.current)
    },
    [],
  )

  // Scroll-linked hero depth + section reveals. The homepage owns its own
  // scroll container, so listeners stay local and are torn down on unmount.
  useEffect(() => {
    const root = homeRef.current
    if (!root) return

    const revealNodes = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (reducedMotion || revealNodes.length === 0 || typeof IntersectionObserver === 'undefined') {
      revealNodes.forEach((node) => node.classList.add('is-inview'))
    } else {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue
            entry.target.classList.add('is-inview')
            observer.unobserve(entry.target)
          }
        },
        { root, threshold: 0.16, rootMargin: '0px 0px -10% 0px' },
      )
      revealNodes.forEach((node) => observer.observe(node))
      // Keep the observer alive for the lazy work above; cleanup below.
      ;(root as HTMLElement & { __revealObserver?: IntersectionObserver }).__revealObserver =
        observer
    }

    const hero = heroRef.current
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        root.classList.toggle('is-scrolled', root.scrollTop > 12)
        if (hero && !reducedMotion) {
          const progress = Math.min(1, root.scrollTop / (hero.offsetHeight || 1))
          hero.style.setProperty('--scroll', progress.toFixed(3))
        }
      })
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    onScroll()

    return () => {
      root.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
      const stored = (root as HTMLElement & { __revealObserver?: IntersectionObserver })
        .__revealObserver
      stored?.disconnect()
    }
  }, [reducedMotion])

  // Restrained pointer parallax on the sculpture (fine pointers only).
  useEffect(() => {
    const hero = heroRef.current
    if (!hero || reducedMotion) return
    if (typeof window.matchMedia !== 'function') return
    if (window.matchMedia('(hover: none)').matches) return

    let raf = 0
    let targetX = 0
    let targetY = 0
    let currentX = 0
    let currentY = 0

    const tick = () => {
      currentX += (targetX - currentX) * 0.12
      currentY += (targetY - currentY) * 0.12
      hero.style.setProperty('--mx', currentX.toFixed(3))
      hero.style.setProperty('--my', currentY.toFixed(3))
      if (Math.abs(targetX - currentX) > 0.001 || Math.abs(targetY - currentY) > 0.001) {
        raf = requestAnimationFrame(tick)
      } else {
        raf = 0
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(tick)
    }
    const onMove = (event: PointerEvent) => {
      const rect = hero.getBoundingClientRect()
      targetX = ((event.clientX - rect.left) / rect.width - 0.5) * 2
      targetY = ((event.clientY - rect.top) / rect.height - 0.5) * 2
      schedule()
    }
    const onLeave = () => {
      targetX = 0
      targetY = 0
      schedule()
    }

    hero.addEventListener('pointermove', onMove)
    hero.addEventListener('pointerleave', onLeave)
    return () => {
      hero.removeEventListener('pointermove', onMove)
      hero.removeEventListener('pointerleave', onLeave)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [reducedMotion])

  const warm = () => {
    if (warmedRef.current) return
    warmedRef.current = true
    onWarm?.()
  }

  const scrollToTop = () => {
    homeRef.current?.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' })
  }

  const handleEnter = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Let modified clicks (new tab/window) behave natively.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    warm()
    if (reducedMotion) {
      onEnter()
      return
    }
    if (launching) return
    setLaunching(true)
    enterTimerRef.current = window.setTimeout(onEnter, 460)
  }

  const ThemeIcon = isDark ? Sun : Moon

  return (
    <div
      ref={homeRef}
      className={`home ${reducedEffects ? 'is-calm' : ''}`}
      data-intro={introActive ? 'playing' : 'settled'}
      data-launching={launching ? 'true' : 'false'}
    >
      <a className="home-skip-link" href="#method">
        Skip to content
      </a>

      <header className="home-nav">
        <button
          type="button"
          className="home-brand"
          onClick={scrollToTop}
          aria-label="SQL Visualizer — back to top"
        >
          <span className="home-brand__mark" aria-hidden="true">
            <Database className="size-4" />
          </span>
          <span className="home-brand__text">
            <strong>SQL Visualizer</strong>
            <small>Local SQL workspace</small>
          </span>
        </button>

        <nav className="home-nav__links" aria-label="Homepage sections">
          <a href="#method">Method</a>
          <a href="#themes">Themes</a>
          <a href="#start">Start</a>
        </nav>

        <div className="home-nav__actions">
          <button
            type="button"
            className="home-icon-btn"
            onClick={toggleTheme}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            <ThemeIcon className="size-4" aria-hidden="true" />
          </button>
          <a
            className="home-btn home-btn--primary home-btn--sm"
            href="#/app"
            onClick={handleEnter}
            onPointerEnter={warm}
            onFocus={warm}
          >
            Open workspace
          </a>
        </div>
      </header>

      <main>
        <section
          id="top"
          ref={heroRef}
          className="home-hero"
          aria-labelledby="home-title"
        >
          <div className="home-scene" aria-hidden="true">
            <div className="home-lumen" />
            <div className="home-seam" />
            <div className="home-horizon" />
            <div className="home-strata" onAnimationEnd={handleStrataSettled}>
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className="home-shutter home-shutter--left">
              <span className="home-shutter__hairs" />
            </div>
            <div className="home-shutter home-shutter--right">
              <span className="home-shutter__hairs" />
            </div>
            <div className="home-vignette" />
          </div>

          <div className="home-hero__content">
            <p className="home-eyebrow home-rise" style={{ animationDelay: '0.5s' }}>
              <span className="home-eyebrow__rule" aria-hidden="true" />
              <span className="home-eyebrow__text">
                A local SQL workspace <span className="home-eyebrow__sep">—</span> in the browser
              </span>
            </p>

            <h1 id="home-title" className="home-headline">
              <span className="home-line">
                <span style={{ animationDelay: '0.62s' }}>Every query</span>
              </span>
              {' '}
              <span className="home-line">
                <span style={{ animationDelay: '0.76s' }}>
                  has a <em>shape</em>.
                </span>
              </span>
            </h1>

            <p className="home-sub home-rise" style={{ animationDelay: '0.95s' }}>
              Write real SQL against a real SQLite database in your browser, then watch each
              stage of the query unfold on an animated canvas — filters, joins, grouping and the
              rows they produce.
            </p>

            <div className="home-cta home-rise" style={{ animationDelay: '1.1s' }}>
              <a
                className="home-btn home-btn--primary"
                href="#/app"
                onClick={handleEnter}
                onPointerEnter={warm}
                onFocus={warm}
              >
                Open the workspace
                <ArrowRight className="size-4" aria-hidden="true" />
              </a>
              <a className="home-btn home-btn--ghost" href="#method">
                Explore the method
              </a>
            </div>

            <p
              className="home-trust home-rise"
              style={{ animationDelay: '1.28s' }}
              onAnimationEnd={() => setIntroDone(true)}
            >
              <span>Runs entirely in your browser</span>
              <span className="home-dot" aria-hidden="true">
                ·
              </span>
              <span>SQLite via WebAssembly</span>
              <span className="home-dot" aria-hidden="true">
                ·
              </span>
              <span>No account required</span>
            </p>
          </div>

          <div className="home-hero__foot">
            <a className="home-scrollcue" href="#method">
              <span>Scroll to explore</span>
              <ChevronDown className="size-4" aria-hidden="true" />
            </a>
            <button
              type="button"
              className="home-skip"
              onClick={() => {
                setIntroPlaying(false)
                setIntroDone(true)
              }}
              hidden={!introActive || introDone}
            >
              Skip intro
            </button>
          </div>
        </section>

        <section className="home-section home-manifesto" aria-labelledby="idea-title">
          <div className="home-section__inner">
            <p className="home-kicker" data-reveal>
              The idea
            </p>
            <h2 id="idea-title" className="home-statement" data-reveal>
              Most tools show you the answer.
              <br />
              <em>SQL Visualizer shows you the reasoning.</em>
            </h2>
            <p className="home-lead" data-reveal>
              A query is a sequence of decisions. We render those decisions as a living
              data-flow, so you can see where a row survived, where it was filtered out, and how
              the final answer was assembled.
            </p>

            <dl className="home-stats" data-reveal>
              <div className="home-stat">
                <dt>100%</dt>
                <dd>Local. Your data never leaves the browser.</dd>
              </div>
              <div className="home-stat">
                <dt>9</dt>
                <dd>Handcrafted themes, from Clarity to Cyberpunk.</dd>
              </div>
              <div className="home-stat">
                <dt>1</dt>
                <dd>Real SQLite engine, compiled to WebAssembly.</dd>
              </div>
            </dl>
          </div>
        </section>

        <section id="method" className="home-section" aria-labelledby="method-title">
          <div className="home-section__inner">
            <div className="home-section__head" data-reveal>
              <p className="home-kicker">The method</p>
              <h2 id="method-title" className="home-h2">
                From query to understanding, in four movements.
              </h2>
            </div>

            <ol className="home-method">
              {METHOD_STEPS.map((step, index) => {
                const Icon = step.icon
                return (
                  <li key={step.title} className="home-method__item" data-reveal>
                    <span className="home-method__index">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="home-method__glyph" aria-hidden="true">
                      <Icon className="size-5" />
                    </span>
                    <h3>{step.title}</h3>
                    <p>{step.copy}</p>
                  </li>
                )
              })}
            </ol>
          </div>
        </section>

        <section id="themes" className="home-section home-themes" aria-labelledby="themes-title">
          <div className="home-section__inner">
            <div className="home-section__head" data-reveal>
              <p className="home-kicker">Nine themes</p>
              <h2 id="themes-title" className="home-h2">
                Dress it for the way you think.
              </h2>
              <p className="home-lead">
                Six classic palettes and three expressive visual styles. Switching is instant —
                and your choice follows you straight into the workspace.
              </p>
            </div>
            <div className="home-themes__rail" data-reveal>
              <ThemeRail />
            </div>
          </div>
        </section>

        <section id="start" className="home-section home-start" aria-labelledby="start-title">
          <div className="home-section__inner">
            <div className="home-start__panel" data-reveal>
              <p className="home-kicker">Begin</p>
              <h2 id="start-title" className="home-h2">
                Start with a single query.
              </h2>
              <p className="home-lead">
                The example database is ready. Open the workspace, run a SELECT, and press
                Visualize to watch it unfold.
              </p>
              <div className="home-cta">
                <a
                  className="home-btn home-btn--primary"
                  href="#/app"
                  onClick={handleEnter}
                  onPointerEnter={warm}
                  onFocus={warm}
                >
                  Open the workspace
                  <ArrowRight className="size-4" aria-hidden="true" />
                </a>
                <button type="button" className="home-btn home-btn--ghost" onClick={scrollToTop}>
                  Back to top
                  <ArrowUp className="size-4" aria-hidden="true" />
                </button>
              </div>
              <p className="home-trust">No sign-up. Nothing is uploaded.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <div className="home-footer__inner">
          <div className="home-footer__brand">
            <span className="home-brand__mark" aria-hidden="true">
              <Database className="size-4" />
            </span>
            <div>
              <strong>SQL Visualizer</strong>
              <p>See what your SQL is really doing.</p>
            </div>
          </div>

          <nav className="home-footer__cols" aria-label="Footer">
            <div>
              <h3>Product</h3>
              <a href="#method">Method</a>
              <a href="#themes">Themes</a>
              <a href="#start">Start</a>
            </div>
            <div>
              <h3>Workspace</h3>
              <a href="#/app" onClick={handleEnter} onPointerEnter={warm} onFocus={warm}>
                Open workspace
              </a>
            </div>
            <div>
              <h3>Built with</h3>
              <span>SQLite · WebAssembly</span>
              <span>Monaco · React</span>
            </div>
          </nav>
        </div>
        <div className="home-footer__base">
          <span>© {COPYRIGHT_YEAR} SQL Visualizer</span>
          <span>Runs locally in your browser.</span>
        </div>
      </footer>
    </div>
  )
}