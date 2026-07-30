import { DeliveryScript, ShotResult } from '../types';

/**
 * Scripted virtual-coach rules engine. Fully deterministic — no AI required.
 *
 * Tips are derived from the delivery's physics params (see DeliveryScript):
 *   dip   -> length: closer to 0 = fuller (yorker ~ -0.85, good length ~ -2.0)
 *   line  -> release line: + leg side / - off side (for a right-hander)
 *   swing -> in-air drift: + tails in (inswing), - moves away
 *   spin  -> spin[2] grips off the pitch: + rips toward off (leg break),
 *            - turns toward leg (doosra/off break); spin[0] ~ backspin (slower ball)
 * plus the recorded shot outcome and where the ball met the bat (contactZ).
 */

export interface CoachingInput {
  delivery: DeliveryScript;
  result: ShotResult;
  speed: number; // shot speed km/h (0 when beaten/bowled)
  distance: number; // meters
  contactZ?: number; // pitch-axis contact point; lower = met further in front
}

const isFull = (d: DeliveryScript) => d.dip >= -1.0;
const isLegBreak = (d: DeliveryScript) => d.spin[2] >= 10;
const isDoosra = (d: DeliveryScript) => d.spin[2] <= -10;
const isInswing = (d: DeliveryScript) => d.swing >= 0.5;
const isAwaySwing = (d: DeliveryScript) => d.swing <= -0.5;
const isExpress = (d: DeliveryScript) => d.speedKmh >= 150;
const isSlowerBall = (d: DeliveryScript) => Math.abs(d.spin[0]) >= 10 && isFull(d);

/** Outcome-first tip: what just happened, and the single biggest fix. */
const primaryTip = (result: ShotResult, d: DeliveryScript): string => {
  switch (result) {
    case ShotResult.OUT:
      if (isDoosra(d))
        return 'The doosra spins back INTO the right-hander, not away — you played for the off-break. Pick the wrist at release, or cover the stumps and play inside the line.';
      if (isLegBreak(d))
        return 'Big leg-break: it drifted toward leg, then ripped across to off. Play with the spin toward mid-wicket — never across the line against it.';
      if (isInswing(d) && isFull(d))
        return 'Late inswing on a yorker length: watch the wrist at release, get the front pad out of the way, and jam down with a straight bat — never around the pad.';
      if (isInswing(d))
        return 'Late inswing: play with a straight bat and keep the front pad out of the firing line.';
      if (isExpress(d))
        return `${d.speedKmh} kph gives you about 0.4 seconds. Shorten the backlift, watch the ball in the hand, and just present the full face.`;
      if (isSlowerBall(d))
        return 'The slower ball: same action, less pace. You were through the shot early — hold your shape and let the ball arrive.';
      if (isFull(d))
        return 'Yorker-length: get the bat down quickly with a straight face, right under your toes.';
      return 'Bowled — keep your head over the ball and the bat coming down straight.';

    case ShotResult.MISS:
      if (isDoosra(d))
        return "Beaten by the doosra — it spins in, not away. If you can't read the wrist, cover the stumps and play inside the line.";
      if (isLegBreak(d))
        return 'Beaten by the rip of the leg-break — watch it out of the hand and play with the spin, not against it.';
      if (isSlowerBall(d))
        return 'Slower ball — you swung before it arrived. Wait for it: hands back, weight still, let it come.';
      if (isAwaySwing(d))
        return 'Away movement — resist the reach. Play late, under your eyes, or let it go.';
      if (isInswing(d))
        return 'Beaten by inswing — the front pad went across; get it out of the way and bring the bat down straight.';
      if (isExpress(d))
        return "At this pace you can't react — pre-empt: short backlift, still head, full face.";
      return 'Beaten — watch the ball from the hand, not off the pitch.';

    case ShotResult.DEFENSE:
      if (isSlowerBall(d))
        return 'Well dug out. On the slower ball, wait for it and you can work it square for runs instead of just surviving.';
      if (isExpress(d))
        return "Solid against serious pace — soft hands, straight bat. That's the template: let the ball come to you.";
      if (isFull(d))
        return 'Good dig on a full ball. If it lands just short of yorker, you can drive it: head over the ball, full face.';
      if (isLegBreak(d) || isDoosra(d))
        return 'Watchful against the turn. When the line drifts to leg, work it with the angle — the runs are there without the risk.';
      return 'Solid defence. Head still, bat straight — the base of every innings.';

    case ShotResult.FOUR:
    case ShotResult.SIX: {
      const boundary = result === ShotResult.SIX ? 'all the way' : 'to the rope';
      if (isLegBreak(d))
        return `Crunched ${boundary}! Against a big leg-break, scoring with the spin to the leg side stays low-risk — across the line to off is how Gatting fell.`;
      if (isExpress(d))
        return `Standing up to ${d.speedKmh} kph and scoring — serious courage. Keep that backlift short and it stays repeatable.`;
      if (isFull(d))
        return "Great hands on a full ball — that's the punishment for missing the yorker by an inch.";
      return `Crunched ${boundary} — that's how you answer a famous delivery.`;
    }

    default:
      return 'Watch the ball from the hand and play it late.';
  }
};

/** Timing proxy from the recorded contact point (only when the bat made contact). */
const timingTip = (input: CoachingInput): string | null => {
  if (input.contactZ === undefined) return null;
  if (input.contactZ > 2.2)
    return 'You met that late, right on top of the stumps — get into position earlier and give yourself room.';
  if (input.contactZ < 1.2) return 'Met it well out in front — top timing and full extension.';
  return 'Met it under your eyes — good position.';
};

/** Delivery-attribute nugget: the "tell" to watch for on this ball. */
export const getWatchOutHint = (d: DeliveryScript): string => {
  if (isDoosra(d))
    return 'Same loop and action as his off-break — the only tell is the back of the hand facing you at release.';
  if (isLegBreak(d))
    return "Watch for the drift toward leg in the air — that's the cue the big rip back to off is coming.";
  if (isInswing(d) && isFull(d))
    return "The seam stays angled to fine leg with the shiny side outside — that's what makes it tail in late onto the toes.";
  if (isInswing(d))
    return 'Watch the wrist at release — if it stays behind the ball, expect it to tail in late.';
  if (isSlowerBall(d))
    return 'Identical arm speed — the only tell is the ball rolling off the fingers with backspin. Wait for it.';
  if (isExpress(d))
    return 'Pace comes off a braced front leg — your answer: short backlift, still head, full face.';
  if (isFull(d)) return 'Full length, homing onto the toes — get the bat down early.';
  return 'Watch the hand at release and play it as late as you can.';
};

/**
 * Build 1-3 coaching tips for a completed delivery:
 * outcome-first fix, then contact timing, then the delivery's tell.
 */
export const getCoachingTips = (input: CoachingInput): string[] => {
  const tips: string[] = [];
  const push = (tip: string | null) => {
    if (tip && tips.length < 3) tips.push(tip);
  };

  push(primaryTip(input.result, input.delivery));
  if (input.result !== ShotResult.OUT && input.result !== ShotResult.MISS) {
    push(timingTip(input));
  }
  push(getWatchOutHint(input.delivery));
  return tips;
};
