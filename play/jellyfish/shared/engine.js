/* ════════════════════════════════════════════════════════════════
   흐느적 해파리 — 물리 엔진 단일 소스 (서버·클라이언트 공용 ESM)
   흐느적.html에서 그대로 추출. 값·수식 변경 금지 — 손맛 보존.
   ════════════════════════════════════════════════════════════════ */

// ───────────── 설정 ─────────────
export const CFG = {
  WORLD_W: 3600, WORLD_H: 2700,
  BOT_COUNT: 28,
  PLAYER_START_MASS: 80,
  BOT_MIN_MASS: 30, BOT_MAX_MASS: 420,
  // ── 봇 AI(실력) ──
  BOT_VISION: 560,          // 시야 반경
  BOT_HUNT_RANGE: 360,      // 이 거리 안의 '더 큰' 상대만 사냥(무리한 돌격 자제)
  BOT_INERTIA: 0.72,        // 현재 진행방향 유지 가중치(클수록 덜 휙휙·덜 자멸)
  BOT_NET_FEAR: 32, BOT_NET_W: 2.8,   // 남의 그물 회피 거리·가중치(머리 박으면 죽음)
  BOT_HEAD_FEAR: 48, BOT_HEAD_W: 1.8, // 정면 충돌서 질 상대(나보다 작거나 비슷) 머리 회피
  BOT_HUNT_W: 1.35,         // 정면 충돌서 이길 상대(나보다 큰) 머리로 돌격
  BOT_FOOD_W: 0.5,          // 먹이(물고기·불가사리) 끌림
  BOT_SIZE_MARGIN: 0.15,    // 크기 우열 판단 여유(±15%) — 비슷하면 서로 회피(무승부 자멸 방지)
  R_SCALE: 4.2,             // r = sqrt(mass/PI) * R_SCALE (머리·꼬리 모두 질량 따라 성장)
  BASE_SPEED: 3.9,          // 기준 질량에서의 속도(px/frame)
  BASE_MASS_REF: 80,        // 속도 계산 기준 질량
  SPEED_FALLOFF: 0.24,      // 클수록 속도 감소 지수(작을수록 커져도 덜 느려짐)
  MIN_SPEED: 1.9, MAX_SPEED: 5.6,
  BASE_TURN: 0.082,         // rad/frame at ref mass
  TURN_FALLOFF: 0.34,
  MIN_TURN: 0.018,          // 커진 해파리도 어느 정도 조향 가능하도록 하한 ↑
  NET_LEN_K: 2.6,           // netLen = r * K
  NET_WIDTH_K: 1.1,         // netWidth = r * K
  NET_START_K: 0.9,         // 그물 시작점(몸통 뒤쪽으로 r*K). 몸통 옆구리 오판정 방지
  NET_BEHIND_K: 0.45,       // 머리가 이만큼(r*K) 뒤에 있어야 '그물에 닿음' 인정
  ABSORB: 0.72,             // 먹은 해파리 질량 흡수율(잡아먹으면 크기 성장)
  HEADHIT_TIE: 0.04,        // 머리 정면 충돌 시 질량차가 이 비율 이내면 둘 다 사망(무승부)
  HEAD_HIT_K: 0.55,         // 머리 정면 충돌 판정 거리 = (rA+rB)*K (머리 끝점 기준)
  FISH_GAIN: 1.0,           // 물고기 1마리 흡수 시 질량 증가(아주 조금)
  STAR_GAIN: 1.6,           // 불가사리 1마리 흡수 시 질량 증가
  TAIL_SEGMENTS: 7,
  // 꼬리 가닥 수 = floor(mass / STRAND_STEP) + STRAND_BASE  (100→5, 150→6, 200→7 …)
  STRAND_STEP: 50, STRAND_BASE: 3, STRAND_MIN: 4, STRAND_MAX: 14,
  // ── 부스터(게이지식 순수 속도 대시, 공격 수단 아님) ──
  BOOST_MULT: 1.95,         // 부스트 중 속도 배수
  BOOST_DRAIN_RATE: 0.014,  // 부스트 중 게이지 소모/프레임 (≈1.2초 지속)
  BOOST_RECHARGE_RATE: 0.0042, // 비사용 시 게이지 충전/프레임 (≈4초 만충)
  // ── 줌(Cmd +/-) ──
  ZOOM_MIN: 0.35, ZOOM_MAX: 1.8, ZOOM_STEP: 1.18,
};

