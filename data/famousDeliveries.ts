import { DeliveryScript } from '../types';

/**
 * Five scripted "famous deliveries" — a data-driven replacement for random bowling.
 * Params feed the cannon physics body (see DeliveryScript in types.ts):
 *   pace -> +z release speed, line -> +x release speed (+ = leg side, - = off side),
 *   dip  -> -y release speed (yorkers ~ -0.85, good length ~ -2.0),
 *   swing -> lateral drift while airborne (m/s^2),
 *   spin -> angular velocity; z-axis spin grips the pitch: + rips toward off, - toward leg.
 * Values are tuned for drama, not Hawk-Eye fidelity.
 */
export const FAMOUS_DELIVERIES: DeliveryScript[] = [
  {
    id: 'warne-1993',
    name: 'Ball of the Century',
    bowler: 'Shane Warne',
    year: 1993,
    styleTag: 'Leg Break',
    description: 'Drifts in toward leg stump, then rips across to hit off. Gatting never stood a chance.',
    educational:
      "Old Trafford, 1993 Ashes — Warne's very first ball in Ashes cricket, to Mike Gatting. It drifted in toward leg stump, dipped, then ripped back across the right-hander to clip the top of off; Gatting barely moved. The physics: a hard wrist-flick off the third finger piles revolutions onto the ball, so the Magnus effect drags it across in the air before the seam grips and turns it even further off the pitch.",
    speedKmh: 82,
    pace: 15,
    line: 0.55,
    dip: -1.6,
    swing: 1.1,
    spin: [4, 2, 24],
  },
  {
    id: 'wasim-1992',
    name: 'The Sultan of Swing',
    bowler: 'Wasim Akram',
    year: 1992,
    styleTag: 'Inswinging Yorker',
    description: 'Tails in late at 145kph, zero room to breathe. World Cup final stuff.',
    educational:
      '1992 World Cup final, MCG — Wasim Akram to Allan Lamb: an inswinging yorker that tailed in late and shattered the stumps. With the seam angled to fine leg and the shiny side kept outside, the ball hovers in toward the toes — and at 145kph the batter has under half a second to react. The wrist stays cocked behind the ball until the last instant, which is why the swing starts so late and is nearly unplayable.',
    speedKmh: 145,
    pace: 24,
    line: -0.5,
    dip: -0.85,
    swing: 1.6,
    spin: [0, 3, 4],
  },
  {
    id: 'lee-2002',
    name: 'The Thunderbolt',
    bowler: 'Brett Lee',
    year: 2002,
    styleTag: 'Raw Pace',
    description: '160 clicks, zero subtlety. Off stump on a string — just survive.',
    educational:
      '160.7 kph — one of the fastest deliveries ever recorded, reaching the batter in about 0.42 seconds: quicker than conscious reaction time. Lee generated it with a braced front leg that converts run-up speed into a catapult-fast arm. At this pace swing and seam become secondary — survival means a short backlift, a still head, and watching the ball in the hand.',
    speedKmh: 160.7,
    pace: 27,
    line: -0.15,
    dip: -2.0,
    swing: 0,
    spin: [2, 0, 3],
  },
  {
    id: 'murali-2004',
    name: 'The Doosra',
    bowler: 'Muttiah Muralitharan',
    year: 2004,
    styleTag: 'Off Break',
    description: 'Loops wide outside off, then spits back toward leg. Read it if you can.',
    educational:
      "Muralitharan's doosra — 'the second one' — leaves the hand looking exactly like his stock off-break: same loop, same action. But the wrist rotates the opposite way at release, so it spins INTO the right-hander like a leg-break. Bowled with a hypermobile shoulder and a twice-reported, twice-cleared elbow, it turned batting into a coin flip: guess wrong and you play inside a ball hitting off stump — or outside one pinning you in front.",
    speedKmh: 88,
    pace: 14,
    line: -0.5,
    dip: -1.5,
    swing: -0.6,
    spin: [5, -3, -26],
  },
  {
    id: 'bumrah-2019',
    name: 'The Slower-Ball Yorker',
    bowler: 'Jasprit Bumrah',
    year: 2019,
    styleTag: 'Dipping Yorker',
    description: 'Same action, 40kph less. Dips wickedly onto the toes right at the death.',
    educational:
      "Bumrah's slower-ball yorker is death-bowling gold: identical run-up and arm speed, but the ball rolls off the fingers with backspin and arrives 30-40 kph slower with no visual cue. Batters read pace from the action, not the ball, so they commit early — and the ball dips wickedly under the bat onto the toes. His stuttered, hyperextended-arm action makes the deception nearly impossible to pick.",
    speedKmh: 113,
    pace: 17,
    line: 0.15,
    dip: -0.9,
    swing: 0.3,
    spin: [14, 0, 2],
  },
];
