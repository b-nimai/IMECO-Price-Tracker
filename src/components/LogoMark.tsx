import { useEffect, useRef } from 'react';

import logoVideo from '@/assets/imeco_logo_3.mp4';
import { cn } from '@/lib/utils';

/**
 * The animated IMECO wordmark.
 *
 * Three things about the source file drive everything here.
 *
 * 1. It is 1280×720 with the wordmark floating in the middle of a lot of empty frame, and
 *    the header slot is roughly 2.7:1. So the video is scaled up and offset inside an
 *    overflow-hidden box — a CSS crop. `object-fit: cover` cannot do this: it only ever
 *    crops to the container's aspect around a point, which would leave the wordmark tiny
 *    inside a mostly-empty box.
 *
 * 2. Its background is pure black, not transparent — mp4 has no alpha. `mix-blend-mode:
 *    screen` is what makes that black drop away against the dark header: screen leaves
 *    black untouched and keeps the light wordmark, so no letterbox shows.
 *
 * 3. THE CLIP IS AN IN-AND-OUT, AND ENDS EMPTY. Particles blow in, the mark is legible from
 *    t≈3.8s at 720×212, eases down to a stationary 659×193 by t=6, holds there to ≈8.6s,
 *    then dissolves back into smoke — the final frame carries no logo at all. Measured per
 *    frame at 0.2s steps, filtering out the smoke by requiring a column to carry ≥10 bright
 *    pixels: a letter stroke does, a particle trail does not.
 *
 *    Two things follow. The crop is the UNION over the whole legible window (3.8–8.6s)
 *    rather than any single frame, so no letter is ever cut while the mark is up; the cost
 *    is that the settled mark sits at ~89% of the box height instead of filling it. And the
 *    reduced-motion path parks on HOLD_FRAME instead of the end, which would otherwise
 *    leave an empty box.
 *
 *    The clip loops in full, all 10s, so the mark is present for roughly five seconds of
 *    every ten and the rest is smoke sweeping past. That is the asset's own rhythm; the
 *    plume ranges far wider than any crop that keeps the wordmark legible could contain,
 *    so it clips at the edges by design.
 */

/**
 * Union of the wordmark's bounds across the legible window. Cropping to this is what
 * guarantees no letter is ever clipped while the mark is up.
 *
 * RE-MEASURE THESE IF THE SOURCE CLIP IS REPLACED — they are specific to the file, and a
 * swap silently mis-frames the logo otherwise.
 */
const MARK = { x: 294, y: 239, w: 720, h: 217 };
const FRAME = { w: 1280, h: 720 };
/** Mid-hold, where the mark is fully formed and stationary. */
const HOLD_FRAME = 6.4;

/**
 * Breathing room either side, in source pixels, so the mark is not flush against the crop.
 *
 * Horizontal only, and applied symmetrically so the centre does not move. Because the scale
 * is set by the crop's HEIGHT, padding the sides costs the mark no size at all — it only
 * widens the box. Vertical padding would shrink the mark, which is the one thing there is
 * no room for.
 */
const PAD_X = 36;

const CROP = {
  x: MARK.x - PAD_X,
  y: MARK.y,
  w: MARK.w + PAD_X * 2,
  h: MARK.h,
};

/**
 * Height is the hard constraint, width is free.
 *
 * 48px is exactly as tall as the title block sitting next to it, which is what sets the
 * header's height — so the box fills the bar completely without making it one pixel taller.
 * (It was 43px until the title grew for TV legibility; re-measure it if the title moves
 * again, or the mark starts reading as undersized next to the words.) Width then follows
 * from the crop's own aspect rather than being chosen and cropped to.
 *
 * The box shrinks on phones (see BOX_CLASS), which is why the video is positioned in
 * PERCENTAGES of the box below rather than pixels: the framing then follows whatever size
 * the box happens to be, and there is only one set of numbers to keep correct.
 */
const BOX_H = 48;
const BOX_W = Math.round((BOX_H * CROP.w) / CROP.h);
/** Same aspect at both sizes (3.65:1); the phone/tablet box is simply smaller. */
const BOX_CLASS = 'h-[32px] w-[117px] lg:h-[48px] lg:w-[175px]';

const scale = BOX_H / CROP.h;
const cropCentre = { x: CROP.x + CROP.w / 2, y: CROP.y + CROP.h / 2 };

/** Video width as a percentage of the box, and its offset likewise — see note above. */
const videoWidthPct = ((FRAME.w * scale) / BOX_W) * 100;
const leftPct = ((BOX_W / 2 - cropCentre.x * scale) / BOX_W) * 100;
const topPct = ((BOX_H / 2 - cropCentre.y * scale) / BOX_H) * 100;

export function LogoMark({ syncing }: { syncing: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  // The rest of the dashboard opts out of motion via CSS, which cannot reach a <video>.
  // Park on the hold frame — NOT the end, which is smoke and would show an empty box.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    video.loop = false; // otherwise it restarts the moment anything resumes it
    video.pause();
    const settle = () => {
      video.currentTime = HOLD_FRAME;
    };
    if (video.readyState >= 1) settle();
    else video.addEventListener('loadedmetadata', settle, { once: true });
  }, []);

  // Restart the reveal whenever a sync starts — the mark is the refresh button, so this is
  // also the only feedback that a click did anything.
  useEffect(() => {
    const video = ref.current;
    if (!video || !syncing) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    video.currentTime = 0;
    void video.play().catch(() => {
      /* autoplay policy — the frame on screen is still a valid one */
    });
  }, [syncing]);

  return (
    <span className={cn('relative block shrink-0 overflow-hidden', BOX_CLASS)}>
      <video
        ref={ref}
        src={logoVideo}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden
        className="absolute max-w-none"
        style={{
          width: `${videoWidthPct}%`,
          left: `${leftPct}%`,
          top: `${topPct}%`,
          mixBlendMode: 'screen',
        }}
      />
    </span>
  );
}
