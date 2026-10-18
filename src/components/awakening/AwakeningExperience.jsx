import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AuthScreen } from "../AuthScreen.jsx";
import { mountAwakeningScene } from "./awakeningScene.js";
import "./awakening.css";

function BoltMark() {
  return (
    <svg className="bolt-mark" viewBox="0 0 30 42" aria-hidden="true">
      <path d="M19 1 3 24h11l-5 17 19-26H16z" />
    </svg>
  );
}

const AwakeningStage = memo(function AwakeningStage({ slotRef, pending, optionsRef }) {
  const rootRef = useRef(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const scene = mountAwakeningScene(root, optionsRef.current);
    return () => scene.destroy();
  }, [optionsRef]);

  return (
    <div ref={rootRef} className={pending ? "fos-awaken intro-pending" : "fos-awaken"}>
      <a className="skip" href="#entry">
        Skip to sign in
      </a>
      <canvas id="universe" aria-hidden="true" />
      <div className="vignette" aria-hidden="true" />
      <header>
        <a className="brand" href="#home" aria-label="Freedom OS home">
          <BoltMark />
          <span>
            FREEDOM <b>OS</b>
            <small>PERSONAL INTELLIGENCE</small>
          </span>
        </a>
        <nav className="topnav" aria-label="Main navigation">
          <a href="#intelligence">Meet CHIEF</a>
          <a href="#freedom">The spirit</a>
        </nav>
        <div className="actions">
          <button className="motion" id="motion" aria-label="Pause ambient animation" aria-pressed="false">
            Ⅱ
          </button>
          <a className="enter-link" href="#entry">
            ENTER FREEDOM OS <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="progress" aria-hidden="true">
          <i />
        </div>
      </header>
      <nav className="rail" aria-label="Journey chapters">
        <a href="#home" className="active" aria-label="The beginning">
          <span>01</span>
          <i />
        </a>
        <a href="#intelligence" aria-label="The intelligence">
          <span>02</span>
          <i />
        </a>
        <a href="#freedom" aria-label="The spirit">
          <span>03</span>
          <i />
        </a>
        <a href="#entry" aria-label="Your world">
          <span>04</span>
          <i />
        </a>
      </nav>
      <main>
        <section className="chapter hero" id="home" aria-labelledby="hero-title">
          <div className="scene">
            <div className="hero-index">01 / A NEW FRONTIER</div>
            <div className="hero-copy">
              <p className="eyebrow" data-intro="eyebrow">
                <i className="dot" /> INDEPENDENT BY NATURE.
              </p>
              <h1 id="hero-title" tabIndex={-1}>
                <span className="hero-line">
                  <span data-intro="freedom">FREEDOM</span>
                </span>
                <span className="hero-line">
                  <span data-intro="think">TO THINK</span>
                </span>
                <span className="hero-line">
                  <span data-intro="bigger">
                    <em>BIGGER.</em>
                  </span>
                </span>
              </h1>
              <p data-intro="description">
                A mind of your own.
                <br />
                An intelligence that moves with you.
              </p>
              <a className="meet" data-intro="meet" href="#intelligence">
                MEET CHIEF <span aria-hidden="true">↓</span>
              </a>
            </div>
            <div className="orb-note" aria-hidden="true">
              INTELLIGENCE, AT YOUR COMMAND.
            </div>
            <div className="core-label" aria-hidden="true">
              <strong>CHIEF</strong>
              <small>YOUR SECOND MIND</small>
            </div>
            <div className="hero-bottom">
              <a className="scroll-hint" href="#intelligence">
                <span className="mouse" aria-hidden="true" />
                <span>
                  SCROLL TO DISCOVER
                  <small>ONE CONTINUOUS EXPERIENCE</small>
                </span>
              </a>
              <div className="signature">
                <span className="stars">★ ★ ★ ★ ★</span>
                <span>
                  THE SPIRIT OF FREEDOM.
                  <br />
                  THE POSSIBILITY OF TOMORROW.
                </span>
              </div>
            </div>
            <div className="opening" id="opening" hidden>
              <div className="opening-meta">
                <span>
                  <i className="dot" />
                  <span id="opening-phase">AWAKENING</span>
                </span>
                <span className="opening-time" aria-hidden="true">
                  <b id="opening-second">00</b> / 06
                </span>
              </div>
              <div className="opening-progress" aria-hidden="true">
                <i id="opening-progress" />
              </div>
              <button type="button" className="opening-skip" id="skip-intro">
                SKIP INTRO <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>
        </section>
        <section className="chapter intelligence" id="intelligence" aria-labelledby="mind-title">
          <div className="scene">
            <div className="section-title">
              <p className="eyebrow">02 / MEET YOUR SECOND MIND</p>
              <h2 id="mind-title">
                Clarity. Context. <em>Command.</em>
              </h2>
              <p>Six capabilities. One intelligence. Yours.</p>
            </div>
            <div id="panels" />
            <div className="mind-label" aria-hidden="true">
              <strong>CHIEF</strong>
              <small>YOUR SECOND MIND</small>
            </div>
            <div className="track">
              <div className="track-label">
                <span id="count">01 / 06</span>
                <span id="cap-name">REASONING</span>
              </div>
              <div className="segments" aria-label="Reveal a capability" />
              <p>KEEP SCROLLING. THE POSSIBILITIES UNFOLD.</p>
            </div>
          </div>
        </section>
        <section className="chapter freedom" id="freedom" aria-labelledby="freedom-title">
          <div className="scene">
            <div className="freedom-copy">
              <p className="eyebrow">
                <span className="stars">★ ★ ★ ★ ★</span> 03 / THE SPIRIT THAT MOVES US
              </p>
              <h2 id="freedom-title">
                YOUR LIFE.
                <br />
                YOUR MIND.
                <br />
                <em>YOUR TERMS.</em>
              </h2>
              <p>
                Inspired by the American spirit of independence.
                <br />
                Built around the freedom to choose your own direction.
              </p>
            </div>
            <div className="flag-caption" aria-hidden="true">
              50 STARS. ENDLESS POSSIBILITY.
            </div>
            <div className="principles">
              <div>
                <span>01 / INDEPENDENCE</span>
                <h3>Think for yourself.</h3>
                <p>Bring your questions. Keep your perspective.</p>
              </div>
              <div>
                <span>02 / OWNERSHIP</span>
                <h3>You set the boundaries.</h3>
                <p>Choose the context and access you allow.</p>
              </div>
              <div>
                <span>03 / POSSIBILITY</span>
                <h3>Build what comes next.</h3>
                <p>Make room for the life you want to create.</p>
              </div>
            </div>
            <a className="next" href="#entry">
              YOUR NEXT CHAPTER <span aria-hidden="true">↓</span>
            </a>
          </div>
        </section>
        <section className="chapter entry" id="entry" aria-labelledby="entry-title">
          <div className="entry-content">
            <div className="entry-intro">
              <p className="eyebrow">04 / YOUR WORLD, WITHIN REACH</p>
              <div className="entry-space" aria-hidden="true" />
              <div className="entry-message">
                <span className="entry-chief">C H I E F</span>
                <h2 id="entry-title">
                  Welcome <em>home.</em>
                </h2>
                <p>Your space to think. Your freedom to begin.</p>
              </div>
            </div>
            <div className="form-area">
              <div className="form-card">
                <div id="awakening-auth-slot" ref={slotRef} />
              </div>
              <p className="form-footer">A LITTLE MORE CLARITY. A LOT MORE POSSIBILITY.</p>
            </div>
          </div>
          <footer>
            <a href="#home">FREEDOM TO THINK BIGGER.</a>
            <span>FRONTIER / A FREEDOM OS CONCEPT</span>
            <a href="#home">
              BACK TO THE BEGINNING <span aria-hidden="true">↑</span>
            </a>
          </footer>
        </section>
      </main>
      <dialog id="detail" aria-labelledby="detail-title">
        <button className="close" aria-label="Close detail">
          ×
        </button>
        <p className="eyebrow" id="detail-kicker" />
        <h2 id="detail-title" />
        <p className="detail-copy" />
        <div className="example">
          <small id="example-label" />
          <p id="example-text" />
        </div>
        <button className="back">
          BACK TO THE JOURNEY <span aria-hidden="true">↗</span>
        </button>
      </dialog>
    </div>
  );
});

export function AwakeningExperience({
  initialMode = "login",
  deepLink = false,
  initialForm = null,
  onModeChange = null,
}) {
  const optionsRef = useRef({
    skipIntro: Boolean(deepLink),
    scrollToEntry: Boolean(deepLink),
  });
  const [pending] = useState(() => !deepLink);
  const [slot, setSlot] = useState(null);
  const slotRef = useCallback((node) => {
    setSlot(node);
  }, []);

  return (
    <>
      <AwakeningStage slotRef={slotRef} pending={pending} optionsRef={optionsRef} />
      {slot ? (
        createPortal(
          <AuthScreen
            initialMode={initialMode}
            initialForm={initialForm}
            onModeChange={onModeChange}
          />,
          slot
        )
      ) : null}
    </>
  );
}
