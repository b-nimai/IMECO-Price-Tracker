import { useEffect, useRef } from 'react';

// Ported from mission-control-dashboard/src/hooks/useKioskMode.js. Keeps an unattended TV
// awake: Wake Lock where supported, plus the belt-and-braces fallbacks (a 1px looping
// video, near-silent audio, a rAF loop, and a synthetic pointer nudge) that keep both the
// browser and the OS idle timers from firing. Reloads every 6h to shed any leak.

const BLANK_VIDEO_SRC =
  'data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAAhmcmVlAAAAGm1kYXQAAAITBgX/xgBDAADBAAB//h4FAAhBgAAABAAHAABAAAAIAAAABg==';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const NUDGE_MS = 60 * 1000;

export function useKioskMode(): void {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    async function requestWakeLock() {
      if (!('wakeLock' in navigator)) return;
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        /* denied or unsupported — the fallbacks below cover it */
      }
    }

    function startVideoLoop() {
      if (videoRef.current) return;
      const v = document.createElement('video');
      v.src = BLANK_VIDEO_SRC;
      v.autoplay = true;
      v.loop = true;
      v.muted = true;
      v.playsInline = true;
      Object.assign(v.style, {
        position: 'fixed',
        top: '-1px',
        left: '-1px',
        width: '1px',
        height: '1px',
        opacity: '0',
        pointerEvents: 'none',
      });
      document.body.appendChild(v);
      void v.play().catch(() => {});
      videoRef.current = v;
    }

    function startSilentAudio() {
      if (audioRef.current) return;
      try {
        const AC =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0.001;
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start(0);
        audioRef.current = ctx;
      } catch {
        /* ignore */
      }
    }

    function startRafLoop() {
      const tick = () => {
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }

    function nudgeSystemIdle() {
      const clientX = Math.round(window.innerWidth / 2);
      const clientY = Math.round(window.innerHeight / 2);
      const opts = { bubbles: true, cancelable: true, clientX, clientY };
      try {
        document.dispatchEvent(new PointerEvent('pointermove', opts));
        document.dispatchEvent(new MouseEvent('mousemove', opts));
      } catch {
        /* ignore */
      }
      resumeAudio();
    }

    /** Resuming a closed context throws. StrictMode's double-mount closes one out from
     *  under the nudge timer, so the state check has to include 'closed'. */
    function resumeAudio() {
      const ctx = audioRef.current;
      if (!ctx || ctx.state !== 'suspended') return;
      void ctx.resume().catch(() => {});
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        void requestWakeLock();
        nudgeSystemIdle();
      }
    }

    function onInteract() {
      resumeAudio();
    }

    void requestWakeLock();
    startVideoLoop();
    startSilentAudio();
    startRafLoop();
    nudgeSystemIdle();

    const nudgeTimer = setInterval(nudgeSystemIdle, NUDGE_MS);
    const reloadTimer = setTimeout(() => window.location.reload(), SIX_HOURS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('click', onInteract);
    document.addEventListener('keydown', onInteract);

    return () => {
      clearInterval(nudgeTimer);
      clearTimeout(reloadTimer);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('click', onInteract);
      document.removeEventListener('keydown', onInteract);
      void wakeLockRef.current?.release().catch(() => {});
      videoRef.current?.remove();
      void audioRef.current?.close().catch(() => {});
    };
  }, []);
}
