/* 방(Room) 시뮬레이션 — 서버(멀티)·클라(솔로 봇전) 공용 ESM.
   물리·충돌 규칙은 전부 engine.js에서 import (클라 예측과 동일 코드).
   전송 계층 없음: player.ws는 서버가 넣어두는 불투명 핸들일 뿐 여기선 안 씀. */
import {
  CFG, TAU, rand, randInt, clamp, distPointSeg,
  JellyBody, botSteer, headHitsNet, headsClash, NAMES,
} from "./engine.js";

export const MAX_HUMANS = 8;
export const botTarget = (humans) => clamp(14 - humans, 6, 14);  // 사람이 적을수록 봇으로 채움

let nextId = 1;

export class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();   // playerId -> {id, ws, body, input:{seq,steer,boost}, lastSeq}
    this.bots = [];
    this.decor = this._initDecor();
    this.pendingEvents = [];
    this.rosterDirty = true;
    this.emptySince = Date.now();
  }

  // 물고기·불가사리 — 질량 성장에 관여하므로 방 권위 (원본 initDecor에서 이동)
  _initDecor() {
    const fish = [], stars = [];
    for (let i = 0; i < 40; i++) fish.push({
      id: "f" + i, x: rand(0, CFG.WORLD_W), y: rand(0, CFG.WORLD_H),
      s: rand(5, 13), hue: rand(20, 55), dir: rand(0, TAU), spd: rand(0.4, 1.1) });
    for (let i = 0; i < 24; i++) stars.push({
      id: "s" + i, x: rand(0, CFG.WORLD_W), y: rand(0, CFG.WORLD_H),
      s: rand(10, 22), rot: rand(0, TAU), hue: rand(15, 45) });
    return { fish, stars };
  }

  aliveBodies() {
    const out = [];
    for (const p of this.players.values()) if (p.body && p.body.alive) out.push(p.body);
    for (const b of this.bots) if (b.alive) out.push(b);
    return out;
  }

  // 살아있는 사람 플레이어들에게서 먼 지점 (스폰·먹이 리스폰용)
  _farPoint(minDist) {
    const min = minDist || 520;
    let x, y, t = 0, ok;
    do {
      x = rand(100, CFG.WORLD_W - 100); y = rand(100, CFG.WORLD_H - 100); t++;
      ok = true;
      for (const p of this.players.values()) {
        if (p.body && p.body.alive && Math.hypot(x - p.body.x, y - p.body.y) < min) { ok = false; break; }
      }
    } while (!ok && t < 20);
    return { x, y };
  }

  _newPlayerBody(id, name, hue) {
    const pt = this._farPoint(600);
    return new JellyBody({ id, x: pt.x, y: pt.y, mass: CFG.PLAYER_START_MASS,
                           hue, isPlayer: true, name });
  }

  addPlayer(ws, nick) {
    if (this.players.size >= MAX_HUMANS) return null;
    const id = nextId++;
    const body = this._newPlayerBody(id, nick, rand(0, 360));
    const player = { id, ws, body, input: { seq: 0, steer: null, boost: false }, lastSeq: 0 };
    this.players.set(id, player);
    this.rosterDirty = true;
    return player;
  }

  respawnPlayer(player) {
    player.body = this._newPlayerBody(player.id, player.body.name, player.body.hue);
    player.input = { seq: player.input.seq, steer: null, boost: false };
    this.rosterDirty = true;
  }

  removePlayer(id) {
    if (this.players.delete(id)) {
      this.rosterDirty = true;
      if (this.players.size === 0) this.emptySince = Date.now();
    }
  }

  _spawnBot() {
    const pt = this._farPoint(600);
    // 크기 분포: 작은 다수, 큰 소수 (원본 spawnBot)
    const rr = Math.random();
    const mass = rr < 0.6 ? rand(CFG.BOT_MIN_MASS, 110)
               : rr < 0.9 ? rand(110, 260)
               : rand(260, CFG.BOT_MAX_MASS);
    return new JellyBody({ id: nextId++, x: pt.x, y: pt.y, mass,
                           hue: rand(0, 360), name: NAMES[randInt(0, NAMES.length - 1)] });
  }

  _kill(victim, killer, reason) {
    if (!victim.alive) return;
    victim.alive = false;
    const h = victim.head();
    this.pendingEvents.push({
      type: "event", kind: "death", subject: victim.id,
      killer: killer ? killer.id : null, killerName: killer ? killer.name : null,
      reason, x: +h.x.toFixed(1), y: +h.y.toFixed(1), mass: Math.floor(victim.mass),
    });
    this.rosterDirty = true;
  }

  // 1스텝 = 1/60초. 원본 update()의 시뮬레이션 부분을 그대로 이식.
  tick() {
    // 봇 보충 (초과분은 자연 감소에 맡김)
    const target = botTarget(this.players.size);
    while (this.bots.length < target) { this.bots.push(this._spawnBot()); this.rosterDirty = true; }

    const bodies = this.aliveBodies();

    // ── 조향 + 이동 ──
    for (const p of this.players.values()) {
      if (!p.body || !p.body.alive) continue;
      p.body.updateBoost(p.input.boost);
      const steer = Number.isFinite(p.input.steer) ? p.input.steer : p.body.heading;
      p.body.update(steer);
      p.lastSeq = p.input.seq;
    }
    for (const b of this.bots) {
      if (!b.alive) continue;
      b.update(botSteer(b, bodies, this.decor));
    }

    // ── 충돌 ① 머리 정면 충돌 → '작은' 쪽 승리, 동급이면 둘 다 사망 ──
    for (let i = 0; i < bodies.length; i++) {
      const A = bodies[i]; if (!A.alive) continue;
      for (let k = i + 1; k < bodies.length; k++) {
        const B = bodies[k]; if (!B.alive) continue;
        if (!headsClash(A, B)) continue;
        const diff = (A.mass - B.mass) / Math.max(A.mass, B.mass);
        if (Math.abs(diff) <= CFG.HEADHIT_TIE) {   // 무승부 → 둘 다 사망
          this._kill(A, B, "head"); this._kill(B, A, "head"); break;
        }
        const win = A.mass < B.mass ? A : B, lose = win === A ? B : A;
        win.mass += lose.mass * CFG.ABSORB;
        this._kill(lose, win, "head");
        if (lose === A) break;
      }
    }

    // ── 충돌 ② 그물 킬: A의 머리가 B의 그물에 닿으면 A 사망·B 흡수 ──
    for (const A of bodies) {
      if (!A.alive) continue;
      for (const B of bodies) {
        if (B === A || !B.alive) continue;
        if (Math.hypot(A.x - B.x, A.y - B.y) > B.r * (CFG.NET_LEN_K + 2) + A.r + 40) continue;
        if (headHitsNet(A, B)) {
          B.mass += A.mass * CFG.ABSORB;
          this._kill(A, B, "net");
          break;
        }
      }
    }

    // 죽은 봇 제거
    const nb = this.bots.filter(b => b.alive);
    if (nb.length !== this.bots.length) this.bots = nb;

    // ── 물고기·불가사리 흡수 (사람 플레이어만 — 원본과 동일) ──
    for (const p of this.players.values()) {
      const body = p.body;
      if (!body || !body.alive) continue;
      const seg = body.netSeg();
      for (const f of this.decor.fish) {
        if (distPointSeg(f.x, f.y, seg.ax, seg.ay, seg.ex, seg.ey) <= seg.w) {
          body.mass += CFG.FISH_GAIN;
          this.pendingEvents.push({ type: "event", kind: "eat", food: "fish",
                                    x: +f.x.toFixed(1), y: +f.y.toFixed(1) });
          const pt = this._farPoint(); f.x = pt.x; f.y = pt.y;
        }
      }
      for (const s of this.decor.stars) {
        if (distPointSeg(s.x, s.y, seg.ax, seg.ay, seg.ex, seg.ey) <= seg.w) {
          body.mass += CFG.STAR_GAIN;
          this.pendingEvents.push({ type: "event", kind: "eat", food: "star",
                                    x: +s.x.toFixed(1), y: +s.y.toFixed(1) });
          const pt = this._farPoint(); s.x = pt.x; s.y = pt.y;
        }
      }
    }

    // ── 물고기 이동 (원본 updateDecor) ──
    for (const f of this.decor.fish) {
      f.x += Math.cos(f.dir) * f.spd; f.y += Math.sin(f.dir) * f.spd;
      if (Math.random() < 0.01) f.dir += rand(-0.6, 0.6);
      f.x = (f.x + CFG.WORLD_W) % CFG.WORLD_W; f.y = (f.y + CFG.WORLD_H) % CFG.WORLD_H;
    }
  }

  rosterMsg() {
    const entities = this.aliveBodies().map(b =>
      ({ id: b.id, name: b.name, hue: Math.round(b.hue), isBot: !b.isPlayer }));
    return { type: "roster", entities };
  }

  decorRosterMsg() {
    return {
      type: "decorRoster",
      fish: this.decor.fish.map(f => ({ id: f.id, s: +f.s.toFixed(1), hue: Math.round(f.hue) })),
      stars: this.decor.stars.map(s => ({ id: s.id, s: +s.s.toFixed(1), rot: +s.rot.toFixed(2), hue: Math.round(s.hue) })),
    };
  }

  buildSnapshot() {
    return {
      type: "snapshot", t: Date.now(),
      others: this.aliveBodies().map(b => ({
        id: b.id, x: +b.x.toFixed(1), y: +b.y.toFixed(1),
        heading: +b.heading.toFixed(3), mass: Math.round(b.mass), boosting: b.boosting })),
      fish: this.decor.fish.map(f => ({ id: f.id, x: +f.x.toFixed(1), y: +f.y.toFixed(1) })),
      stars: this.decor.stars.map(s => ({ id: s.id, x: +s.x.toFixed(1), y: +s.y.toFixed(1) })),
    };
  }
}

// 클라 재조정(reconciliation)용 본인 상태 — 풀 정밀도
export function youState(player) {
  const b = player.body;
  if (!b || !b.alive) return null;
  return { x: b.x, y: b.y, heading: b.heading, mass: b.mass,
           boostGauge: b.boostGauge, boosting: b.boosting, pulse: b.pulse,
           lastSeq: player.lastSeq };
}

// 접속/부활 직후 초기 상태
export function bodyState(b) {
  return { x: b.x, y: b.y, heading: b.heading, mass: b.mass,
           boostGauge: b.boostGauge, pulse: b.pulse, hue: b.hue, name: b.name };
}