// ───────────── 유틸 ─────────────
export const TAU = Math.PI * 2;
export const rand = (a, b) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export function angLerp(a, b, t) {            // 각도 보간(최단경로)
  let d = ((b - a + Math.PI) % TAU) - Math.PI;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}
export function turnToward(cur, target, maxStep) {
  let d = ((target - cur + Math.PI) % TAU) - Math.PI;
  if (d < -Math.PI) d += TAU;
  d = clamp(d, -maxStep, maxStep);
  return cur + d;
}
// 점 P에서 선분 AB까지의 최단거리
export function distPointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-6;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
// 점 P에서 선분 AB 위 최근접점
export function closestPtSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-6;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  return { x: ax + t * dx, y: ay + t * dy };
}
export const massToR = (m) => Math.sqrt(m / Math.PI) * CFG.R_SCALE;

export const NAMES = ["말랑이","뽀글이","흐느","유령","파도","민트","둥실","해초","물방울","산호",
  "윤슬","해무","조류","청록","거품이","나풀","연잎","해류","뭉게","랑랑","깊은바다","바람결",
  "은빛","물비늘","느릿","소용돌이","미역","톡톡","몽글","해님"];

// ───────────── JellyBody: 순수 시뮬레이션 몸체 (렌더링 없음) ─────────────
// 원본 Jellyfish에서 물리 상태·로직만 추출. 꼬리(strands)·펄스 시각효과는 클라 전용.
// 주의: update()는 "1호출 = 1/60초"로 보정되어 있음 — 반드시 60Hz 고정 스텝으로 호출.
export class JellyBody {
  constructor(opts) {
    this.id = opts.id;
    this.x = opts.x; this.y = opts.y;
    this.mass = opts.mass;
    this.heading = opts.heading !== undefined ? opts.heading : rand(0, TAU);
    this.targetHeading = this.heading;
    this.hue = opts.hue;
    this.isPlayer = !!opts.isPlayer;
    this.name = opts.name || "봇";
    this.alive = true;
    this.pulse = opts.pulse !== undefined ? opts.pulse : rand(0, TAU); // bell 수축 위상(속도 출렁임에 관여 → 물리의 일부)
    this.wanderT = rand(0, TAU);
    this.boostMult = 1;              // 부스트 속도 배수(1 = 평상시)
    this.boosting = false;
    this.boostGauge = opts.boostGauge !== undefined ? opts.boostGauge : 1;
    this.spawnGuard = opts.spawnGuard !== undefined ? opts.spawnGuard : 70; // 스폰 직후 충돌 무적(프레임)
  }
  get r() { return massToR(this.mass); }
  get speed() {
    return clamp(CFG.BASE_SPEED * Math.pow(CFG.BASE_MASS_REF / this.mass, CFG.SPEED_FALLOFF),
                 CFG.MIN_SPEED, CFG.MAX_SPEED);
  }
  get turnRate() {
    return Math.max(CFG.MIN_TURN,
      CFG.BASE_TURN * Math.pow(CFG.BASE_MASS_REF / this.mass, CFG.TURN_FALLOFF));
  }
  // 머리 끝점(진행 방향)
  head() {
    const r = this.r;
    return { x: this.x + Math.cos(this.heading) * r, y: this.y + Math.sin(this.heading) * r };
  }
  // 그물 캡슐 세그먼트(몸통 뒤쪽)
  netSeg() {
    const r = this.r;
    const bx = -Math.cos(this.heading), by = -Math.sin(this.heading); // 뒤 방향
    const ax = this.x + bx * r * CFG.NET_START_K, ay = this.y + by * r * CFG.NET_START_K;
    const ex = this.x + bx * (r + r * CFG.NET_LEN_K);
    const ey = this.y + by * (r + r * CFG.NET_LEN_K);
    return { ax, ay, ex, ey, w: r * CFG.NET_WIDTH_K };
  }
  // 부스트 게이지: 가득 차야 발동, 사용 중 소모, 미사용 시 충전 (원본 메인루프에서 이동)
  updateBoost(wantHeld) {
    const want = !!wantHeld && (this.boosting ? this.boostGauge > 0 : this.boostGauge >= 1);
    this.boosting = want;
    if (want) {
      this.boostMult = CFG.BOOST_MULT;
      this.boostGauge = Math.max(0, this.boostGauge - CFG.BOOST_DRAIN_RATE);
    } else {
      this.boostMult = 1;
      this.boostGauge = Math.min(1, this.boostGauge + CFG.BOOST_RECHARGE_RATE);
    }
  }
  // 1스텝(=1/60초) 전진
  update(steerAngle) {
    this.spawnGuard = Math.max(0, this.spawnGuard - 1);
    this.targetHeading = steerAngle;
    this.heading = turnToward(this.heading, this.targetHeading, this.turnRate);
    // 펄스 전진(흐느적): 속도가 수축 주기에 따라 출렁임
    this.pulse += 0.10 + 0.02 * Math.min(1, 80 / this.mass);
    const pulseBoost = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.pulse));
    const v = this.speed * pulseBoost * this.boostMult;
    this.x += Math.cos(this.heading) * v;
    this.y += Math.sin(this.heading) * v;
    // 월드 경계(부드럽게 튕김)
    const r = this.r;
    if (this.x < r) { this.x = r; this.heading = Math.PI - this.heading; }
    if (this.x > CFG.WORLD_W - r) { this.x = CFG.WORLD_W - r; this.heading = Math.PI - this.heading; }
    if (this.y < r) { this.y = r; this.heading = -this.heading; }
    if (this.y > CFG.WORLD_H - r) { this.y = CFG.WORLD_H - r; this.heading = -this.heading; }
  }
}

