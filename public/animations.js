/* ==========================================================================
   Delicioso · motion layer (enhanced GSAP integration)
   --------------------------------------------------------------------------
   Centralized, SPA-aware animation layer using GSAP Core, Timeline,
   ScrollTrigger, and Lenis (smooth scrolling).

   Preserves existing design, content, structure, and functionality.
   - Animates primarily transform/opacity for performance.
   - Translation-safe heading masks (whole nodes, no text splitting).
   - Cleans/rebuilds page animations on hash route changes.
   - Respects prefers-reduced-motion and responsive behavior via matchMedia.
   - Falls back gracefully if GSAP/ScrollTrigger/Lenis are unavailable.

   TO REMOVE: delete this file and the four script tags at the bottom of
   public/index.html.
   ========================================================================== */
(() => {
  "use strict";

  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  if (!gsap || !ScrollTrigger) return;

  gsap.registerPlugin(ScrollTrigger);
  ScrollTrigger.config({ ignoreMobileResize: true });
  gsap.defaults({ ease: "power2.out" });

  const reducedMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
  const COLORS = { cream: "#FCF1D0", rose: "#f2e6c1", night: "#010736" };

  let lenis = null;
  let introEndsAt = 0;
  let navAnimated = false;
  let pageCtx = null;
  let pageMM = null;
  let booted = false;
  let state = { desktop: true, reduced: reducedMQ.matches };
  let refreshTimer = 0;
  let appObserver = null;
  let appObserverTimer = 0;
  let lastInitHash = null;
  let initCount = 0;

  /* ---------------------------------------------------------------------- */
  /* Injected styles (animation helpers only)                                */
  /* ---------------------------------------------------------------------- */
  if (!document.getElementById("anim-styles")) {
    const style = document.createElement("style");
    style.id = "anim-styles";
    style.textContent = `
/* scroll progress */
.anim-progress{position:fixed;top:0;left:0;width:100%;height:3px;background:linear-gradient(90deg,var(--brass),var(--cream));transform:scaleX(0);transform-origin:0 50%;z-index:60;pointer-events:none}
html[dir="rtl"] .anim-progress{transform-origin:100% 50%}

/* headline mask (translation-safe: wraps existing nodes) */
.anim-line{display:block;overflow:hidden}
@supports (overflow:clip){.anim-line{overflow:clip;overflow-clip-margin:.14em}}
.anim-line-inner{display:block}

/* subtle interactive feedback (kept lightweight) */
.btn,.add,.cartbtn,.tabs button,.destination-tools button,.map-actions button{position:relative;overflow:hidden;isolation:isolate}
.btn::after,.add::after,.cartbtn::after,.tabs button::after,.destination-tools button::after,.map-actions button::after{content:"";position:absolute;inset:0;z-index:-1;background:var(--anim-fill-bg,var(--brass));transform:scaleY(var(--anim-fill,0));transform-origin:50% 100%;pointer-events:none;opacity:.12}
.btn{--anim-fill-bg:var(--night)}
.btn.dark,.add{--anim-fill-bg:var(--brass)}
.btn.ghost,.cartbtn,.tabs button,.destination-tools button{--anim-fill-bg:currentColor}
.map-actions button{--anim-fill-bg:var(--brass)}
`;
    document.head.appendChild(style);
  }

  /* ---------------------------------------------------------------------- */
  /* Smooth scrolling (Lenis + GSAP ticker)                                  */
  /* ---------------------------------------------------------------------- */
  function createLenis() {
    if (lenis || reducedMQ.matches || typeof window.Lenis !== "function") return;
    lenis = new window.Lenis({
      lerp: 0.12,
      wheelMultiplier: 1.2,
      touchMultiplier: 1.6,
      smoothWheel: true,
      syncTouch: true,
      autoRaf: false,
      gestureOrientation: "vertical"
    });
    lenis.on("scroll", ScrollTrigger.update);
    lenis.on("scroll", queueProgress);
  }

  function destroyLenis() {
    if (!lenis) return;
    lenis.destroy();
    lenis = null;
  }

  createLenis();
  gsap.ticker.add((t) => { if (lenis) lenis.raf(t * 1000); });
  gsap.ticker.lagSmoothing(0);

  /* ---------------------------------------------------------------------- */
  /* Scroll progress                                                         */
  /* ---------------------------------------------------------------------- */
  const progress = document.createElement("div");
  progress.className = "anim-progress";
  progress.setAttribute("aria-hidden", "true");
  document.body.appendChild(progress);
  const setProgress = gsap.quickSetter(progress, "scaleX");
  let barQueued = false;

  function updateProgress() {
    barQueued = false;
    const el = document.documentElement;
    const max = el.scrollHeight - window.innerHeight;
    const y = window.scrollY || el.scrollTop || 0;
    setProgress(max > 2 ? Math.min(1, Math.max(0, y / max)) : 0);
  }

  function queueProgress() {
    if (barQueued) return;
    barQueued = true;
    requestAnimationFrame(updateProgress);
  }

  window.addEventListener("scroll", queueProgress, { passive: true });
  window.addEventListener("resize", queueProgress, { passive: true });

  /* ---------------------------------------------------------------------- */
  /* Utilities                                                               */
  /* ---------------------------------------------------------------------- */
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      ScrollTrigger.refresh();
      updateProgress();
    }, 100);
  }

  function mark(el, kind) {
    if (!el || el.dataset.anim) return false;
    el.dataset.anim = kind;
    return true;
  }

  function isInViewport(el, threshold = 1.05) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight * threshold;
  }

  function introDelayFor(el) {
    if (!isInViewport(el)) return 0;
    return Math.max(0, Math.min(0.8, (introEndsAt - performance.now()) / 1000));
  }

  /* ---------------------------------------------------------------------- */
  /* Global delegated interactions (hover/focus micro-animations)             */
  /* ---------------------------------------------------------------------- */
  function interactiveFrom(target, selector, related) {
    const el = target && target.closest ? target.closest(selector) : null;
    if (!el) return null;
    if (related && el.contains(related)) return null;
    return el;
  }

  document.addEventListener("pointerover", (e) => {
    if (state.reduced || (e.pointerType && e.pointerType !== "mouse")) return;

    const btn = interactiveFrom(e.target, ".btn, .add, .tabs button, .destination-tools button, .map-actions button, .cartbtn", e.relatedTarget);
    if (btn) {
      gsap.to(btn, { "--anim-fill": 1, duration: 0.35, ease: "power2.out", overwrite: "auto" });
      gsap.to(btn, { y: -1, duration: 0.25, ease: "power2.out", overwrite: "auto" });
    }

    const card = interactiveFrom(e.target, "main .grid > .item, main .box", e.relatedTarget);
    if (card) {
      gsap.to(card, { y: -4, duration: 0.3, ease: "power2.out", overwrite: "auto" });
      const img = card.querySelector(".th.has img, .th img");
      if (img) {
        const base = img.dataset.anim === "photo" ? 1.12 : 1;
        gsap.to(img, { scale: base * 1.04, duration: 0.45, ease: "power2.out", overwrite: "auto" });
      }
    }

    const navLink = interactiveFrom(e.target, "header.nav nav a", e.relatedTarget);
    if (navLink) gsap.to(navLink, { y: -1, duration: 0.2, ease: "power2.out", overwrite: "auto" });
  }, { passive: true });

  document.addEventListener("pointerout", (e) => {
    if (state.reduced || (e.pointerType && e.pointerType !== "mouse")) return;

    const btn = interactiveFrom(e.target, ".btn, .add, .tabs button, .destination-tools button, .map-actions button, .cartbtn", e.relatedTarget);
    if (btn) {
      gsap.to(btn, { "--anim-fill": 0, y: 0, duration: 0.35, ease: "power2.inOut", overwrite: "auto" });
    }

    const card = interactiveFrom(e.target, "main .grid > .item, main .box", e.relatedTarget);
    if (card) {
      gsap.to(card, { y: 0, duration: 0.35, ease: "power2.out", overwrite: "auto" });
      const img = card.querySelector(".th.has img, .th img");
      if (img) {
        const base = img.dataset.anim === "photo" ? 1.12 : 1;
        gsap.to(img, { scale: base, duration: 0.45, ease: "power2.out", overwrite: "auto" });
      }
    }

    const navLink = interactiveFrom(e.target, "header.nav nav a", e.relatedTarget);
    if (navLink) gsap.to(navLink, { y: 0, duration: 0.2, ease: "power2.out", overwrite: "auto" });
  }, { passive: true });

  document.addEventListener("focusin", (e) => {
    if (state.reduced) return;
    const el = interactiveFrom(e.target, ".btn, .add, .tabs button, .destination-tools button, .map-actions button, input, select, textarea", null);
    if (!el) return;
    if (el.matches(".btn, .add, .tabs button, .destination-tools button, .map-actions button")) {
      gsap.to(el, { "--anim-fill": 0.85, duration: 0.25, overwrite: "auto" });
    } else {
      gsap.fromTo(el, { boxShadow: "0 0 0 0 rgba(34,57,111,0)" }, { boxShadow: "0 0 0 3px rgba(34,57,111,0.12)", duration: 0.25, overwrite: "auto" });
    }
  });
  document.addEventListener("focusout", (e) => {
    if (state.reduced) return;
    const el = interactiveFrom(e.target, ".btn, .add, .tabs button, .destination-tools button, .map-actions button, input, select, textarea", null);
    if (!el) return;
    if (el.matches(".btn, .add, .tabs button, .destination-tools button, .map-actions button")) {
      gsap.to(el, { "--anim-fill": 0, duration: 0.25, overwrite: "auto" });
    } else {
      gsap.to(el, { boxShadow: "0 0 0 0 rgba(34,57,111,0)", duration: 0.25, overwrite: "auto" });
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Global nav entrance                                                     */
  /* ---------------------------------------------------------------------- */
  function animateNavOnce(reduced) {
    if (navAnimated) return;
    navAnimated = true;
    const header = document.querySelector("header.nav");
    if (!header) return;
    const brand = header.querySelector(".brand-lockup");
    const navItems = gsap.utils.toArray(header.querySelectorAll("nav > a, nav > select, nav > button"));
    if (reduced) {
      gsap.fromTo(header, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4, clearProps: "opacity,visibility" });
      return;
    }
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.fromTo(header, { yPercent: -30, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, duration: 0.6, clearProps: "transform,opacity,visibility" });
    if (brand) tl.from(brand, { y: -8, autoAlpha: 0, duration: 0.45 }, "-=0.3");
    if (navItems.length) tl.from(navItems, { y: -8, autoAlpha: 0, duration: 0.4, stagger: 0.04, clearProps: "transform,opacity,visibility" }, "-=0.25");
  }

  /* ---------------------------------------------------------------------- */
  /* Page animations                                                         */
  /* ---------------------------------------------------------------------- */
  function revealHeadings(reduced) {
    gsap.utils.toArray("main h1, main h2, main h3.sh, main h3").forEach((el) => {
      if (el.closest(".item h3")) return; // item titles revealed with cards
      if (!mark(el, "heading")) return;

      let inner = el.querySelector(":scope > .anim-line > .anim-line-inner");
      if (!inner) {
        const mask = document.createElement("span");
        mask.className = "anim-line";
        inner = document.createElement("span");
        inner.className = "anim-line-inner";
        while (el.firstChild) inner.appendChild(el.firstChild);
        mask.appendChild(inner);
        el.appendChild(mask);
      }

      const delay = introDelayFor(el);
      if (reduced) {
        gsap.from(el, { autoAlpha: 0, duration: 0.45, delay, ease: "power1.out", scrollTrigger: { trigger: el, start: "top 90%", once: true } });
        return;
      }
      gsap.from(inner, {
        yPercent: 115,
        duration: 1,
        ease: "power4.out",
        delay,
        scrollTrigger: { trigger: el, start: "top 84%", once: true }
      });
    });
  }

  function heroEntrance(reduced) {
    const hero = document.querySelector("main .hero");
    if (!hero || !mark(hero, "hero")) return;

    const kicker = hero.querySelector(".hero-kicker");
    const lead = hero.querySelector(".hero-copy p");
    const btns = hero.querySelectorAll(".hero-copy .btns .btn");
    const facts = hero.querySelectorAll(".hero-facts li");
    const wordmark = hero.querySelector(".hero-wordmark");
    const rule = hero.querySelector(".hero-wordmark .wordmark-rule");

    if (reduced) {
      gsap.from(hero, { autoAlpha: 0, duration: 0.35 });
      return;
    }

    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    introEndsAt = performance.now() + 900;

    if (kicker) tl.from(kicker, { y: 12, autoAlpha: 0, duration: 0.45 }, 0.05);
    if (lead) tl.from(lead, { y: 14, autoAlpha: 0, duration: 0.55 }, 0.3);
    if (btns.length) tl.from(btns, { y: 10, autoAlpha: 0, duration: 0.4, stagger: 0.06, clearProps: "transform,opacity,visibility" }, 0.38);
    if (facts.length) tl.from(facts, { y: 8, autoAlpha: 0, duration: 0.35, stagger: 0.05, clearProps: "transform,opacity,visibility" }, 0.5);
    if (wordmark) tl.from(wordmark, { autoAlpha: 0, scale: 0.985, duration: 0.7 }, 0.12);
    if (rule) tl.from(rule, { scaleX: 0, transformOrigin: "50% 50%", duration: 0.45 }, 0.4);
  }

  function revealText(reduced) {
    // Only reveal key descriptive text blocks to avoid repeating similar motions.
    gsap.utils.toArray("main .lead, main .contact .lead, main .band p").forEach((el) => {
      if (!mark(el, "text")) return;
      if (el.closest(".hero")) return; // hero copy handled by heroEntrance
      const delay = introDelayFor(el);
      gsap.from(el, {
        autoAlpha: 0,
        y: reduced ? 0 : 14,
        duration: reduced ? 0.35 : 0.6,
        delay,
        ease: "power2.out",
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
        clearProps: "transform,opacity,visibility"
      });
    });
  }

  function revealCards(reduced) {
    // Primary content blocks only (avoid animating every nested box/panel repeatedly).
    const cards = gsap.utils.toArray("main .grid > .item, main .list .r, main .steps li").filter((el) => {
      if (el.dataset.anim) return false;
      el.dataset.anim = "content-block";
      return true;
    });
    if (!cards.length) return;

    if (reduced) {
      gsap.from(cards, { autoAlpha: 0, duration: 0.35, stagger: 0.02, scrollTrigger: { trigger: cards[0], start: "top 94%", once: true } });
      return;
    }

    ScrollTrigger.batch(cards, {
      start: "top 92%",
      once: true,
      onEnter: (batch) => gsap.fromTo(batch,
        { autoAlpha: 0, y: 22 },
        { autoAlpha: 1, y: 0, duration: 0.55, stagger: 0.05, ease: "power2.out", overwrite: true, clearProps: "transform,opacity,visibility" }
      )
    });

    // One subtle reveal for larger form/info panels per view.
    gsap.utils.toArray("main .cols > .box, main #ordblock.box").forEach((el) => {
      if (!mark(el, "panel")) return;
      gsap.from(el, {
        autoAlpha: 0,
        y: 16,
        duration: 0.5,
        ease: "power2.out",
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
        clearProps: "transform,opacity,visibility"
      });
    });
  }

  function revealDetails(reduced) {
    // Minimal supporting accents: section eyebrows and menu group headings.
    gsap.utils.toArray("main .eyebrow, main .gh").forEach((el) => {
      if (!mark(el, "detail")) return;
      if (el.closest(".hero")) return;
      gsap.from(el, {
        autoAlpha: 0,
        y: reduced ? 0 : 10,
        duration: reduced ? 0.3 : 0.45,
        ease: "power2.out",
        scrollTrigger: { trigger: el, start: "top 92%", once: true },
        clearProps: "transform,opacity,visibility"
      });
    });
  }

  function parallaxAndScrub(desktop, reduced) {
    if (reduced) return;
    const hero = document.querySelector("main .hero");
    if (hero) {
      const copy = hero.querySelector(".hero-copy");
      const wordmark = hero.querySelector(".hero-wordmark-inner");
      if (copy && mark(copy, "hero-copy-parallax")) {
        gsap.to(copy, { yPercent: 8, autoAlpha: 0.55, ease: "none", scrollTrigger: { trigger: hero, start: "top top", end: "bottom top", scrub: 0.4 } });
      }
      if (wordmark && mark(wordmark, "hero-mark-parallax")) {
        gsap.to(wordmark, { yPercent: -10, scale: 1.03, ease: "none", scrollTrigger: { trigger: hero, start: "top top", end: "bottom top", scrub: 0.4 } });
      }
    }

    if (desktop) {
      gsap.utils.toArray("main .grid > .item .th.has img").forEach((img) => {
        if (!mark(img, "photo-parallax")) return;
        const frame = img.closest(".th");
        gsap.set(img, { scale: 1.12, force3D: true });
        gsap.fromTo(img, { yPercent: -5 }, {
          yPercent: 5, ease: "none", force3D: true,
          scrollTrigger: { trigger: frame, start: "top bottom", end: "bottom top", scrub: 0.3 }
        });
      });
    }
  }

  function sectionColours(reduced) {
    if (reduced) return;
    gsap.utils.toArray("main section").forEach((section) => {
      const colour = section.classList.contains("contact") ? COLORS.night : section.classList.contains("band") ? COLORS.rose : COLORS.cream;
      ScrollTrigger.create({
        trigger: section,
        start: "top 55%",
        end: "bottom 45%",
        onEnter: () => gsap.to(document.body, { backgroundColor: colour, duration: 0.7, overwrite: "auto" }),
        onEnterBack: () => gsap.to(document.body, { backgroundColor: colour, duration: 0.7, overwrite: "auto" })
      });
    });
  }

  /* ---------------------------------------------------------------------- */
  /* SPA observers / lifecycle                                                */
  /* ---------------------------------------------------------------------- */
  function watchDynamicContent() {
    if (appObserver) appObserver.disconnect();
    const app = document.getElementById("app");
    if (!app) return;
    appObserver = new MutationObserver(() => {
      clearTimeout(appObserverTimer);
      // Dynamic interactions (filters/cart/forms/maps) should not replay entrance animations.
      appObserverTimer = setTimeout(() => {
        if (!booted) return;
        watchImages();
        refreshSoon();
      }, 220);
    });
    // Observe dynamic route content (menu filters, cart, reservations, map panels, etc.)
    appObserver.observe(app, { childList: true, subtree: true });
  }

  function watchImages() {
    document.querySelectorAll("main img").forEach((img) => {
      if (img.complete || img.dataset.animImg) return;
      img.dataset.animImg = "1";
      img.addEventListener("load", refreshSoon, { once: true });
      img.addEventListener("error", refreshSoon, { once: true });
    });
  }

  function clearPageAnimState() {
    // Rebuilds can leave stale markers/wrappers irrelevant after DOM replacement;
    // only strip markers on nodes that are not our persistent nav/progress helpers.
    document.querySelectorAll("main [data-anim]").forEach((el) => {
      // keep heading wrappers stable if same node persists (translation-safe),
      // but allow re-animation by removing marker when element has no active context.
      if (el.dataset.anim === "heading" && el.querySelector(".anim-line-inner")) {
        // leave wrapped structure; animation reapplied by targeting inner on rebuild via special handling below
      }
      el.removeAttribute("data-anim");
    });
  }

  function initPage(force = false) {
    const hash = location.hash || "#/";
    // Prevent replay on incidental re-runs for the same route/content (animations should play once on first view).
    if (!force && lastInitHash === hash && initCount > 0) {
      watchImages();
      refreshSoon();
      return;
    }

    if (pageMM) { pageMM.revert(); pageMM = null; }
    if (pageCtx) { pageCtx.revert(); pageCtx = null; }

    // Reset markers for this fresh route render only.
    document.querySelectorAll("main [data-anim]").forEach((el) => el.removeAttribute("data-anim"));
    // Preserve heading mask structure from previous render if any node persists (translation-safe),
    // but ensure revealed state is reset for new route by clearing transforms on wrappers we create.
    document.querySelectorAll("main .anim-line-inner").forEach((el) => gsap.set(el, { clearProps: "transform" }));

    gsap.set(document.body, { backgroundColor: COLORS.cream });

    pageCtx = gsap.context(() => {
      pageMM = gsap.matchMedia();
      pageMM.add({
        desktop: "(min-width: 768px)",
        reduced: "(prefers-reduced-motion: reduce)"
      }, (ctx) => {
        state = {
          desktop: !!ctx.conditions.desktop,
          reduced: !!ctx.conditions.reduced
        };

        animateNavOnce(state.reduced);
        heroEntrance(state.reduced);
        revealHeadings(state.reduced);
        revealText(state.reduced);
        revealCards(state.reduced);
        revealDetails(state.reduced);
        sectionColours(state.reduced);
        parallaxAndScrub(state.desktop, state.reduced);
      });
    });

    lastInitHash = hash;
    initCount += 1;
    watchImages();
    queueProgress();
    requestAnimationFrame(() => ScrollTrigger.refresh());
  }

  function waitForFirstRender() {
    const app = document.getElementById("app");
    if (!app) return;

    const start = () => {
      if (booted) return;
      booted = true;
      initPage(false);
      watchDynamicContent();
      refreshSoon();
    };

    if (app.children.length > 0 || document.body.dataset.p !== undefined) {
      start();
      return;
    }

    const observer = new MutationObserver(() => {
      if (!app.children.length) return;
      observer.disconnect();
      start();
    });
    observer.observe(app, { childList: true });

    setTimeout(() => {
      if (booted) return;
      observer.disconnect();
      if (app.children.length > 0) start();
    }, 9000);
  }

  window.addEventListener("hashchange", () => {
    if (lenis) lenis.scrollTo(0, { immediate: true });
    else window.scrollTo(0, 0);
    // Route changed: allow a fresh one-time animation pass for the new view.
    lastInitHash = null;
    setTimeout(() => initPage(true), 50);
  });

  window.addEventListener("load", refreshSoon);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refreshSoon);

  const langSelect = document.getElementById("lang");
  if (langSelect) langSelect.addEventListener("change", () => setTimeout(refreshSoon, 80));

  reducedMQ.addEventListener?.("change", () => {
    if (reducedMQ.matches) destroyLenis();
    else createLenis();
    // Rebuild for accessibility/media preference change.
    lastInitHash = null;
    initPage(true);
  });

  // If scripts are deferred, DOM may already be ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForFirstRender, { once: true });
  } else {
    waitForFirstRender();
  }
})();