// ───────────── 봇 AI ─────────────
// 가중 조향: 남의 그물 회피 + (나보다 큰 상대) 머리로 돌격(정면충돌=작은쪽 승) +
//            (작거나 비슷한 상대) 머리 회피 + 먹이 끌림. 현재 방향 관성으로 부드럽게.
// decorFood = { fish: [{x,y}...], stars: [{x,y}...] } — 방(서버)별 소유라 인자로 받음.
export function botSteer(bot, jellies, decorFood) {
  const R = CFG.BOT_VISION, m = CFG.BOT_SIZE_MARGIN;
  let ax = 0, ay = 0;                 // 누적 조향 urge
  let target = null, targetD = Infinity;

  for (const o of jellies) {
    if (o === bot || !o.alive) continue;
    const dx = o.x - bot.x, dy = o.y - bot.y;
    const d = Math.hypot(dx, dy);
    if (d > R) continue;

    // 1) 상대 그물(꼬리) 회피 — 머리가 닿으면 즉사
    const seg = o.netSeg();
    const cp = closestPtSeg(bot.x, bot.y, seg.ax, seg.ay, seg.ex, seg.ey);
    const ndx = bot.x - cp.x, ndy = bot.y - cp.y, nd = Math.hypot(ndx, ndy) || 1;
    const netDanger = seg.w + bot.r + CFG.BOT_NET_FEAR;
    if (nd < netDanger) {
      const w = (netDanger - nd) / netDanger;
      ax += (ndx / nd) * w * CFG.BOT_NET_W;
      ay += (ndy / nd) * w * CFG.BOT_NET_W;
    }

    // 2) 머리 정면 충돌 우열
    if (o.mass > bot.mass * (1 + m) && d < CFG.BOT_HUNT_RANGE) {
      // 상대가 충분히 크고 가까움 → 정면충돌서 이김 → 사냥감(가장 가까운 상대의 머리)
      if (d < targetD) { targetD = d; target = o; }
    } else {
      // 상대가 작거나 비슷 → 정면충돌서 지거나 무승부 → 상대 머리 회피
      const hx = o.x + Math.cos(o.heading) * o.r, hy = o.y + Math.sin(o.heading) * o.r;
      const hdx = bot.x - hx, hdy = bot.y - hy, hd = Math.hypot(hdx, hdy) || 1;
      const headFear = o.r + bot.r + CFG.BOT_HEAD_FEAR;
      if (hd < headFear) {
        const w = (headFear - hd) / headFear;
        ax += (hdx / hd) * w * CFG.BOT_HEAD_W;
        ay += (hdy / hd) * w * CFG.BOT_HEAD_W;
      }
    }
  }

  if (target) {
    // 사냥: 더 큰 상대의 '머리 끝점'을 노려 정면 충돌(꼬리는 회피 urge가 막아줌)
    const hx = target.x + Math.cos(target.heading) * target.r;
    const hy = target.y + Math.sin(target.heading) * target.r;
    const tx = hx - bot.x, ty = hy - bot.y, td = Math.hypot(tx, ty) || 1;
    ax += (tx / td) * CFG.BOT_HUNT_W;
    ay += (ty / td) * CFG.BOT_HUNT_W;
  } else {
    // 먹이(물고기·불가사리) 가까우면 약하게 끌림
    let food = null, fd = R;
    for (const f of decorFood.fish) { const dd = Math.hypot(f.x - bot.x, f.y - bot.y); if (dd < fd) { fd = dd; food = f; } }
    for (const s of decorFood.stars) { const dd = Math.hypot(s.x - bot.x, s.y - bot.y); if (dd < fd) { fd = dd; food = s; } }
    if (food) {
      const tx = food.x - bot.x, ty = food.y - bot.y, td = Math.hypot(tx, ty) || 1;
      ax += (tx / td) * CFG.BOT_FOOD_W; ay += (ty / td) * CFG.BOT_FOOD_W;
    }
    // 배회 + 중앙 끌림(벽 박힘 방지)
    bot.wanderT += rand(-0.1, 0.1);
    ax += Math.cos(bot.heading + bot.wanderT * 0.5) * 0.35;
    ay += Math.sin(bot.heading + bot.wanderT * 0.5) * 0.35;
    const toCx = CFG.WORLD_W / 2 - bot.x, toCy = CFG.WORLD_H / 2 - bot.y, cd = Math.hypot(toCx, toCy) || 1;
    ax += (toCx / cd) * 0.1; ay += (toCy / cd) * 0.1;
  }

  // 관성 + urge 합성
  const fx = Math.cos(bot.heading) * CFG.BOT_INERTIA + ax;
  const fy = Math.sin(bot.heading) * CFG.BOT_INERTIA + ay;
  return (fx === 0 && fy === 0) ? bot.heading : Math.atan2(fy, fx);
}

// ───────────── 충돌 ─────────────
// attacker의 '머리'가 owner의 '그물(꼬리)'에 닿는가? (닿으면 attacker가 죽고 owner가 흡수)
// 규칙: 크기·몸통 조건 없이, 머리가 남의 꼬리에 닿으면 사망.
export function headHitsNet(attacker, owner) {
  if (attacker.spawnGuard > 0 || owner.spawnGuard > 0) return false;
  const h = attacker.head();
  // 머리가 owner의 '뒤쪽'(꼬리 방향)에 충분히 있어야 함 — 옆구리/정면 접촉은 그물 아님
  const bx = -Math.cos(owner.heading), by = -Math.sin(owner.heading);
  const behind = (h.x - owner.x) * bx + (h.y - owner.y) * by;
  if (behind < owner.r * CFG.NET_BEHIND_K) return false;
  const seg = owner.netSeg();
  return distPointSeg(h.x, h.y, seg.ax, seg.ay, seg.ex, seg.ey) <= seg.w;
}

// 두 해파리의 '머리 끝점'이 정면으로 부딪혔는가? (뒤에서 쫓는 경우는 머리끼리 멀어 자연 제외)
export function headsClash(a, b) {
  if (a.spawnGuard > 0 || b.spawnGuard > 0) return false;
  const ha = a.head(), hb = b.head();
  return Math.hypot(ha.x - hb.x, ha.y - hb.y) < (a.r + b.r) * CFG.HEAD_HIT_K;
}
